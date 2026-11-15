// Shared contracts between the Software Factory server and web app.

export const COLUMNS = ['backlog', 'in_progress', 'human_review', 'pull_request', 'done'] as const;
export type ColumnId = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<ColumnId, string> = {
  backlog: 'Backlog',
  in_progress: 'In Progress',
  human_review: 'Human Review',
  pull_request: 'Pull Request',
  done: 'Done',
};

export type CardSource = 'jira' | 'llama' | 'local';

export interface Card {
  id: string;
  source: CardSource;
  /** External key, e.g. IWC-9463 or EAM-123. Null for local-only cards. */
  key: string | null;
  url: string | null;
  title: string;
  description: string;
  issueType: string | null;
  priority: string | null;
  labels: string[];
  epicKey: string | null;
  /** Status as reported by the external tracker at last sync. */
  externalStatus: string | null;
  column: ColumnId;
  /** Sort position inside the column (lower first). */
  position: number;
  /** Local project id (see Project) this card is being worked on. */
  projectId: string | null;
  baseBranch: string | null;
  branch: string | null;
  worktreePath: string | null;
  /** Active or last workflow run. */
  runId: string | null;
  runStatus: RunStatus | null;
  pendingRequests: number;
  prUrl: string | null;
  prId: number | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  /** Branches a worktree may be based on; the first is the default. */
  baseBranches: string[];
  /** Relative paths (from project root) to design docs / architecture folders agents must follow. */
  designDocs: string[];
  /** Second-brain vault that holds knowledge for this project (absolute path). */
  vaultPath: string | null;
  ado: { project: string; repo: string } | null;
  jiraProject: string | null;
  exists: boolean;
  currentBranch?: string | null;
  worktrees?: WorktreeInfo[];
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
}

export interface SystemStats {
  ts: string;
  hostname: string;
  platform: string;
  uptimeSec: number;
  cpu: {
    model: string;
    cores: number;
    loadPercent: number;
    perCorePercent: number[];
    load1: number;
    load5: number;
    load15: number;
    tempC: number | null;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    availableBytes: number;
    swapUsedBytes: number;
    swapTotalBytes: number;
  };
  disks: Array<{ fs: string; mount: string; type: string; sizeBytes: number; usedBytes: number; usePercent: number }>;
  network: { rxBytesPerSec: number; txBytesPerSec: number };
  battery: { hasBattery: boolean; percent: number | null; isCharging: boolean | null } | null;
  topProcesses: Array<{ pid: number; name: string; cpuPercent: number; memPercent: number }>;
  claudeProcesses: number;
}

// ---------- Workflows ----------

export type RoleId = string;

export interface WorkflowRole {
  id: RoleId;
  /** Display name, e.g. "Implementer". */
  name: string;
  /** Claude model alias or id, e.g. "opus", "sonnet". Null = inherit workflow default. */
  model: string | null;
  /** Tools the role may use; empty = SDK default set. */
  tools: string[];
  /** Markdown system prompt (body of the role file). */
  prompt: string;
  /** Where this role is persisted (absolute path), informative only. */
  file?: string;
}

export type StepKind = 'agent' | 'debate' | 'decision' | 'gate' | 'shell';

export interface WorkflowStep {
  id: string;
  name: string;
  kind: StepKind;
  /** Role(s) executing this step. "debate" uses 2+ roles, "agent"/"decision" use one. */
  roles: RoleId[];
  /** Prompt template rendered with the run context (ticket, diff, previous step outputs). */
  prompt: string;
  /** For "debate": number of rounds the roles exchange. */
  rounds?: number;
  /** For "decision": the JSON schema key names expected in the verdict. */
  outcomes?: string[];
  /** Max turns per agent session in this step. */
  maxTurns?: number;
  /** Resume the same Claude session for this role across iterations (keeps context). */
  resumeSession?: boolean;
  /** For "shell": command executed in the worktree. */
  command?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  defaultModel: string;
  /** How many times the maestro may send work back to the implementer. */
  maxIterations: number;
  roles: WorkflowRole[];
  steps: WorkflowStep[];
  /** Source directory of the definition (absolute path). */
  dir?: string;
}

