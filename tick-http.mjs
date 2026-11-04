import { runTick } from '../../lib/tick.mjs';

// Backup trigger. If Netlify's own every-minute schedule is unavailable on your plan, point a free
// pinger (for example cron-job.org) at  https://YOUR-SITE.netlify.app/api/tick?key=YOUR_WEBHOOK_SECRET  every minute.
export default async (req) => {
  const key = new URL(req.url).searchParams.get('key');
  if (!process.env.WEBHOOK_SECRET || key !== process.env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  try {
    return Response.json(await runTick());
  } catch (e) {
    console.error('tick failed', e);
    return new Response('error', { status: 500 });
  }
};

export const config = { path: '/api/tick' };
