# Workflows: the maestro loop and how to refine it

This is the design discussion for section 2.3 of the brief, written as a proposal you can edit.
Everything below is implemented in `apps/server/src/services/workflow/` and the default definition
lives at `~/.claude/software-factory/workflows/maestro-loop/` (user-level, as requested).

## What a workflow is

A workflow is a folder:

```
~/.claude/software-factory/workflows/<id>/
  workflow.yaml        # ordered steps, max iterations, default model
  roles/<role>.md      # one file per role: Claude Code agent-file format (frontmatter + prompt)
```

Role files use the same frontmatter as `~/.claude/agents/*.md` (`name`, `description`, `model`,
`tools`), so a role can be copied into `~/.claude/agents` and used from a normal Claude Code
session too. The Workflows tab edits both files in place; "Duplicate" clones a workflow so you can
experiment without touching the default.

Step kinds:

| kind       | what happens                                                                                   |
|------------|------------------------------------------------------------------------------------------------|
| `agent`    | one role runs one Claude Code session in the worktree with the rendered prompt                  |
| `debate`   | two or more roles run in parallel, then exchange positions for `rounds` rounds                  |
| `decision` | one role answers with structured output: `done`, `rework` (+instructions) or `ask_human`        |
| `gate`     | pauses until you press Continue in the Requests tab                                             |
| `shell`    | runs a command in the worktree (the default workflow commits here)                              |

Prompts are templates: `{{ticket.*}}`, `{{project.*}}`, `{{brain}}` (vault index + synthesis
dashboards), `{{diff}}`, `{{diffStat}}`, `{{iteration}}`, `{{feedback}}` (the maestro's rework
instructions) and `{{steps.<id>.output}}`.

## The default loop (maestro-loop)

```
implement ──► review ──► challenge (2 advocates, debate) ──► decide ──► finalize (commit)
    ▲                                                          │
    └────────────── rework (maestro instructions) ◄────────────┘   max 3 iterations
                                                               └──► ask_human → Requests tab → back to implement
```

1. **Implementer** (Opus, can edit) reads the design docs listed for the project in
   `config.yaml`, the vault knowledge pack, and implements the ticket. It may ask you a question
   through `AskUserQuestion`; the question shows up in the Requests tab and on the card.
   The implementer's session is *resumed* on rework, so it keeps its own context.
2. **Reviewer** (read-only) judges the diff strictly against the design docs and ADRs and ends
   with `VERDICT: approve|changes_requested`.
3. **Devil's advocates** run in parallel and then debate for one round:
   - *advocate-design*: wrong abstraction, duplication, semantic drift, coupling, "is this even the
     right change?"
   - *advocate-correctness*: edge cases, data integrity, migration safety, test theatre, security
     and tenant boundaries, develop vs develop-conversion divergence.
   Each must end with `BLOCKING: yes|no`, and must respond point by point to the other.
4. **Maestro** reads everything, verifies claims that would change the decision, and returns a
   structured verdict. `rework` sends numbered instructions back to the implementer; `ask_human`
   posts a question with options; `done` finishes.
5. **finalize** stages and commits inside the worktree. The card moves to **Human Review**, you
   open the worktree in VS Code from the card, and press *Create Azure DevOps PR* when satisfied.

## Design choices worth discussing

**Maestro as code, Claude as judge.** The loop itself is deterministic Node code; Claude only
makes the content decisions. The alternative (a single Claude "maestro" session spawning
subagents) is simpler but you lose: visibility of each step, resumable implementer sessions,
per-step cost, the human-in-the-loop pause, and the ability to edit the loop in YAML. The
Claude Agent SDK also doesn't let subagents ask the human, which the brief needs.

**Two advocates, one debate round.** More rounds mostly produce agreement theatre. The value is in
the first independent pass plus one forced confrontation. If you want a harsher regime, raise
`rounds` or add a third advocate (e.g. *advocate-ux* for the ReactApp) in the YAML.

**Bounded loop.** `maxIterations: 3`. When the budget is exhausted the run still finishes and
hands the maestro's unapplied instructions to you in the run summary, rather than looping.

**Permissions.** Each role's `tools` list is pre-approved; edit tools are removed for read-only
roles. Anything else an agent tries (e.g. a tool not in its list) becomes a *permission* request in
the Requests tab, where you can allow once, allow for the run, or deny. Questions and permissions
both mark the card with an orange badge.

**Project context.** The worktree is a full checkout of the branch, so the branch's own
`CLAUDE.md`, `.claude/rules`, `.claude/agents` and skills load automatically. Project-scoped MCP
servers from `~/.claude.json` (e.g. `indyknow`, `flecha` for EnterpriseWeb) are passed to each
session explicitly because they are keyed by the main checkout path. One caveat: Claude Code also
reads `CLAUDE.md` files from parent folders, so a worktree under `<repo>/.claude/worktrees/` also
sees the main checkout's `CLAUDE.md`; the role prompts state that the worktree's own files win.

**Branch naming** follows what the repos already use: `Feature/IWC-####` / `Defect/IWC-####`
(EnterpriseWeb), `Task/IWC-####` (Kiosk), `custeqwork-##-slug` (NewCustomerPortal). Override per
project with `branchTemplate` / `defectBranchTemplate` in `config.yaml`.

## Ideas for the next iteration

- A `tests` shell step between implement and review (`make test` / `npm test`) so the reviewer
  sees real results instead of the implementer's claims.
- Reuse the project-level agents that already exist in `develop-conversion`
  (`backend-reviewer`, `frontend-reviewer`, `review-core` rubric) by letting a role declare
  `projectAgent: backend-reviewer` and falling back to the user-level prompt when absent.
- A PR-description role that fills `docs/pull_request_template.md` (what `/ado-pr` does today).
- Cost guardrails per run (`maxBudgetUsd` is already plumbed through the runner).
