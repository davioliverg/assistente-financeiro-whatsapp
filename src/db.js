// Camada de dados. Tudo é guardado por utilizador (user_id), por isso o mesmo
// código serve para uso pessoal e, mais tarde, para vários clientes.
import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  currency TEXT NOT NULL,
  timezone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  source TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions (user_id, occurred_on);
CREATE TABLE IF NOT EXISTS recurring (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  day_of_month INTEGER NOT NULL,
  start_month TEXT NOT NULL,
  last_posted_month TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS processed_messages (
  wamid TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export function createPool({ url, ssl }) {
  return new pg.Pool({
    connectionString: url,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
}

export function createDb(pool) {
  const q = (text, params) => pool.query(text, params);

  return {
    async migrate() {
      await q(SCHEMA);
    },

    async getOrCreateUser(phone, name, defaults) {
      const found = await q('SELECT * FROM users WHERE phone = $1', [phone]);
      if (found.rows[0]) return found.rows[0];
      const created = await q(
        `INSERT INTO users (phone, name, currency, timezone) VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone) DO NOTHING RETURNING *`,
        [phone, name || null, defaults.currency, defaults.timezone],
      );
      if (created.rows[0]) return created.rows[0];
      return (await q('SELECT * FROM users WHERE phone = $1', [phone])).rows[0];
    },

    // A Meta reenvia webhooks quando há falhas; devolve false se já vimos a mensagem.
    async markProcessed(wamid) {
      try {
        await q('INSERT INTO processed_messages (wamid) VALUES ($1)', [wamid]);
        return true;
      } catch (err) {
        if (err.code === '23505' || /duplicate key/i.test(err.message)) return false;
        throw err;
      }
    },

    async addTransactions(userId, items, source, batchId) {
      const saved = [];
      for (const it of items) {
        const r = await q(
          `INSERT INTO transactions
             (user_id, type, amount_cents, category, description, occurred_on, source, batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [userId, it.type, it.amountCents, it.category, it.description, it.date, source, batchId],
        );
        saved.push(r.rows[0]);
      }
      return saved;
    },

    // Apaga o último registo (todos os lançamentos criados pela mesma mensagem).
    async deleteLast(userId) {
      const last = await q(
        'SELECT batch_id FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
        [userId],
      );
      if (!last.rows[0]) return [];
      const del = await q(
        'DELETE FROM transactions WHERE user_id = $1 AND batch_id = $2 RETURNING *',
        [userId, last.rows[0].batch_id],
      );
      return del.rows;
    },

    async getUserById(id) {
      return (await q('SELECT * FROM users WHERE id = $1', [id])).rows[0] || null;
    },

    // Lançamentos entre duas datas (inclusive), do mais recente para o mais antigo.
    async range(userId, from, to) {
      const r = await q(
        `SELECT * FROM transactions
          WHERE user_id = $1 AND occurred_on >= $2 AND occurred_on <= $3
          ORDER BY occurred_on DESC, id DESC`,
        [userId, from, to],
      );
      return r.rows;
    },

    // ----- gastos fixos -----
    async addRecurring(userId, r) {
      const res = await q(
        `INSERT INTO recurring (user_id, type, amount_cents, category, description, day_of_month, start_month)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [userId, r.type, r.amountCents, r.category, r.description, r.day, r.startMonth],
      );
      return res.rows[0];
    },

    async listRecurring(userId) {
      const res = await q(
        'SELECT * FROM recurring WHERE user_id = $1 AND active = true ORDER BY day_of_month, id',
        [userId],
      );
      return res.rows;
    },

    // Cancela o fixo (deixa de lançar); os lançamentos já feitos ficam.
    async cancelRecurring(userId, id) {
      const res = await q(
        'UPDATE recurring SET active = false WHERE user_id = $1 AND id = $2 AND active = true RETURNING *',
        [userId, id],
      );
      return res.rows[0] || null;
    },

    // Marca um mês como lançado; devolve false se já estava (evita duplicados).
    async claimRecurringMonth(id, month) {
      const res = await q(
        `UPDATE recurring SET last_posted_month = $2
          WHERE id = $1 AND active = true AND (last_posted_month IS NULL OR last_posted_month < $2)
          RETURNING id`,
        [id, month],
      );
      return res.rows.length > 0;
    },

    // Últimos lançamentos do utilizador, do mais recente para o mais antigo.
    async recent(userId, limit = 10) {
      const r = await q(
        'SELECT * FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
        [userId, limit],
      );
      return r.rows;
    },

    async deleteById(userId, id) {
      const r = await q('DELETE FROM transactions WHERE user_id = $1 AND id = $2 RETURNING *', [userId, id]);
      return r.rows[0] || null;
    },

    async updateById(userId, id, f) {
      const r = await q(
        `UPDATE transactions
            SET amount_cents = $3, category = $4, description = $5, occurred_on = $6, type = $7
          WHERE user_id = $1 AND id = $2 RETURNING *`,
        [userId, id, f.amount_cents, f.category, f.description, f.occurred_on, f.type],
      );
      return r.rows[0] || null;
    },

    // As somas são feitas aqui, em SQL — nunca pela IA.
    async summary(userId, from, to) {
      const r = await q(
        `SELECT type, category, SUM(amount_cents) AS total, COUNT(*) AS n
           FROM transactions
          WHERE user_id = $1 AND occurred_on >= $2 AND occurred_on <= $3
          GROUP BY type, category`,
        [userId, from, to],
      );
      return r.rows
        .map((row) => ({
          type: row.type,
          category: row.category,
          totalCents: Number(row.total),
          count: Number(row.n),
        }))
        .sort((a, b) => b.totalCents - a.totalCents);
    },
  };
}
