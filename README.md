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
- **Requests**: questions and permission prompts from running agents; the card shows an orange badge.
- **System**: CPU, memory, disks, network, top processes, Claude processes.
- **Settings**: integration status and `config.yaml` (projects, base branches, design docs, vault and
  ADO mapping, Jira status → column mapping).

## Layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
