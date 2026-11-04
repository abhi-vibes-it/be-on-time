import { handleUpdate } from '../../lib/bot.mjs';

// Telegram sends every message and button tap here. Always answer 200 so Telegram never retries a bad update.
export default async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) return new Response('forbidden', { status: 403 });
  try {
    await handleUpdate(await req.json());
  } catch (e) {
    console.error('update failed', e);
  }
  return new Response('ok');
};

export const config = { path: '/api/telegram' };
