export function money(cents, currency) {
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency }).format(cents / 100);
}

export function shortDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Data e dia da semana "de hoje" no fuso do utilizador.
export function todayIn(timezone, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  const weekday = new Intl.DateTimeFormat('pt-PT', { timeZone: timezone, weekday: 'long' }).format(now);
  return { today, weekday };
}

export function helpText(botName) {
  return [
    `👋 Sou o ${botName}, o seu assistente financeiro.`,
    '',
    '*Para anotar*, mande como quiser:',
    '• texto: _mercado 120_ · _uber 8,50 ontem_ · _recebi 900 do cliente_',
    '• áudio: grave a dizer o gasto',
    '• foto do recibo ou comprovante',
    '',
    '*Para consultar*:',
    '• _quanto gastei este mês?_',
    '• _resumo da semana_',
    '• _quanto gastei em transporte em outubro?_',
    '',
    '*Gastos fixos* (lançados sozinhos todos os meses):',
    '• _netflix 13,99 todo mês dia 5_',
    '• _meus gastos fixos_ · _cancela o fixo da netflix_',
    '',
    '*Painel com gráficos*: mande _painel_',
    '',
    '*Para ver ou corrigir*:',
    '• _mostra os últimos gastos_',
    '• _apagar último_ · _apagar o uber_',
    '• _corrige o mercado para 110_',
  ].join('\n');
}

export function confirmText(items, currency, monthExpensesCents) {
  const lines = items.map((it) => {
    const icon = it.type === 'receita' ? '💰' : '✅';
    return `${icon} ${it.description} — ${money(it.amountCents, currency)} (${it.category}) · ${shortDate(it.date)}`;
  });
  lines.push('', `Despesas deste mês: ${money(monthExpensesCents, currency)}`);
  return `Anotado!\n${lines.join('\n')}`;
}

export function summaryText(rows, query, currency) {
  let filtered = rows;
  if (query.type) filtered = filtered.filter((r) => r.type === query.type);
  if (query.category) filtered = filtered.filter((r) => r.category === query.category);

  const period = `${shortDate(query.from)} a ${shortDate(query.to)}`;
  if (filtered.length === 0) return `Não encontrei lançamentos ${query.label} (${period}).`;

  const sum = (type) =>
    filtered.filter((r) => r.type === type).reduce((acc, r) => acc + r.totalCents, 0);
  const expenses = sum('despesa');
  const income = sum('receita');

  const out = [`📊 *Resumo ${query.label}* (${period})`, ''];
  const expenseRows = filtered.filter((r) => r.type === 'despesa');
  if (expenseRows.length) {
    out.push(`*Despesas: ${money(expenses, currency)}*`);
    for (const r of expenseRows) {
      const pct = expenses ? Math.round((r.totalCents / expenses) * 100) : 0;
      out.push(`• ${r.category}: ${money(r.totalCents, currency)} (${pct}%)`);
    }
  }
  const incomeRows = filtered.filter((r) => r.type === 'receita');
  if (incomeRows.length) {
    if (expenseRows.length) out.push('');
    out.push(`*Receitas: ${money(income, currency)}*`);
    for (const r of incomeRows) out.push(`• ${r.category}: ${money(r.totalCents, currency)}`);
  }
  if (expenseRows.length && incomeRows.length) {
    out.push('', `*Saldo: ${money(income - expenses, currency)}*`);
  }
  return out.join('\n');
}

export function rowLine(r, currency) {
  const icon = r.source === 'fixo' ? '🔁' : r.type === 'receita' ? '💰' : '•';
  return `${icon} ${shortDate(r.occurred_on)} — ${r.description}: ${money(r.amount_cents, currency)} (${r.category})`;
}

export function listText(rows, currency) {
  if (rows.length === 0) return 'Ainda não há lançamentos anotados.';
  return [`🧾 *Últimos ${rows.length} lançamentos*`, '', ...rows.map((r) => rowLine(r, currency))].join('\n');
}

// Comparação sem acentos nem maiúsculas.
export function fold(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function recurringLine(r, currency) {
  const kind = r.type === 'receita' ? ' (receita)' : '';
  return `🔁 dia ${r.day_of_month} — ${r.description}: ${money(r.amount_cents, currency)} (${r.category})${kind}`;
}

export function recurringListText(rows, currency) {
  if (rows.length === 0) {
    return 'Ainda não tem gastos fixos. Para criar um: _netflix 13,99 todo mês dia 5_.';
  }
  const expenses = rows.filter((r) => r.type === 'despesa').reduce((a, r) => a + r.amount_cents, 0);
  const income = rows.filter((r) => r.type === 'receita').reduce((a, r) => a + r.amount_cents, 0);
  const out = ['🔁 *Os seus fixos*', '', ...rows.map((r) => recurringLine(r, currency)), ''];
  out.push(`Despesas fixas por mês: ${money(expenses, currency)}`);
  if (income) out.push(`Receitas fixas por mês: ${money(income, currency)}`);
  return out.join('\n');
}