export type RunStatus = 'queued' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkflowRun {
  id: string;
  cardId: string;
  workflowId: string;
  projectId: string;
  status: RunStatus;
  currentStep: string | null;
  iteration: number;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  summary: string | null;
}

export type RunEventType =
  | 'run_started'
  | 'run_finished'
  | 'step_started'
  | 'step_finished'
  | 'iteration'
  | 'assistant_text'
  | 'tool_use'
  | 'tool_result'
  | 'decision'
  | 'human_request'
  | 'human_answer'
  | 'human_note'
  | 'shell'
  | 'error'
  | 'log';

export interface RunEvent {
  id: number;
  runId: string;
  ts: string;
  type: RunEventType;
  step: string | null;
  role: string | null;
  /** Short human-readable line for the activity feed. */
  text: string;
  /** Structured payload (tool input, verdict, usage...). */
  data: unknown;
}

export interface HumanRequestOption {
  label: string;
  description?: string;
}

export interface HumanRequestQuestion {
  question: string;
  header?: string;
  options: HumanRequestOption[];
  multiSelect?: boolean;
}

export interface HumanRequest {
  id: string;
  runId: string;
  cardId: string;
  cardKey: string | null;
  cardTitle: string;
  step: string | null;
  role: string | null;
  /** "question" = the agent asked the human; "permission" = a tool call needs approval. */
  kind: 'question' | 'permission';
  toolName: string | null;
  toolInput: unknown;
  /** Raw AskUserQuestion input or a free-form question from the engine. */
  questions: HumanRequestQuestion[];
  status: 'pending' | 'answered' | 'dismissed';
  answers: Record<string, string> | null;
  createdAt: string;
  answeredAt: string | null;
}

/** A steering note from the human to the agents working a card. */
export interface Note {
  id: string;
  cardId: string;
  runId: string | null;
  ts: string;
  text: string;
  /** Session keys ("step:role") that already received this note mid-run. */
  delivered: string[];
}

// ---------- Second brain ----------

export interface Job {
  id: string;
  kind: string;
  title: string;
  status: 'running' | 'succeeded' | 'failed';
  lines: string[];
  result: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BrainVault {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  rawCount: number;
  wikiCount: number;
  lastLog: string | null;
}

export interface BrainPage {
  path: string;
  title: string;
  section: 'sources' | 'entities' | 'concepts' | 'synthesis' | 'other';
  updated: string | null;
}

export interface FathomMeetingSummary {
  recordingId: string;
  title: string;
  url: string;
  createdAt: string;
  recordedBy: string | null;
  invitees: string[];
  durationMin: number | null;
  /** Whether a raw export already exists in the vault. */
  ingested: boolean;
}

// ---------- Realtime ----------

export type ServerEvent =
  | { type: 'cards.changed' }
  | { type: 'projects.changed' }
  | { type: 'run.event'; event: RunEvent }
  | { type: 'run.changed'; run: WorkflowRun }
  | { type: 'request.created'; request: HumanRequest }
  | { type: 'request.answered'; request: HumanRequest }
  | { type: 'note.created'; note: Note }
  | { type: 'system.stats'; stats: SystemStats }
  | { type: 'brain.changed'; vaultId: string }
  | { type: 'job.log'; jobId: string; line: string }
  | { type: 'job.done'; jobId: string; ok: boolean; message?: string }
  | { type: 'toast'; level: 'info' | 'success' | 'warning' | 'error'; message: string };

export interface IntegrationStatus {
  jira: { configured: boolean; mode: 'mcp' | 'rest'; email: string | null; baseUrl: string | null; project: string | null };
  fathom: { configured: boolean; mode: 'mcp' | 'rest' };
  ado: { configured: boolean; orgUrl: string | null; loggedIn: boolean | null };
  llama: { configured: boolean; org: string | null; project: string | null };
  claude: { version: string | null };
}
