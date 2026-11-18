# Architecture

```
apps/web      React 19 + MUI 9 + dnd-kit + TanStack Query (Vite)        → http://localhost:5180 (dev)
apps/server   Node 26 + Fastify + node:sqlite + Claude Agent SDK (tsx)   → http://127.0.0.1:4100
packages/shared  TypeScript contracts shared by both
```

State lives outside the repo so it survives re-clones: `~/.claude/software-factory/`
(`factory.db`, `config.yaml`, `workflows/`, `logs/`). Secrets live in `.env` at the repo root.

## Server modules

| module                               | responsibility                                                                 |
|--------------------------------------|--------------------------------------------------------------------------------|
| `services/cards.ts`                  | board cards (SQLite), column moves, archive                                     |
| `services/mcp.ts`                    | MCP bridge: one-shot Haiku session that calls a claude.ai connector tool and captures the raw result |
| `services/jira.ts`                   | Jira: MCP mode (Atlassian connector) by default, REST v3 with a token optionally; board sync rules |
| `services/llama.ts`                  | Llama via its MCP server (`@agllama/mcp`), key reused from `~/.claude.json`     |
| `services/fathom.ts`                 | Fathom: MCP mode (Fathom connector) by default, public API with a key optionally |
| `services/ado.ts`                    | Azure DevOps PRs through the `az` CLI                                           |
| `services/brain.ts`                  | second-brain vaults: pages, Fathom ingest, repo indexing, lint, query (jobs)    |
| `services/claude.ts`                 | one headless Claude Code session via the Agent SDK; registers it in the session registry |
| `services/sessions.ts`               | session registry + transcripts, interactive chats (streaming input), on-disk Claude Code history, usage/plan-limit capture |
| `services/workflow/definitions.ts`   | YAML + role files in `~/.claude/software-factory/workflows`                     |
| `services/workflow/engine.ts`        | the maestro loop, worktree creation, diff, human-in-the-loop, tracker updates   |
| `services/workflow/requests.ts`      | pending questions/permissions and the promises the engine awaits                |
| `services/worktrees.ts`              | `git worktree` under `<repo>/.claude/worktrees/<name>` (always)                 |
| `routes/ws.ts`                       | WebSocket: cards/runs/requests/jobs events + system stats every 2 s             |

## Time logger

`services/timelogger.ts` schedules and runs the daily Kimai entry (Logger tab); the deterministic scripts live in
`apps/logger`, secrets in `~/.claude/software-factory/logger.env`. See `docs/LOGGER.md`.

## Board sync rules

- Jira is the source of truth for **Backlog** and **Done** (status → column mapping in `config.yaml`).
- Cards in In Progress / Human Review / Pull Request that have a run, worktree or PR are *locally
  managed*: a sync only overrides them when Jira says the issue is done.
- Starting a workflow transitions the Jira issue to "In Progress" (best effort); creating a PR moves
  the card to Pull Request; refreshing a completed PR moves it to Done; "Archive" clears Done.
- Llama cards follow the same rules with Llama statuses.
