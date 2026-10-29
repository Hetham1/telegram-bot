# Saripill Telegram bot

A Persian pill reminder bot running on Cloudflare Workers, with D1 persistence and authenticated Telegram webhooks. This replaces the Python polling process, in-memory jobs, and local JSON storage from commit `228dddf`.

Production: [Telegram bot](https://t.me/Ghorsat_yadet_nare_bot) · [Worker health](https://saripill-telegram-bot.docker-prod-cloudflare.workers.dev/health).

## Pills and daily schedule

| Tehran time | Reminder |
| --- | --- |
| 14:00 / 2 PM | اسنترا |
| 22:00 / 10 PM | اون دوتا |

These are the starting reminders. Each subscriber can edit their own pills and daily times inside Telegram with `/schedule` (also `/pills` or `/settings`). The real subscriber and test account have independent settings. Each enabled time sends one notification containing all pills assigned to it.

Choose a reminder to edit its pills or time, pause/resume it, or delete it. **یادآوری جدید** adds another daily time. Enter times such as `2 PM`, `10:30 PM`, or `14:00`; Persian and Arabic digits also work. Enter the complete pill list with one pill per line, optionally including the amount. Preview and press **ذخیره** to save, or use **انصراف** / `/cancel`. Delete also requires confirmation. Up to 12 reminders with 8 pill lines each are supported, and drafts expire after 15 minutes. Two separate reminders cannot share a time; add the pills to the existing time instead.

Tapping **Not yet** requests an additional reminder after 15 minutes (rounded up to the next cron tick). Tapping **Yes** logs the response, updates the question with the thank-you text, and cancels pending follow-ups for that question. `/start` also sends an introductory question. Admins receive confirmation notifications instead of pill reminders.

Editing, pausing or deleting a reminder invalidates its old buttons and cancels pending follow-ups and queued reminders. A time that has passed starts tomorrow. A daily slot already created today is not sent a second time after editing. Deleting all reminders leaves the schedule empty, including after `/start`. `/stop` pauses delivery without deleting the schedule.

Introductory questions and each scheduled reminder have separate response histories. Answering the introductory question cannot suppress either daily notification. Snoozes stay attached to their original question, so a confirmation only ends that question's reminder sequence.

The scheduler evaluates `Asia/Tehran` every minute. Repeated cron executions are deduplicated, with a 30-minute catch-up window. Old-day prompts cannot log responses against a new day. It creates up to 25 daily prompts and drains up to 20 outgoing API calls per tick; this deployment is sized for a personal/small group bot.

## Commands

- `/start` — subscribe or resume; admins open their menu.
- `/stop` — pause reminders and remove pending snoozes.
- `/id` — show your numeric Telegram user ID, without subscribing.
- `/help` — schedule and help.
- `/schedule` — edit your pills and daily reminder times; aliases: `/pills`, `/settings`.
- `/cancel` — discard an unfinished edit.
- Admins: `/admin`, `/stats`, `/logs`, `/users`, `/promote <id>`, `/demote <id>`, `/cancel`, `/exit`.

`ADMIN_IDS` is a comma-separated list of owner IDs in Worker secrets. Owners can grant/revoke other admins using the menu or commands. The public `Admin2024` password is removed, and every admin command and callback checks permissions. Configured owners cannot be demoted in chat; `/exit` only closes their panel. A delegated admin using `/exit` becomes a regular subscriber. Admins can pause confirmation notifications with `/stop` and resume with `/start`.

## Local development

Requires Node.js 22.16+.

```sh
npm ci
# Copy .dev.vars.example to .dev.vars and fill the values.
npm run db:local
npm run dev
```

`.dev.vars` is ignored by Git. It holds `BOT_TOKEN`, `WEBHOOK_SECRET`, and `ADMIN_IDS`. If your ID is unknown, initially leave `ADMIN_IDS` empty, deploy, and send `/id` privately to the bot. Then update the secret with the returned ID and send `/start` again.

Generate a webhook secret with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Run `npm run check` for type checking, integration tests against local D1, and a deployment dry run. Tests mock Telegram, so they never message real users or use local secrets.

## Deploy to Cloudflare

The checked-in Wrangler configuration identifies this deployment. For a different account, update `account_id`, Worker name, and database binding first.

```sh
npx wrangler login
# Only create a database for a new installation:
npx wrangler d1 create saripill-bot
# Copy its database_id into wrangler.jsonc.
npm run db:remote
npm run check
npx wrangler deploy --secrets-file .dev.vars
node scripts/setup-telegram.mjs https://YOUR-WORKER.workers.dev
```

The setup script verifies bot credentials and Worker health before changing the webhook, preserves pending updates, registers public commands, and saves the previous webhook privately under `.local/`. Verify later with:

```sh
node scripts/setup-telegram.mjs https://YOUR-WORKER.workers.dev --verify
```

Cloudflare cron changes can take several minutes to propagate. `GET /health` verifies configuration and the database schema without exposing user records. `POST /webhook` requires the `X-Telegram-Bot-Api-Secret-Token` header. There is no public setup or manual-send endpoint.

For an existing deployment, apply `0003_editable_schedules.sql` before deploying the new Worker. It seeds the two current reminders once per existing account and preserves responses, pending snoozes and outgoing messages. Export a private backup first (`wrangler d1 export DB --remote --output .local/before-editable-schedules.sql`). The Worker also seeds accounts created during the migration/deployment gap. New prompt records retain the pill names and time as a snapshot, so later edits do not rewrite history or admin confirmation details. Health reports `schedules: "per_user"` and `default_reminders`, never someone's personal pill list.

## Existing installation

Subscriptions and historical JSON logs are not stored in Git, and Telegram cannot list all past subscribers. Existing users must send `/start` to the newly deployed bot unless their saved user data is migrated. Retain `bot_users.json` and `bot_logs.json` from the previous server if historical records are needed; do not commit them. The original Python source remains in Git history.

Changing the webhook does not stop a scheduler on the old server. Disable the previous process/schedule after cutover to avoid duplicate daily reminders. The previous webhook alone is not a full rollback: a rollback may also require the previous server's secret, database, and process configuration.

## Reliability and data

- `src/bot.ts` handles commands and button callbacks; `messages.ts` contains Persian text.
- `src/time.ts` parses AM/PM or 24-hour times and converts Tehran dates.
- `src/schedule-editor.ts` implements the Persian menu and persisted, revision-checked edit drafts.
- `src/store.ts` and `migrations/` define persistent users, prompts, snoozes, an update inbox, and an outgoing-message queue.
- `src/scheduler.ts` recovers deferred updates and schedules each saved, enabled reminder at its chosen minute.
- `src/delivery.ts` retries transient Telegram errors, respects `retry_after`, and pauses users who block the bot.
- `src/index.ts` validates webhook authentication, input shape, and body size.

Response writes and outgoing messages are committed in one D1 transaction. Replayed updates and concurrent button taps do not double-count responses. Successful inbox/outbox records expire after seven days; response history remains in D1. Failed inbox updates are retried up to ten times; inspect `inbox` and `outbox` for exhausted retries. Logs contain error categories/update IDs, never bot tokens or response text.

Delivery is at least once: if Telegram accepts a message but its response or the subsequent D1 acknowledgement is lost, a retry can send it twice. Telegram offers no idempotency key for `sendMessage`. This is a reminder aid and does not verify that medication was actually taken.
