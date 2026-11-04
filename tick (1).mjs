import { runTick } from '../../lib/tick.mjs';

// Netlify calls this every minute (cron times are UTC, but the bot only uses timestamps).
export default async () => {
  try {
    const r = await runTick();
    console.log('tick', JSON.stringify(r));
  } catch (e) {
    console.error('tick failed', e);
  }
  return new Response('ok');
};

export const config = { schedule: '* * * * *' };
