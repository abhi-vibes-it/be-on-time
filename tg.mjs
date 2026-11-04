// Thin Telegram + Groq voice helpers. Uses only fetch, so there is nothing to install.
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const base = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function call(method, body) {
  const r = await fetch(`${base()}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error('telegram', method, j.description);
  return j;
}
export const btn = (text, data) => ({ text, callback_data: data });
export const send = (chat, text, rows) => call('sendMessage', {
  chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
  ...(rows && rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
});
export const edit = (chat, mid, text, rows) => call('editMessageText', {
  chat_id: chat, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true,
  reply_markup: { inline_keyboard: rows || [] },
});
export const answer = (id, text) => call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });

/** Optional: transcribe a Telegram voice note with Groq's free Whisper. Returns text or null. */
export async function transcribe(fileId) {
  if (!process.env.GROQ_API_KEY) return null;
  try {
    const f = await call('getFile', { file_id: fileId });
    const path = f?.result?.file_path;
    if (!path) return null;
    const audio = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`);
    const blob = new Blob([await audio.arrayBuffer()], { type: 'audio/ogg' });
    const form = new FormData();
    form.append('file', blob, 'voice.ogg');
    form.append('model', process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo');
    form.append('language', 'en');
    form.append('response_format', 'json');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form,
    });
    if (!r.ok) { console.error('groq stt', r.status); return null; }
    return ((await r.json()).text || '').trim() || null;
  } catch (e) { console.error('transcribe', e.message); return null; }
}
