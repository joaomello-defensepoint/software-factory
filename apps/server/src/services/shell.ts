import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a command without a shell; never throws, returns the exit code. */
export async function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err: any) {
    return { stdout: String(err?.stdout ?? ''), stderr: String(err?.stderr ?? err?.message ?? ''), code: typeof err?.code === 'number' ? err.code : 1 };
  }
}

export async function git(repo: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  return run('git', ['-C', repo, ...args], { timeoutMs });
}

/** Streams a long-running command line by line. */
export function stream(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine: (line: string, streamName: 'stdout' | 'stderr') => void },
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) } });
    const wire = (name: 'stdout' | 'stderr') => {
      let buf = '';
      child[name]?.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          opts.onLine(buf.slice(0, idx), name);
          buf = buf.slice(idx + 1);
        }
      });
      child[name]?.on('end', () => {
        if (buf) opts.onLine(buf, name);
      });
    };
    wire('stdout');
    wire('stderr');
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (e) => {
      opts.onLine(String(e), 'stderr');
      resolve(1);
    });
  });
}
