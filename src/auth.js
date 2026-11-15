// Tokens assinados (HMAC) para o painel web: sem palavras-passe.
// O utilizador pede o link no WhatsApp; o link cria uma sessão no navegador.
import crypto from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function createAuth(secret) {
  const mac = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

  return {
    // kind: 'login' (link curto, enviado no WhatsApp) ou 'sessao' (cookie)
    sign(userId, kind, ttlSeconds, now = Date.now()) {
      const body = b64(JSON.stringify({ u: userId, k: kind, e: Math.floor(now / 1000) + ttlSeconds }));
      return `${body}.${mac(body)}`;
    },

    // Devolve o id do utilizador, ou null se o token for inválido, expirado ou de outro tipo.
    verify(token, kind, now = Date.now()) {
      if (typeof token !== 'string') return null;
      const [body, sig] = token.split('.');
      if (!body || !sig) return null;
      const a = Buffer.from(sig);
      const b = Buffer.from(mac(body));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (data.k !== kind || typeof data.u !== 'number' || data.e < now / 1000) return null;
        return data.u;
      } catch {
        return null;
      }
    },
  };
}

export function deriveSecret(...parts) {
  const material = parts.filter(Boolean).join('|');
  // Sem nada de onde derivar, usa um segredo aleatório (as sessões caem a cada reinício).
  if (!material) return crypto.randomBytes(32).toString('hex');
  return crypto.createHash('sha256').update(`painel|${material}`).digest('hex');
}
