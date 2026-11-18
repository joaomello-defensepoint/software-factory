import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

// .env lives at the repo root; loaded once.
dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true } as any);

const home = os.homedir();

export const SF_HOME = process.env.SF_HOME || path.join(home, '.claude', 'software-factory');
export const WORKFLOWS_DIR = path.join(SF_HOME, 'workflows');
export const LOGS_DIR = path.join(SF_HOME, 'logs');
export const UPLOADS_DIR = path.join(SF_HOME, 'uploads');
/** Secrets for the time logger (ADO/Kimai/Llama/GCal/Slack), KEY=VALUE lines, chmod 600; never inside the repo. */
export const LOGGER_ENV_PATH = path.join(SF_HOME, 'logger.env');
/** Per-run working folders of the time logger (preview.json, desc.txt …). */
export const LOGGER_RUNS_DIR = path.join(SF_HOME, 'logger');
/** The deterministic logger scripts (lt.py, gcal_meetings.py, slack_context.py). */
export const LOGGER_SCRIPTS_DIR = path.join(REPO_ROOT, 'apps', 'logger');
export const DB_PATH = path.join(SF_HOME, 'factory.db');
export const CONFIG_PATH = path.join(SF_HOME, 'config.yaml');
export const CLAUDE_HOME = path.join(home, '.claude');
export const CLAUDE_JSON = path.join(home, '.claude.json');

export const DEFAULT_VAULT_ROOT = process.env.SF_BRAIN_VAULT || path.join(home, 'Desktop', 'indysoft', 'SecondBrain');
export const DEFAULT_PROJECTS_ROOT = path.join(home, 'Desktop', 'indysoft');

export const PORT = Number(process.env.PORT || 4100);

/** Emails that identify the user across trackers (Llama member lookup, display). */
export const IDENTITY_EMAILS = (process.env.SF_IDENTITY_EMAILS || 'joao.mello@indysoft.com,joao@defensepoint.com').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export type IntegrationMode = 'mcp' | 'rest';

export const env = {
  jira: {
    baseUrl: (process.env.JIRA_BASE_URL || 'https://indysoftco.atlassian.net').replace(/\/$/, ''),
    email: process.env.JIRA_EMAIL || '',
    token: process.env.JIRA_API_TOKEN || '',
    /** mcp = through the user's authorized claude.ai Atlassian connector (default); rest = API token. */
    mode: ((process.env.JIRA_MODE as IntegrationMode) || (process.env.JIRA_API_TOKEN ? 'rest' : 'mcp')) as IntegrationMode,
    /** Site UUID, hostname or URL accepted by the Atlassian MCP; defaults to the hostname of JIRA_BASE_URL. */
    cloudId: process.env.JIRA_CLOUD_ID || new URL(process.env.JIRA_BASE_URL || 'https://indysoftco.atlassian.net').hostname,
    mcpPrefix: process.env.JIRA_MCP_PREFIX || 'mcp__claude_ai_Atlassian_MCP__',
    jql: process.env.JIRA_SYNC_JQL || 'assignee in (currentUser(), \"joao.mello@indysoft.com\") AND statusCategory != Done AND issuetype != Epic ORDER BY updated DESC',
    project: process.env.JIRA_DEFAULT_PROJECT || 'IWC',
  },
  fathom: {
    apiKey: process.env.FATHOM_API_KEY || '',
    mode: ((process.env.FATHOM_MODE as IntegrationMode) || (process.env.FATHOM_API_KEY ? 'rest' : 'mcp')) as IntegrationMode,
    mcpPrefix: process.env.FATHOM_MCP_PREFIX || 'mcp__claude_ai_FathomMCP__',
  },
  ado: { orgUrl: (process.env.ADO_ORG_URL || '').replace(/\/$/, ''), project: process.env.ADO_PROJECT || '' },
  llama: {
    org: process.env.LLAMA_ORG || 'indysoft',
    project: process.env.LLAMA_PROJECT || 'EAM',
    apiUrl: process.env.LLAMA_API_URL || '',
    apiKey: process.env.LLAMA_API_KEY || '',
  },
};

export function ensureDirs(): void {
  for (const d of [SF_HOME, WORKFLOWS_DIR, LOGS_DIR, UPLOADS_DIR, LOGGER_RUNS_DIR]) fs.mkdirSync(d, { recursive: true });
}

/** Reads the env block of a user-level MCP server from ~/.claude.json (e.g. the Llama API key) without exposing the file elsewhere. */
export function readMcpServerEnv(name: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    const server = raw?.mcpServers?.[name];
    return (server?.env as Record<string, string>) || {};
  } catch {
    return {};
  }
}

/** Project-scoped MCP servers configured in ~/.claude.json for a given project path (used to pass them to worktree sessions). */
export function readProjectMcpServers(projectPath: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    return (raw?.projects?.[projectPath]?.mcpServers as Record<string, unknown>) || {};
  } catch {
    return {};
  }
}
