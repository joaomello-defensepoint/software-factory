import fs from 'node:fs';
import { run } from './shell.js';

/** Opens a folder in VS Code using the `code` CLI (equivalent to `code .` inside that folder). */
export async function openInVsCode(folder: string): Promise<{ ok: boolean; message: string }> {
  if (!fs.existsSync(folder)) return { ok: false, message: `Folder does not exist: ${folder}` };
  const res = await run('code', [folder], { timeoutMs: 15_000 });
  if (res.code !== 0) return { ok: false, message: res.stderr || `code exited with ${res.code}` };
  return { ok: true, message: `Opened ${folder} in VS Code` };
}
