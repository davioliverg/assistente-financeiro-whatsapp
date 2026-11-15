import 'dotenv/config';

// Remove espaços e quebras de linha coladas por engano ao copiar as chaves.
const env = Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]),
);

export const config = {
  port: Number(env.PORT || 3000),
  botName: env.BOT_NAME || 'Meu Assistente',
  currency: env.DEFAULT_CURRENCY || 'EUR',
  timezone: env.DEFAULT_TIMEZONE || 'Europe/Lisbon',
  allowedNumbers: (env.ALLOWED_NUMBERS || '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean),
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    verifyToken: env.WEBHOOK_VERIFY_TOKEN || '',
    appSecret: env.META_APP_SECRET || '',
    graphVersion: env.GRAPH_API_VERSION || 'v25.0',
  },
  gemini: {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-3.5-flash-lite,gemini-3.6-flash',
  },
  database: {
    url: env.DATABASE_URL || '',
    ssl: env.DATABASE_SSL === 'true',
  },
};

export const CATEGORIES = [
  'Alimentação',
  'Mercado',
  'Transporte',
  'Casa',
  'Contas',
  'Saúde',
  'Lazer',
  'Compras',
  'Educação',
  'Assinaturas',
  'Trabalho',
  'Salário',
  'Outros',
];
