// Painel web: gráficos e lista de lançamentos do utilizador autenticado.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayIn } from './format.js';
import { materialize, nextDue } from './recurring.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SESSION_DAYS = 7;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function daysIn(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function buildMonthData(rows, month) {
  const sum = (list, type) => list.filter((r) => r.type === type).reduce((a, r) => a + r.amount_cents, 0);
  const inMonth = rows.filter((r) => r.occurred_on.startsWith(month));

  const byCategory = {};
  for (const r of inMonth) if (r.type === 'despesa') byCategory[r.category] = (byCategory[r.category] || 0) + r.amount_cents;

  const daily = Array.from({ length: daysIn(month) }, (_, i) => ({ day: i + 1, cents: 0 }));
  for (const r of inMonth) if (r.type === 'despesa') daily[Number(r.occurred_on.slice(8, 10)) - 1].cents += r.amount_cents;

  const months = [];
  for (let i = -5; i <= 0; i++) {
    const m = addMonths(month, i);
    const list = rows.filter((r) => r.occurred_on.startsWith(m));
    months.push({ month: m, expenses: sum(list, 'despesa'), income: sum(list, 'receita') });
  }

  return {
    month,
    totals: { expenses: sum(inMonth, 'despesa'), income: sum(inMonth, 'receita'), count: inMonth.length },
    categories: Object.entries(byCategory)
      .map(([name, cents]) => ({ name, cents }))
      .sort((a, b) => b.cents - a.cents),
    daily,
    months,
    transactions: inMonth.map((r) => ({
      date: r.occurred_on,
      description: r.description,
      category: r.category,
      type: r.type,
      cents: r.amount_cents,
      fixed: r.source === 'fixo',
    })),
  };
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const page = (title, body) => `<!doctype html>
<html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="stylesheet" href="/painel/static/painel.css">
</head><body>${body}</body></html>`;

export function createPainel({ db, auth, botName }) {
  const router = express.Router();
  const safeName = String(botName).replace(/[<>&"]/g, '');

  router.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });
  router.use('/static', express.static(PUBLIC_DIR, { index: false }));

  const session = (req) => auth.verify(readCookie(req, 'sessao'), 'sessao');

  // Link enviado pelo bot no WhatsApp: troca o token curto por uma sessão.
  router.get('/entrar', (req, res) => {
    const userId = auth.verify(req.query.t, 'login');
    if (userId === null) {
      return res.status(401).send(
        page('Link expirado', `<main class="notice"><h1>Este link expirou</h1>
<p>Envie <strong>painel</strong> ao ${safeName} no WhatsApp para receber um link novo.</p></main>`),
      );
    }
    const maxAge = SESSION_DAYS * 86400;
    res.set('Set-Cookie', `sessao=${auth.sign(userId, 'sessao', maxAge)}; Path=/painel; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
    res.redirect('/painel');
  });

  router.get('/sair', (_req, res) => {
    res.set('Set-Cookie', 'sessao=; Path=/painel; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    res.redirect('/painel');
  });

  router.get('/dados', async (req, res) => {
    const userId = session(req);
    if (userId === null) return res.status(401).json({ error: 'sessao' });
    const user = await db.getUserById(userId);
    if (!user) return res.status(401).json({ error: 'sessao' });

    const today = todayIn(user.timezone).today;
    await materialize(db, userId, today);
    const current = today.slice(0, 7);
    const month = MONTH.test(req.query.mes) ? req.query.mes : current;
    const rows = await db.range(userId, `${addMonths(month, -5)}-01`, `${month}-31`);
    const recurring = (await db.listRecurring(userId)).map((r) => ({
      description: r.description,
      category: r.category,
      type: r.type,
      cents: r.amount_cents,
      day: r.day_of_month,
      next: nextDue(r, today),
    }));
    res.json({ ...buildMonthData(rows, month), recurring, currentMonth: current, currency: user.currency, name: user.name || '' });
  });

  router.get('/', (req, res) => {
    if (session(req) === null) {
      return res.send(
        page(`${safeName} — Painel`, `<main class="notice"><h1>${safeName}</h1>
<p>Para abrir o seu painel, envie <strong>painel</strong> ao ${safeName} no WhatsApp e toque no link que receber.</p></main>`),
      );
    }
    res.send(
      page(`${safeName} — Painel`, `<div class="viz-root" id="app" data-bot="${safeName}">
<header class="top"><div><h1>${safeName}</h1><p id="hello" class="muted"></p></div><a class="link" href="/painel/sair">Sair</a></header>
<nav class="filters" aria-label="Mês"><button id="prev" type="button" aria-label="Mês anterior">‹</button><strong id="month-label"></strong><button id="next" type="button" aria-label="Mês seguinte">›</button></nav>
<section class="tiles" id="tiles" aria-label="Resumo do mês"></section>
<section class="grid">
<article class="card"><h2>Despesas por categoria</h2><div id="categories"></div></article>
<article class="card"><h2>Despesas por dia</h2><div id="daily" class="chart"></div></article>
<article class="card wide"><h2>Últimos 6 meses</h2><div class="legend"><span><i class="sw s1"></i>Despesas</span><span><i class="sw s2"></i>Receitas</span></div><div id="months" class="chart"></div></article>
<article class="card wide"><h2>Fixos mensais</h2><div id="recurring"></div></article>
<article class="card wide"><h2>Lançamentos do mês</h2><div class="table-wrap"><table id="table"><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th class="num">Valor</th></tr></thead><tbody></tbody></table></div></article>
</section>
<div id="tip" class="tip" role="status" hidden></div>
</div><script src="/painel/static/painel.js" defer></script>`),
    );
  });

  return router;
}
