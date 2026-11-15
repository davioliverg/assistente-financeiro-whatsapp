// Testes de ponta a ponta com a Meta e a IA simuladas (não gastam nada nem precisam de chaves).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { newDb } from 'pg-mem';
import { createAi, normalize, parseJson } from '../src/ai.js';
import { createDb } from '../src/db.js';
import { createHandler } from '../src/handler.js';
import { createApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';

const SECRET = 'segredo-app';
const ME = '351911111111';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date());

async function setup(aiAnswers) {
  const { Pool } = newDb().adapters.createPg();
  const db = createDb(new Pool());
  await db.migrate();

  const sent = [];
  const geminiRequests = [];
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (obj) => ({ ok: true, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (u.includes('generativelanguage')) {
      geminiRequests.push(JSON.parse(opts.body));
      const answer = aiAnswers.shift();
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
    }
    if (u.endsWith('/messages')) {
      const body = JSON.parse(opts.body);
      if (body.type === 'text') sent.push(body.text.body);
      return json({ messages: [{ id: 'out' }] });
    }
    if (u.includes('/MEDIA1')) {
      return json({ url: 'https://lookaside.example/file', mime_type: 'audio/ogg; codecs=opus', file_size: 4 });
    }
    if (u.startsWith('https://lookaside.example')) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
    }
    throw new Error(`fetch inesperado: ${u}`);
  };

  const waConfig = { token: 't', phoneNumberId: 'PN1', graphVersion: 'v25.0', verifyToken: 'vt', appSecret: SECRET };
  const config = { botName: 'Teste', currency: 'EUR', timezone: 'Europe/Lisbon', allowedNumbers: [ME] };
  const handler = createHandler({
    db,
    wa: createWhatsApp(waConfig, fakeFetch),
    ai: createAi({ apiKey: 'k', model: 'm' }, fakeFetch),
    config,
    log: { warn() {}, error() {} },
  });
  const app = createApp({ handler, whatsappConfig: waConfig, log: { error() {} } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  let n = 0;
  async function receive(message, { from = ME, sign = true, id } = {}) {
    const payload = JSON.stringify({
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: 'PN1' },
        contacts: [{ wa_id: from, profile: { name: 'Davi' } }],
        messages: [{ from, id: id || `wamid.${++n}`, ...message }],
      } }] }],
    });
    const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sign ? { 'x-hub-signature-256': sig } : {}) },
      body: payload,
    });
    await app.locals.lastJobs;
    return res.status;
  }
  const text = (body) => ({ type: 'text', text: { body } });
  return { db, sent, geminiRequests, receive, text, base, close: () => { server.close(); server.closeAllConnections(); } };
}

test('verificação do webhook pela Meta', async () => {
  const t = await setup([]);
  const ok = await fetch(`${t.base}/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=123`);
  assert.equal(await ok.text(), '123');
  const bad = await fetch(`${t.base}/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`);
  assert.equal(bad.status, 403);
  t.close();
});

test('rejeita webhook sem assinatura válida', async () => {
  const t = await setup([]);
  assert.equal(await t.receive(t.text('mercado 120'), { sign: false }), 401);
  assert.equal(t.sent.length, 0);
  t.close();
});

