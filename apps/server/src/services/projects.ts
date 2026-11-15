import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Project } from '@sf/shared';
import { CONFIG_PATH, DEFAULT_PROJECTS_ROOT, DEFAULT_VAULT_ROOT, ensureDirs } from '../config.js';
import { git } from './shell.js';
import { listWorktrees } from './worktrees.js';

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  baseBranches: string[];
  designDocs: string[];
  vault: string | null;
  ado: { project: string; repo: string } | null;
  jiraProject: string | null;
  /** Relative folder for worktrees. Defaults to .claude/worktrees (the user's rule). */
  worktreeRoot?: string;
}

export interface FactoryConfig {
  version: 1;
  projects: ProjectConfig[];
  board: {
    /** Jira status names that land in each column on sync (case-insensitive). */
    jiraStatusToColumn: Record<string, string[]>;
    /** Jira transition names to attempt when a card enters a column (optional). */
    columnToJiraTransition: Partial<Record<string, string>>;
  };
}

const vault = (name: string): string => path.join(DEFAULT_VAULT_ROOT, name);
const repo = (name: string): string => path.join(DEFAULT_PROJECTS_ROOT, name);

export function defaultConfig(): FactoryConfig {
  return {
    version: 1,
    projects: [
      {
        id: 'enterprise-web',
        name: 'IndySoft.EnterpriseWeb',
        path: repo('IndySoft.EnterpriseWeb'),
        baseBranches: ['develop', 'develop-conversion'],
        designDocs: [
          'CLAUDE.md',
          'docs/api/architecture/decision-records.md',
          'docs/api/coding-guidelines.md',
          'docs/domain',
          'docs/software-development-lifecycle.md',
          'docs/UX_FIDELITY_SPEC.md',
          '.claude/Rules',
          '.claude/rules',
          '.claude/review-core',
          'src/IndySoft.Enterprise.ReactApp/docs/ARCHITECTURE.md',
          'src/IndySoft.Enterprise.ReactApp/docs/COMPONENTS.md',
          'src/IndySoft.Enterprise.ReactApp/CLAUDE.md',
          'docs/pull_request_template.md',
        ],
        vault: vault('eam'),
        ado: { project: 'Calibrations.com-Windows', repo: 'IndySoft.EnterpriseWeb' },
        jiraProject: 'IWC',
      },
      {
        id: 'enterprise-kiosk',
        name: 'IndySoft.EnterpriseKiosk',
        path: repo('IndySoft.EnterpriseKiosk'),
        baseBranches: ['develop', 'master'],
        designDocs: ['README.md', 'docs/eam-integration.md', 'docs/custom-commands.md', 'docs/environment-variables.md', 'docs/kiosk-app-config.md', 'guidelines', '.claude/agents/kiosk-dev.md'],
        vault: vault('kiosk'),
        ado: { project: 'Calibrations.com-Windows', repo: 'IndySoft.EnterpriseKiosk' },
        jiraProject: 'IWC',
      },
      {
        id: 'new-customer-portal',
        name: 'IndySoft.NewCustomerPortal',
        path: repo('IndySoft.NewCustomerPortal'),
        baseBranches: ['development', 'master'],
        designDocs: [
          'CLAUDE.md',
          'docs/architecture-decisions.md',
          'docs/parallel-implementation.md',
          'docs/STATUS.md',
          'docs/glossary.md',
          'docs/http-bridges-contracts.md',
          'docs/enterprise-core-services-reference.md',
          '.claude/rules',
        ],
        vault: vault('customer-portal'),
        ado: { project: 'Enterprise Customer Portal', repo: 'IndySoft.NewCustomerPortal' },
        jiraProject: null,
      },
      {
        id: 'enterprise-bff',
        name: 'IndySoft.EnterpriseBff',
        path: repo('IndySoft.EnterpriseBff'),
        baseBranches: ['master'],
        designDocs: ['README.md', 'ARCHITECTURE.md', 'CONFIGURATION.md'],
        vault: null,
        ado: { project: 'WebAuth2.0', repo: 'IndySoft.EnterpriseBff' },
        jiraProject: null,
      },
    ],
    board: {
      // IWC flow: NEW/READY → Triaged → In Progress → Code Review → QA Ready → Done
      jiraStatusToColumn: {
        backlog: ['NEW', 'READY', 'Triaged', 'To Do', 'Open', 'Backlog', 'Selected for Development'],
        in_progress: ['In Progress'],
        human_review: ['In Review'],
        pull_request: ['Code Review', 'Pull Request', 'PR Open'],
        done: ['QA Ready', 'Done', 'Closed', 'Resolved'],
      },
      // Transition *names* (not target statuses) attempted when a card enters a column; best effort.
      columnToJiraTransition: { in_progress: 'In Progress', pull_request: 'Ready for Code Review' },
    },
  };
}

let cache: FactoryConfig | null = null;

export function loadConfig(): FactoryConfig {
  if (cache) return cache;
  ensureDirs();
  if (!fs.existsSync(CONFIG_PATH)) {
    cache = defaultConfig();
    fs.writeFileSync(CONFIG_PATH, YAML.stringify(cache), 'utf8');
    return cache;
  }
  const parsed = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as FactoryConfig;
  const base = defaultConfig();
  cache = { ...base, ...parsed, board: { ...base.board, ...(parsed.board || {}) }, projects: parsed.projects?.length ? parsed.projects : base.projects };
  return cache;
}

export function saveConfig(next: FactoryConfig): void {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, YAML.stringify(next), 'utf8');
  cache = next;
}

export function getProjectConfig(id: string): ProjectConfig | undefined {
  return loadConfig().projects.find((p) => p.id === id);
}

export async function listProjects(withGit = true): Promise<Project[]> {
  const cfg = loadConfig();
  return Promise.all(
    cfg.projects.map(async (p) => {
      const exists = fs.existsSync(p.path);
      const out: Project = {
        id: p.id,
        name: p.name,
        path: p.path,
        baseBranches: p.baseBranches,
        designDocs: p.designDocs,
        vaultPath: p.vault,
        ado: p.ado,
        jiraProject: p.jiraProject,
        exists,
      };
      if (exists && withGit) {
        out.currentBranch = (await git(p.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || null;
        out.worktrees = await listWorktrees(p.path);
      }
      return out;
    }),
  );
}

/** Design docs that actually exist inside a given checkout (worktree), as relative paths. */
export function existingDesignDocs(p: ProjectConfig, checkout: string): string[] {
  return p.designDocs.filter((rel) => fs.existsSync(path.join(checkout, rel)));
}

/** Guess the project for a card based on its key/labels/title. Falls back to null. */
export function guessProjectForKey(key: string | null, title: string): string | null {
  const cfg = loadConfig();
  const t = `${key ?? ''} ${title}`.toLowerCase();
  if (/kiosk/.test(t)) return cfg.projects.find((p) => p.id === 'enterprise-kiosk')?.id ?? null;
  if (/custeqwork|customer portal|portal/.test(t)) return cfg.projects.find((p) => p.id === 'new-customer-portal')?.id ?? null;
  if (/bff|oidc|auth/.test(t)) return cfg.projects.find((p) => p.id === 'enterprise-bff')?.id ?? null;
  if (/^iwc-|^eam-/.test(t)) return cfg.projects.find((p) => p.id === 'enterprise-web')?.id ?? null;
  return null;
}
