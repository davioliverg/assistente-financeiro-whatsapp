// Lógica principal: recebe uma mensagem do WhatsApp e decide o que responder.
import {
  confirmText, fold, helpText, listText, money, recurringLine, recurringListText, rowLine, shortDate, summaryText, todayIn,
} from './format.js';
import { dueDate, firstMonth, materialize } from './recurring.js';

const MEDIA_TYPES = { audio: 'áudio', image: 'foto', document: 'documento' };
const DOCUMENT_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

export function createHandler({ db, wa, ai, config, auth = null, log = console }) {
  async function handle(message, contactName) {
    const phone = message.from;

    // Fase pessoal: só os números autorizados são atendidos.
    if (config.allowedNumbers.length && !config.allowedNumbers.includes(phone)) {
      log.warn(`Mensagem ignorada de número não autorizado: ...${String(phone).slice(-4)}`);
      return;
    }
    if (!(await db.markProcessed(message.id))) return; // reenvio da Meta

    const user = await db.getOrCreateUser(phone, contactName, {
      currency: config.currency,
      timezone: config.timezone,
    });
    const reply = (text) => wa.sendText(phone, text);
    wa.markRead(message.id).catch(() => {});

    try {
      // Lança os gastos fixos que venceram desde a última conversa.
      const { today, weekday } = todayIn(user.timezone);
      const posted = await materialize(db, user.id, today);
      if (posted.length) log.info?.(`Fixos lançados: ${posted.length}`);

      const input = await buildInput(message);
      if (!input) {
        await reply('Por enquanto só entendo texto, áudio e fotos de recibos. 🙂');
        return;
      }

      // Atalhos sem gastar chamadas de IA
      const plain = (input.text || '').trim().toLowerCase();
      if (!input.media && /^\/?(ajuda|help|menu|oi|olá|ola)[.!?]*$/.test(plain)) {
        await reply(helpText(config.botName));
        return;
      }

      if (!input.media && /^\/?((meus |os meus )?(gastos )?fixos)[.!?]*$/.test(plain)) {
        await reply(recurringListText(await db.listRecurring(user.id), user.currency));
        return;
      }

      if (!input.media && /^\/?(painel|dashboard|gr[aá]ficos|relat[oó]rio)[.!?]*$/.test(plain)) {
        await reply(panelLink(user));
        return;
      }

      const started = Date.now();
      const result = await ai.interpret(input, { today, weekday, currency: user.currency });
      log.info?.(`IA respondeu em ${Date.now() - started} ms: ${result.intent}`);

      if (result.intent === 'registar') {
        await db.addTransactions(user.id, result.items, message.type, message.id);
        const month = await db.summary(user.id, `${today.slice(0, 8)}01`, `${today.slice(0, 8)}31`);
        const monthExpenses = month
          .filter((r) => r.type === 'despesa')
          .reduce((acc, r) => acc + r.totalCents, 0);
        await reply(confirmText(result.items, user.currency, monthExpenses));
      } else if (result.intent === 'consultar') {
        const rows = await db.summary(user.id, result.query.from, result.query.to);
        await reply(summaryText(rows, result.query, user.currency));
      } else if (result.intent === 'apagar_ultimo') {
        const removed = await db.deleteLast(user.id);
        await reply(
          removed.length
            ? `🗑️ Apagado: ${removed
                .map((r) => `${r.description} (${money(r.amount_cents, user.currency)})`)
                .join(', ')}`
            : 'Não há nenhum lançamento para apagar.',
        );
      } else if (result.intent === 'listar') {
        await reply(listText(await db.recent(user.id, 10), user.currency));
      } else if (result.intent === 'apagar' || result.intent === 'corrigir') {
        const matches = findMatches(await db.recent(user.id, 200), result.target);
        if (matches.length === 0) {
          await reply('Não encontrei nenhum lançamento assim. Mande _mostra os últimos gastos_ para ver a lista.');
        } else if (result.intent === 'apagar') {
          const removed = await db.deleteById(user.id, matches[0].id);
          await reply(`🗑️ Apagado:\n${rowLine(removed, user.currency)}${othersNote(matches)}`);
        } else {
          const updated = await db.updateById(user.id, matches[0].id, { ...matches[0], ...result.changes });
          await reply(`✏️ Corrigido:\n${rowLine(updated, user.currency)}${othersNote(matches)}`);
        }
      } else if (result.intent === 'fixo_criar') {
        const r = result.recurring;
        const day = r.day || Number(today.slice(8, 10));
        const startMonth = firstMonth(today, day);
        const rec = await db.addRecurring(user.id, { ...r, day, startMonth });
        await materialize(db, user.id, today); // se vence hoje, lança já
        const first = dueDate(startMonth, day);
        const when = first === today ? 'hoje (já anotado)' : shortDate(first);
        const late = startMonth !== today.slice(0, 7)
          ? `\n\nO dia ${day} deste mês já passou; se já pagou, anote à parte.`
          : '';
        await reply(`Fixo criado!\n${recurringLine(rec, user.currency)}\n\nPrimeiro lançamento: ${when}. Depois, todos os meses.${late}`);
      } else if (result.intent === 'fixo_listar') {
        await reply(recurringListText(await db.listRecurring(user.id), user.currency));
      } else if (result.intent === 'fixo_apagar') {
        const all = await db.listRecurring(user.id);
        const matches = findMatches(all, result.target);
        if (matches.length === 0) {
          await reply('Não encontrei nenhum fixo assim. Mande _meus gastos fixos_ para ver a lista.');
        } else if (matches.length > 1) {
          await reply(`Há ${matches.length} fixos parecidos. Diga também o valor:\n${matches.map((m) => recurringLine(m, user.currency)).join('\n')}`);
        } else {
          const gone = await db.cancelRecurring(user.id, matches[0].id);
          await reply(`🛑 Fixo cancelado:\n${recurringLine(gone, user.currency)}\n\nOs lançamentos já feitos continuam anotados.`);
        }
      } else if (result.intent === 'painel') {
        await reply(panelLink(user));
      } else if (result.intent === 'ajuda') {
        await reply(helpText(config.botName));
      } else {
        await reply(
          result.reply ||
            'Não consegui perceber. Tente algo como _mercado 120_ ou mande _ajuda_.',
        );
      }
    } catch (err) {
      log.error('Erro ao tratar mensagem', err);
      const tooBig = err.message === 'MEDIA_TOO_LARGE';
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      await reply(
        tooBig
          ? 'Esse ficheiro é grande demais. Mande um áudio mais curto ou uma foto mais leve.'
          : timedOut
            ? 'A IA demorou demais a responder. Nada foi anotado — tente de novo daqui a pouco.'
            : 'Tive um problema a processar a sua mensagem. Nada foi anotado — tente de novo daqui a pouco.',
      ).catch(() => {});
    }
  }

  // Link pessoal e temporário para o painel web.
  function panelLink(user) {
    if (!auth || !config.publicUrl) return 'O painel web ainda não está configurado neste servidor.';
    const token = auth.sign(user.id, 'login', 15 * 60);
    return `📊 O seu painel:\n${config.publicUrl}/painel/entrar?t=${token}\n\nO link é pessoal e vale 15 minutos. Não o partilhe.`;
  }

  // Lançamentos (do mais recente para o mais antigo) que batem com a descrição e/ou o valor.
  function findMatches(rows, target) {
    const needle = fold(target.text);
    return rows.filter((r) => {
      const textOk = !needle || fold(r.description).includes(needle) || fold(r.category).includes(needle);
      const amountOk = target.amountCents === null || r.amount_cents === target.amountCents;
      return textOk && amountOk;
    });
  }

  function othersNote(matches) {
    return matches.length > 1
      ? `\n\nHavia ${matches.length} lançamentos parecidos; mexi no mais recente.`
      : '';
  }

  async function buildInput(message) {
    if (message.type === 'text') return { text: message.text?.body || '' };
    if (!MEDIA_TYPES[message.type]) return null;

    const ref = message[message.type];
    if (!ref?.id) return null;
    const media = await wa.downloadMedia(ref.id);
    if (message.type === 'document' && !DOCUMENT_MIMES.includes(media.mimeType)) return null;
    return { text: ref.caption || '', media };
  }

  return { handle };
}
