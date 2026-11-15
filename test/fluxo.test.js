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
    ai: createAi({ apiKey: 'k', model: 'm' }, fakeFetch, {}),
    config,
    log: { warn() {}, error() {}, info() {} },
  });
  const app = createApp({ handler, whatsappConfig: waConfig, log: { error() {}, warn() {}, info() {} } });
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

test('listar, apagar e corrigir um lançamento específico', async () => {
  const t = await setup([
    { intencao: 'registar', lancamentos: [
      { tipo: 'despesa', valor: 120, descricao: 'Mercado', categoria: 'Mercado', data: TODAY },
      { tipo: 'despesa', valor: 8.5, descricao: 'Uber', categoria: 'Transporte', data: TODAY },
      { tipo: 'despesa', valor: 12, descricao: 'Uber', categoria: 'Transporte', data: TODAY },
    ] },
    { intencao: 'listar' },
    { intencao: 'apagar', alvo: { descricao: 'ÚBER', valor: 8.5 } },
    { intencao: 'corrigir', alvo: { descricao: 'mercado', valor: null }, alteracoes: { valor: '110', categoria: null } },
    { intencao: 'apagar', alvo: { descricao: 'farmácia', valor: null } },
    { intencao: 'corrigir', alvo: { descricao: 'uber' }, alteracoes: {} },
    { intencao: 'consultar', consulta: { inicio: `${TODAY.slice(0, 8)}01`, fim: TODAY, rotulo: 'este mês' } },
  ]);
  await t.receive(t.text('mercado 120, uber 8,50, uber 12'));
  await t.receive(t.text('mostra os últimos gastos'));
  assert.match(t.sent[1], /Últimos 3 lançamentos/);
  await t.receive(t.text('apagar o uber de 8,50'));
  assert.match(t.sent[2], /Apagado:[\s\S]*Uber: 8,50/);
  assert.doesNotMatch(t.sent[2], /parecidos/);
  await t.receive(t.text('corrige o mercado para 110'));
  assert.match(t.sent[3], /Corrigido:[\s\S]*Mercado: 110,00.*\(Mercado\)/);
  await t.receive(t.text('apagar a farmácia'));
  assert.match(t.sent[4], /Não encontrei/);
  await t.receive(t.text('corrige o uber'));
  assert.match(t.sent[5], /Não percebi o que quer alterar/);
  await t.receive(t.text('quanto gastei?'));
  assert.match(t.sent[6], /Despesas: 122,00/);
  t.close();
});

test('painel: link assinado, sessão, dados só do próprio utilizador', async () => {
  const { createAuth } = await import('../src/auth.js');
  const { createPainel, buildMonthData } = await import('../src/painel.js');
  const { default: express } = await import('express');
  const { Pool } = newDb().adapters.createPg();
  const db = createDb(new Pool());
  await db.migrate();
  const a = await db.getOrCreateUser('351911111111', 'Davi', { currency: 'EUR', timezone: 'Europe/Lisbon' });
  const b = await db.getOrCreateUser('351922222222', 'Outro', { currency: 'EUR', timezone: 'Europe/Lisbon' });
  await db.addTransactions(a.id, [
    { type: 'despesa', amountCents: 12000, category: 'Mercado', description: 'Mercado', date: TODAY },
    { type: 'receita', amountCents: 90000, category: 'Trabalho', description: 'Cliente', date: TODAY },
  ], 'text', 'm1');
  await db.addTransactions(b.id, [{ type: 'despesa', amountCents: 777, category: 'Lazer', description: 'Segredo', date: TODAY }], 'text', 'm2');

  const auth = createAuth('segredo');
  const app = express();
  app.use('/painel', createPainel({ db, auth, botName: 'Teste' }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });

  // sem sessão
  assert.equal((await get('/painel/dados')).status, 401);
  assert.match(await (await get('/painel')).text(), /envie <strong>painel<\/strong>/);
  // tokens inválidos, expirados ou do tipo errado
  assert.equal((await get('/painel/entrar?t=lixo')).status, 401);
  assert.equal((await get(`/painel/entrar?t=${auth.sign(a.id, 'login', -10)}`)).status, 401);
  assert.equal((await get(`/painel/entrar?t=${auth.sign(a.id, 'sessao', 600)}`)).status, 401);
  assert.equal((await get(`/painel/entrar?t=${createAuth('outro').sign(a.id, 'login', 600)}`)).status, 401);
  // um token de login não serve de cookie
  assert.equal((await get('/painel/dados', `sessao=${auth.sign(a.id, 'login', 600)}`)).status, 401);

  // login válido
  const login = await get(`/painel/entrar?t=${auth.sign(a.id, 'login', 600)}`);
  assert.equal(login.status, 302);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax/);
  const cookie = setCookie.split(';')[0];

  const data = await (await get('/painel/dados', cookie)).json();
  assert.equal(data.totals.expenses, 12000);
  assert.equal(data.totals.income, 90000);
  assert.equal(data.months.length, 6);
  assert.equal(data.months[5].expenses, 12000);
  assert.equal(data.daily[Number(TODAY.slice(8)) - 1].cents, 12000);
  assert.ok(!JSON.stringify(data).includes('Segredo'));
  const html = await (await get('/painel', cookie)).text();
  assert.match(html, /painel\.js/);
  assert.equal((await get('/painel/static/painel.js')).status, 200);
  assert.equal((await get('/painel/dados?mes=2020-13', cookie)).status, 200); // mês inválido cai no atual

  // agregação de meses
  const agg = buildMonthData([
    { occurred_on: '2026-01-31', type: 'despesa', amount_cents: 100, category: 'A', description: 'x' },
    { occurred_on: '2025-12-05', type: 'despesa', amount_cents: 50, category: 'B', description: 'y' },
  ], '2026-01');
  assert.equal(agg.daily.length, 31);
  assert.deepEqual(agg.months.map((m) => m.month), ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
  assert.equal(agg.months[4].expenses, 50);
  server.close(); server.closeAllConnections();
});

test('"painel" no WhatsApp devolve um link pessoal válido', async () => {
  const { createAuth } = await import('../src/auth.js');
  const { Pool } = newDb().adapters.createPg();
  const db = createDb(new Pool());
  await db.migrate();
  const auth = createAuth('s');
  const sent = [];
  const handler = createHandler({
    db, auth,
    wa: { sendText: async (_to, t) => sent.push(t), markRead: async () => {} },
    ai: { interpret: async () => { throw new Error('não devia chamar a IA'); } },
    config: { botName: 'T', currency: 'EUR', timezone: 'Europe/Lisbon', allowedNumbers: [], publicUrl: 'https://exemplo.pt' },
    log: { warn() {}, error() {}, info() {} },
  });
  await handler.handle({ from: '351911111111', id: 'w1', type: 'text', text: { body: 'Painel' } }, 'Davi');
  const token = sent[0].match(/https:\/\/exemplo\.pt\/painel\/entrar\?t=(\S+)/)[1];
  const user = await db.getOrCreateUser('351911111111', 'Davi', { currency: 'EUR', timezone: 'Europe/Lisbon' });
  assert.equal(auth.verify(token, 'login'), user.id);
});
