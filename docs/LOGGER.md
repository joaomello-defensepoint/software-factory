# Logger tab: daily Kimai time logging

The Logger tab replaces the claude.ai "Tempo Logger" routine and the GitHub Actions fallback with a local
scheduler inside Software Factory. Because the app is always running, the entry for the previous day is
created from this machine, the run history is visible in the tab, and the Opus session that wrote the
Summary line opens from the run like any other session.

## What a run does

1. **Facts** — `apps/logger/lt.py preview` reads your Azure DevOps commits of the day (three repos, merged
   and branch commits, deduplicated and ranked by size, top 5) and the Llama items you reported that were
   updated that day. It also asks Kimai whether the day is already logged (dedup guard).
2. **Calendar** — `gcal_meetings.py` reads your Google Calendar through the service account and keeps the
   meetings you accepted or organised (top 3). Best effort.
3. **Slack** — `slack_context.py` reads the configured channels **as you** (user token) and keeps the threads
   you took part in. The bot never joins a channel. Best effort; see the scopes note below.
4. **Summary** — only this step uses Claude (model `logger.model`, Opus by default). It receives the gathered
   data and returns a Summary line (≤ 300 characters, impersonal, no personal matters, nothing invented)
   plus up to three `#channel: topic` lines. The entry text is then composed by the server with the gathered
   sections **verbatim**, in the exact shape the cloud routine used.
5. **Create** — `lt.py create` posts the 05:00–13:00 entry (project 12, activity 7) and the server DMs you
   the status line on Slack (`🕒 Kimai auto-log: CREATED …` / `SKIPPED-…` / `ERROR …`), like the routine did.

Empty rule: no commits, no Llama items, no meetings and no Slack discussions → `SKIPPED-EMPTY`, nothing is
created. Already logged → `SKIPPED-DUPLICATE`.

## Schedule

`config.yaml` → `logger`:

```yaml
logger:
  enabled: true
  time: '08:00'          # this Mac's local time
  days: [2, 3, 4, 5, 6]  # Tue–Sat; each run logs the previous day (São Paulo date)
  catchUp: true          # a slot missed while the Mac slept / app was closed runs at the next start
  model: opus
  slackUserId: U095NNEUH98
  slackChannels: { C039TK0Q346: '#product-dev-qa', ... }
  notifySlack: true
```

The tab shows the next firing and the date it will log. "Scheduled", "Slack DM" and the time are editable in
the tab; the rest in Settings → config.yaml. The scheduler checks every minute, so sleeping through the slot
is fine: the run fires when the Mac wakes (same day) or at the next app start when `catchUp` is on.

## Manual runs

- **Preview** gathers everything and writes the entry but does not touch Kimai. The description is editable
  in the tab; **Log this entry in Kimai** creates it (the dedup guard runs again first).
- **Log now** runs the whole flow for the chosen day, including the Slack DM.
- Any past day can be picked for backfills. Kimai rejects same-day entries.

## Secrets

`~/.claude/software-factory/logger.env` (mode 600, never in the repo; `apps/logger/variables.example` lists
the keys): `ADO_PAT`, `KIMAI_TOKEN`, `LLAMA_API_KEY`, `GCAL_SA_KEY` (service-account JSON on one line, single
quoted), `SLACK_USER_TOKEN`, `SLACK_BOT_TOKEN`. Azure DevOps is read with an `az` CLI token when you are logged in, the PAT is
the fallback. The tab shows which keys are present; values never leave the server and are never in a prompt.

### Slack tokens

Two tokens from the same Slack app ("Tempo Logger", api.slack.com/apps → OAuth & Permissions):

- `SLACK_BOT_TOKEN` (`xoxb-…`) with `chat:write` + `im:write`: only used to DM you the status.
- `SLACK_USER_TOKEN` (`xoxp-…`): the **User OAuth Token**, issued after adding the *User Token Scopes*
  `channels:history`, `groups:history`, `users:read` and reinstalling the app. It acts as you, so it reads
  exactly the channels you are in and the bot stays out of them. Without it the run falls back to the bot
  token (which would need membership and bot scopes); either way a missing scope only drops the `[Slack]`
  section and shows a warning on the run.

## Files

- `apps/logger/lt.py` — mirror of the tempo-logger repo script plus `ADO_TOKEN` (bearer) support, one retry on
  network blips and a `warnings` list in the preview JSON.
- `apps/logger/gcal_meetings.py` — same as the repo, with a stdlib token signer (openssl) when google-auth is
  not installed.
- `apps/logger/slack_context.py` — new; replaces the Slack connector the cloud routine used.
- `apps/server/src/services/timelogger.ts` — runs, composition, schedule; `routes/logger.ts` — API;
  `apps/web/src/pages/LoggerPage.tsx` — the tab. Run folders live in `~/.claude/software-factory/logger/`.
