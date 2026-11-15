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
      if (!validSignature(req.rawBody, sig, whatsappConfig.appSecret)) return res.sendStatus(401);
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
    req.app.locals.lastJobs = Promise.all(jobs); // útil nos testes
  });

  return app;
}

async function main() {
  const missing = [
    ['WHATSAPP_TOKEN', config.whatsapp.token],
    ['WHATSAPP_PHONE_NUMBER_ID', config.whatsapp.phoneNumberId],
    ['WEBHOOK_VERIFY_TOKEN', config.whatsapp.verifyToken],
    ['GEMINI_API_KEY', config.gemini.apiKey],
    ['DATABASE_URL', config.database.url],
  ].filter(([, v]) => !v);
  if (missing.length) {
    console.error(`Faltam variáveis no .env: ${missing.map(([k]) => k).join(', ')}`);
    process.exit(1);
  }
  if (!config.whatsapp.appSecret) {
    console.warn('AVISO: META_APP_SECRET vazio — o webhook aceita pedidos sem validar a assinatura.');
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
