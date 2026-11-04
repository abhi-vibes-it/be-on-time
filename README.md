# Abhi On Time bot

A personal Telegram bot that keeps your promises realistic. You tell it things in plain words (type, or use your keyboard's mic). It checks them against your day, slots tasks into free gaps, nudges you with the screen off, and asks one thing afterwards: did you make it?

## What you do each day
- Say or type: `coffee with a friend at 3, 20 min away`, `review the draft, 45 mins`, `send the report by 5, an hour of work left`
- Fix mistakes in plain words: `it's 30 min away`, `make that 4pm`, `cancel the coffee`
- Tap a button when it pings you: **I've left**, **Made it / Late / Missed**, **Start / Done**
- Commands: `/today`, `/review`, `/day 09:00 20:00`, `/brief 08:30`, `/evening 21:00`

## Set up (about 15 minutes)

You need: a Telegram bot token (from @BotFather), a Groq API key (console.groq.com), a Netlify account, and a GitHub account.

### 1. Put the code on GitHub
Create a new **private** repository (for example `abhi-on-time-bot`) and upload everything in this folder (keep the folder structure). Do not upload any file containing your keys. There are none in this folder.

### 2. Create the Netlify site
Netlify, Add new site, Import an existing project, pick the repository. Build command: leave empty. Publish directory: `public`. (Netlify reads `netlify.toml`, so these should be filled in already.)

### 3. Add environment variables
Site configuration, Environment variables. Add:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from @BotFather |
| `GROQ_API_KEY` | your Groq key |
| `WEBHOOK_SECRET` | any long random string you make up (letters and numbers) |

Optional: `TZ_OFFSET_MIN` (default 330, which is India time), `GROQ_MODEL` (default `llama-3.3-70b-versatile`).

Then trigger a deploy (Deploys, Trigger deploy).

### 4. Connect Telegram to your site
Open this address in your browser, with your own three values filled in (type them yourself, never paste them into a chat):

```
https://api.telegram.org/botYOUR_TOKEN/setWebhook?url=https://YOUR-SITE.netlify.app/api/telegram&secret_token=YOUR_WEBHOOK_SECRET
```

You should see `"ok":true`.

### 5. Claim the bot
Open your bot in Telegram and send `/start`. The first person to do this becomes the owner. The bot ignores everyone else after that. Do this right away.

### 6. Check the every-minute scheduler
Netlify, Functions, `tick`, Logs. You should see a line like `tick {"sent":0}` once a minute. If you see nothing after 5 minutes, your plan may not run every-minute schedules. Use the backup: create a free job at cron-job.org that opens
`https://YOUR-SITE.netlify.app/api/tick?key=YOUR_WEBHOOK_SECRET`
every minute. The bot then works the same way.

### 7. Test it
Send: `coffee with a friend at 3, 20 min away` (use a time a few minutes ahead). Lock your phone. You should get a "Leave in 5 min" buzz, then "Did you make it?".

## What is checked and what is not
- Tested locally (`npm test`): time reading, the clash and day-load checks, free-slot finding, the fallback parser, a full day of messages, nudges, check-ins, morning carry-over and the evening wrap, and that strangers are ignored.
- **Not tested against the real services:** Telegram, Groq, and Netlify's scheduler and Blobs storage. Those need your keys, so the first real run is the real test. If something fails, the Netlify function logs show the error.
- If Groq is down or the key is wrong, a built-in parser handles the common phrasings, so the bot does not go silent.

## Privacy
- Your messages go to Groq for parsing, and to Telegram and Netlify (where your ledger is stored). Groq's free tier does not keep inference data by default, according to a third-party summary. Check their current terms.
- Keys live only in Netlify's environment variables.
- The scheduler and webhook only answer the Telegram chat that claimed the bot.

## Limits of v1
Today and tomorrow only. No recurring items yet. No automatic arrival detection and no phone-usage tracking: those need the Android app, planned next.
