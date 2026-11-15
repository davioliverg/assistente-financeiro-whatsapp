// Cliente mínimo da WhatsApp Cloud API (API oficial da Meta).
export function createWhatsApp({ token, phoneNumberId, graphVersion }, fetchImpl = fetch) {
  const base = `https://graph.facebook.com/${graphVersion}`;
  const auth = { Authorization: `Bearer ${token}` };

  async function post(body) {
    const res = await fetchImpl(`${base}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  return {
    sendText(to, text) {
      return post({ to, type: 'text', text: { body: text.slice(0, 4000) } });
    },

    markRead(wamid) {
      return post({ status: 'read', message_id: wamid });
    },

    // 1) pede o URL temporário do ficheiro (expira em 5 min)  2) descarrega com o token
    async downloadMedia(mediaId, maxBytes = 15 * 1024 * 1024) {
      const metaRes = await fetchImpl(`${base}/${mediaId}?phone_number_id=${phoneNumberId}`, {
        headers: auth,
      });
      if (!metaRes.ok) throw new Error(`Media ${metaRes.status}: ${await metaRes.text()}`);
      const meta = await metaRes.json();
      if (Number(meta.file_size) > maxBytes) throw new Error('MEDIA_TOO_LARGE');
      const fileRes = await fetchImpl(meta.url, { headers: auth });
      if (!fileRes.ok) throw new Error(`Media download ${fileRes.status}`);
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      if (buffer.length > maxBytes) throw new Error('MEDIA_TOO_LARGE');
      return { buffer, mimeType: (meta.mime_type || '').split(';')[0].trim() };
    },
  };
}