test('texto: regista, não duplica em reenvios, consulta e apaga', async () => {
  const t = await setup([
    { intencao: 'registar', lancamentos: [{ tipo: 'despesa', valor: 120, descricao: 'Mercado', categoria: 'Mercado', data: TODAY }] },
    { intencao: 'registar', lancamentos: [
      { tipo: 'despesa', valor: '8,50', descricao: 'Uber', categoria: 'Transporte', data: TODAY },
      { tipo: 'receita', valor: 900, descricao: 'Cliente', categoria: 'Trabalho', data: TODAY },
    ] },
    { intencao: 'consultar', consulta: { inicio: `${TODAY.slice(0, 8)}01`, fim: TODAY, rotulo: 'este mês' } },
    { intencao: 'apagar_ultimo' },
    { intencao: 'consultar', consulta: { inicio: `${TODAY.slice(0, 8)}01`, fim: TODAY, rotulo: 'este mês', tipo: 'despesa' } },
  ]);

  assert.equal(await t.receive(t.text('mercado 120'), { id: 'wamid.A' }), 200);
  assert.match(t.sent[0], /Anotado!/);
  assert.match(t.sent[0], /120,00/);

  // A Meta reenvia a mesma mensagem: não pode haver segundo registo nem segunda resposta
  await t.receive(t.text('mercado 120'), { id: 'wamid.A' });
  assert.equal(t.sent.length, 1);

  await t.receive(t.text('uber 8,50 e recebi 900 do cliente'));
  assert.match(t.sent[1], /Despesas deste mês: 128,50/);

  await t.receive(t.text('quanto gastei este mês?'));
  assert.match(t.sent[2], /Despesas: 128,50/);
  assert.match(t.sent[2], /Mercado: 120,00.*\(93%\)/);
  assert.match(t.sent[2], /Receitas: 900,00/);
  assert.match(t.sent[2], /Saldo: 771,50/);

  await t.receive(t.text('apagar último'));
  assert.match(t.sent[3], /Apagado: .*Uber.*Cliente|Apagado: .*Cliente.*Uber/);

  await t.receive(t.text('quanto gastei?'));
  assert.match(t.sent[4], /Despesas: 120,00/);
  assert.doesNotMatch(t.sent[4], /Receitas/);
  t.close();
});

test('áudio: descarrega o ficheiro e envia-o à IA', async () => {
  const t = await setup([
    { intencao: 'registar', lancamentos: [{ tipo: 'despesa', valor: 35.9, descricao: 'Gasolina', categoria: 'Transporte', data: TODAY }] },
  ]);
  await t.receive({ type: 'audio', audio: { id: 'MEDIA1', mime_type: 'audio/ogg; codecs=opus' } });
  const part = t.geminiRequests[0].contents[0].parts[0].inline_data;
  assert.equal(part.mime_type, 'audio/ogg');
  assert.equal(part.data, Buffer.from([1, 2, 3, 4]).toString('base64'));
  assert.match(t.sent[0], /Gasolina — 35,90/);
  t.close();
});

test('número não autorizado é ignorado; "ajuda" não gasta IA', async () => {
  const t = await setup([]);
  await t.receive(t.text('mercado 10'), { from: '351999999999' });
  assert.equal(t.sent.length, 0);
  await t.receive(t.text('Ajuda'));
  assert.match(t.sent[0], /assistente financeiro/);
  assert.equal(t.geminiRequests.length, 0);
  t.close();
});

test('dados de um utilizador não aparecem a outro', async () => {
  const t = await setup([]);
  const a = await t.db.getOrCreateUser('1', 'A', { currency: 'EUR', timezone: 'Europe/Lisbon' });
  const b = await t.db.getOrCreateUser('2', 'B', { currency: 'EUR', timezone: 'Europe/Lisbon' });
  await t.db.addTransactions(a.id, [{ type: 'despesa', amountCents: 500, category: 'Lazer', description: 'x', date: TODAY }], 'text', 'm1');
  assert.equal((await t.db.summary(b.id, '2000-01-01', '2999-12-31')).length, 0);
  assert.equal((await t.db.deleteLast(b.id)).length, 0);
  assert.equal((await t.db.summary(a.id, '2000-01-01', '2999-12-31'))[0].totalCents, 500);
  t.close();
});

test('normalize descarta valores inválidos e corrige campos', () => {
  const r = normalize({ intencao: 'registar', lancamentos: [
    { tipo: 'despesa', valor: -5, descricao: 'neg' },
    { tipo: 'despesa', valor: 'abc' },
    { tipo: 'xpto', valor: 10.005, descricao: 'ok', categoria: 'Inventada', data: '2026-02-31' },
  ] }, '2026-11-15');
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0], { type: 'despesa', amountCents: 1001, description: 'ok', category: 'Outros', date: '2026-11-15' });
  assert.equal(normalize({ intencao: 'registar', lancamentos: [] }, '2026-11-15').intent, 'outro');
  assert.equal(normalize(null, '2026-11-15').intent, 'outro');
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
});
