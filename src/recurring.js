// Gastos (e receitas) fixos: lançados sozinhos todos os meses no dia marcado.
// Não há relógio a correr: sempre que o utilizador fala com o bot ou abre o painel,
// criamos os lançamentos que entretanto venceram. Repetir é seguro (nunca duplica).

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

// Data em que o fixo vence num dado mês (dia 31 em fevereiro passa a 28/29).
export function dueDate(month, day) {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, '0')}`;
}

// Primeiro mês a lançar: este, se o dia ainda não passou; senão o próximo.
export function firstMonth(today, day) {
  const month = today.slice(0, 7);
  return dueDate(month, day) >= today ? month : nextMonth(month);
}

// Próxima data em que o fixo vai ser lançado (ou a de hoje, se vence hoje e ainda não foi).
export function nextDue(rec, today) {
  let month = rec.last_posted_month ? nextMonth(rec.last_posted_month) : rec.start_month;
  if (month < rec.start_month) month = rec.start_month;
  return dueDate(month, rec.day_of_month);
}

export async function materialize(db, userId, today) {
  const created = [];
  for (const rec of await db.listRecurring(userId)) {
    let month = rec.last_posted_month ? nextMonth(rec.last_posted_month) : rec.start_month;
    // No máximo 24 meses de uma vez, para o caso de alguém voltar passado muito tempo.
    for (let i = 0; i < 24 && dueDate(month, rec.day_of_month) <= today; i++) {
      // Só lança quem conseguir "marcar" o mês: duas mensagens ao mesmo tempo não duplicam.
      if (await db.claimRecurringMonth(rec.id, month)) {
        const [tx] = await db.addTransactions(
          userId,
          [{
            type: rec.type,
            amountCents: rec.amount_cents,
            category: rec.category,
            description: rec.description,
            date: dueDate(month, rec.day_of_month),
          }],
          'fixo',
          `fixo-${rec.id}-${month}`,
        );
        created.push(tx);
      }
      month = nextMonth(month);
    }
  }
  return created;
}
