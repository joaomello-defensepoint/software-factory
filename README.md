# Software Factory

A local control room for AI-assisted development across the IndySoft repositories: a kanban synced
with Jira and Llama, a second brain fed by Fathom meetings and repository knowledge, user-level
multi-agent workflows (implementer → reviewer → devil's advocates → maestro) that run in git
worktrees, a tab for questions the agents ask you, and a system monitor.

Inspired by [Maestro](https://docs.runmaestro.ai) and [Paperclip](https://github.com/paperclipai/paperclip).

## Run it

```bash
n auto            # or: n 26.13.0 — Node 26 is required (node:sqlite)
npm install
cp .env.example .env   # no tokens needed: Jira and Fathom go through your claude.ai connectors
npm run dev            # server on :4100, web on http://localhost:5180
```

Integrations reuse what Claude Code already has: the claude.ai **Atlassian** and **Fathom** connectors
(called through a short headless session, see `apps/server/src/services/mcp.ts`), the **Llama** MCP
server from `~/.claude.json`, and the **az** CLI for Azure DevOps. Optional REST tokens in `.env`
switch Jira or Fathom to direct API calls.

Production-style single process: `npm run build && npm start` (serves the built web app on :4100).
Or double-click **Software Factory.command** on the Desktop (a copy of `scripts/start.command`): it builds,
starts the server, opens http://127.0.0.1:4100 in the browser, and stops when you close the Terminal window.

Stopping and restarting is safe: cards, runs, requests and settings live in `~/.claude/software-factory/factory.db`
and `config.yaml`, workflow definitions in `~/.claude/software-factory/workflows`. A workflow that was mid-run when
the server stopped (or crashed) is marked *interrupted* on the next boot. Open the card → Workflow run → **Resume
run**: the engine restarts at the step that was running and each role continues its own Claude session (same
context, same worktree). Chats and other sessions have a **Resume** button in the Sessions tab. If `npm install` warns that esbuild's install script was skipped,
run `npm install-scripts approve esbuild && npm rebuild esbuild` once.

Prerequisites already on this machine: `claude` (Claude Code CLI, logged in), `az` (logged in with
`az login --allow-no-subscriptions`), `code` (VS Code CLI), `git`.

## Tabs

- **Board**: Backlog · In Progress · Human Review · Pull Request · Done, drag and drop. Sync from
  Jira (`assignee = currentUser()`) and Llama, create tickets in either, open any card's worktree or
  project in VS Code, archive Done.
- **Second Brain**: the vaults in `~/Desktop/indysoft/SecondBrain`. Ingest Fathom meetings, index a
  repository's design docs into the wiki, lint, ask questions. Jobs stream live.
- **Workflows**: edit `workflow.yaml` and the role prompts in `~/.claude/software-factory/workflows`.
  See [docs/WORKFLOWS.md](docs/WORKFLOWS.md) for the design and the discussion points.
- **Sessions**: every Claude session the factory runs (workflow roles, brain jobs, chats) with live transcripts,
  plus the Claude Code history on this machine; start a free chat in any project or worktree, or resume an old one.
- **Requests**: questions and permission prompts from running agents; the card shows an orange badge.
- **System**: CPU, memory, disks, network, top processes, Claude processes.
- **Settings**: integration status, AI usage (Claude plan windows as reported during sessions, factory
  sessions/cost/tokens per period, Fathom and Jira activity) and `config.yaml` (projects, base branches, design docs,
  vault and ADO mapping, Jira status → column mapping, default workflow).

## Layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
