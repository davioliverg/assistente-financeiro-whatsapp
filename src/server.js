import crypto from 'node:crypto';
import express from 'express';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { createAi } from './ai.js';
import { createDb, createPool } from './db.js';
import { createHandler } from './handler.js';
import { createWhatsApp } from './whatsapp.js';

export function validSignature(rawBody, header, appSecret) {
  if (!header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createApp({ handler, whatsappConfig, log = console }) {
  const app = express();
  app.use(
    express.json({
      limit: '3mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Política de privacidade pública (a Meta exige um URL destes para publicar a app).
  app.get('/privacidade', (_req, res) => {
    const name = process.env.BOT_NAME || 'Assistente financeiro';
    const contact = process.env.CONTACT_EMAIL;
    res.type('html').send(`<!doctype html>
<html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidade — ${name}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}h1{font-size:1.6rem}h2{font-size:1.1rem;margin-top:1.6em}</style>
</head><body>
<h1>Política de Privacidade — ${name}</h1>
<p>O ${name} é um assistente financeiro pessoal que funciona por WhatsApp. Esta página explica que dados são tratados e para quê.</p>
<h2>Dados que recolhemos</h2>
<ul>
<li>O seu número de telefone e o nome do perfil do WhatsApp.</li>
<li>As mensagens que envia ao assistente (texto, áudio e imagens de recibos).</li>
<li>Os lançamentos financeiros criados a partir dessas mensagens: valor, descrição, categoria e data.</li>
</ul>
<h2>Para que são usados</h2>
<p>Apenas para registar os seus gastos e ganhos e responder às suas perguntas sobre eles. Não vendemos dados nem os usamos para publicidade. O assistente não tem acesso às suas contas bancárias.</p>
<h2>Com quem são partilhados</h2>
<ul>
<li><strong>Meta (WhatsApp Business Platform)</strong>: transporte das mensagens.</li>
<li><strong>Google (API Gemini)</strong>: interpretação do texto, áudio e imagens enviados.</li>
<li><strong>Render</strong>: alojamento do servidor e da base de dados.</li>
</ul>
<h2>Conservação</h2>
<p>Os lançamentos ficam guardados enquanto usar o serviço. Os ficheiros de áudio e imagem são processados no momento e não são guardados pelo assistente.</p>
<h2>Os seus direitos</h2>
<p>Pode pedir a consulta, correção ou eliminação dos seus dados a qualquer momento${contact ? `, escrevendo para <a href="mailto:${contact}">${contact}</a>` : ', contactando o responsável pelo serviço'}. Pode também apagar o último lançamento enviando "apagar último" ao assistente.</p>
</body></html>`);
  });

  // Verificação do webhook: a Meta chama isto uma vez quando você o configura.
  app.get('/webhook', (req, res) => {
    const ok =
      req.query['hub.mode'] === 'subscribe' &&
      whatsappConfig.verifyToken &&
      req.query['hub.verify_token'] === whatsappConfig.verifyToken;
    return ok ? res.status(200).send(req.query['hub.challenge']) : res.sendStatus(403);
  });

  // Mensagens recebidas.
  app.post('/webhook', (req, res) => {
    if (whatsappConfig.appSecret) {
      const sig = req.get('x-hub-signature-256');
      if (!validSignature(req.rawBody, sig, whatsappConfig.appSecret)) {
        log.warn('Webhook rejeitado: assinatura inválida (confirme o META_APP_SECRET).');
        return res.sendStatus(401);
      }
    }
    res.sendStatus(200); // responde já; a Meta reenvia se demorarmos

    const jobs = [];
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        // Ignora eventos de outros números ligados à mesma app
        if (
          whatsappConfig.phoneNumberId &&
          value.metadata?.phone_number_id &&
          value.metadata.phone_number_id !== whatsappConfig.phoneNumberId
        ) {
          continue;
        }
        for (const message of value.messages || []) {
          const name = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name;
          jobs.push(handler.handle(message, name).catch((e) => log.error('Falha no handler', e)));
        }
      }
    }
    log.info(`Webhook recebido: ${jobs.length} mensagem(ns).`);
    req.app.locals.lastJobs = Promise.all(jobs); // útil nos testes
  });

  return app;
}

async function main() {
  // Sem base de dados ou token de verificação o servidor não tem como funcionar.
  const required = [
    ['WEBHOOK_VERIFY_TOKEN', config.whatsapp.verifyToken],
    ['DATABASE_URL', config.database.url],
  ].filter(([, v]) => !v);
  if (required.length) {
    console.error(`Faltam variáveis de ambiente: ${required.map(([k]) => k).join(', ')}`);
    process.exit(1);
  }
  // Sem estas o servidor arranca (para a Meta poder verificar o webhook), mas não responde a mensagens.
  const pending = [
    ['WHATSAPP_TOKEN', config.whatsapp.token],
    ['WHATSAPP_PHONE_NUMBER_ID', config.whatsapp.phoneNumberId],
    ['GEMINI_API_KEY', config.gemini.apiKey],
  ].filter(([, v]) => !v);
  if (pending.length) {
    console.warn(`AVISO: faltam ${pending.map(([k]) => k).join(', ')} — o bot ainda não consegue responder.`);
  }
  if (!config.whatsapp.appSecret) {
    console.warn('AVISO: META_APP_SECRET vazio — o webhook aceita pedidos sem validar a assinatura.');
  }
  if (config.whatsapp.appSecret && !/^[0-9a-f]{32}$/i.test(config.whatsapp.appSecret)) {
    const s = config.whatsapp.appSecret;
    console.warn(
      `AVISO: META_APP_SECRET não tem o formato esperado (32 caracteres de 0-9 e a-f). ` +
        `Tem ${s.length} caracteres${/^\d+$/.test(s) ? ' e é só números: parece ser o App ID, não o App secret' : ''}.`,
    );
  }
  if (!config.allowedNumbers.length) {
    console.warn('AVISO: ALLOWED_NUMBERS vazio — qualquer pessoa pode usar o bot.');
  }

  const db = createDb(createPool(config.database));
  await db.migrate();
  const handler = createHandler({
    db,
    wa: createWhatsApp(config.whatsapp),
    ai: createAi(config.gemini),
    config,
  });
  createApp({ handler, whatsappConfig: config.whatsapp }).listen(config.port, () => {
    console.log(`${config.botName} a ouvir na porta ${config.port}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
