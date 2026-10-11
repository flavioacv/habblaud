// Retoma uma sessão ociosa do Claude Code em modo headless, preservando o session ID e as configurações da conta.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export const CLAUDE_RESUME_TIMEOUT_MS = 30 * 60_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_MAX = 300;

export interface ClaudeResumeJob {
  configDir: string;
  cwd: string;
  session: string;
  text: string;
}

export type ClaudeResumeResult = { ok: true } | { ok: false; error: string };
export type ClaudeResumeRunner = (job: ClaudeResumeJob) => Promise<ClaudeResumeResult>;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findClaudeBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.HABBLAUD_CLAUDE_BIN?.trim();
  if (explicit) return executable(explicit) ? explicit : undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const path = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (executable(path)) return path;
  }
  return undefined;
}

export function claudeResumeArgs(session: string, text: string): string[] {
  return ['--print', '--resume', session, '--output-format', 'json', text];
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

export function createClaudeResumeRunner(bin: string): ClaudeResumeRunner {
  return (job) => new Promise((resolve) => {
    if (!SESSION_ID.test(job.session)) return resolve({ ok: false, error: 'id de sessão do Claude Code inválido' });
    if (![job.configDir, job.cwd].every(isAbsolute)) return resolve({ ok: false, error: 'pasta da conta ou do projeto do Claude Code inválida' });
    if (job.text.includes('\0')) return resolve({ ok: false, error: 'a mensagem contém caracteres inválidos para o Claude Code' });

    const env = { ...process.env, CLAUDE_CONFIG_DIR: job.configDir };
    let stderr = '';
    let child: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (result: ClaudeResumeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(bin, claudeResumeArgs(job.session, job.text), { cwd: job.cwd, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      timer = setTimeout(() => {
        child?.kill('SIGTERM');
        finish({ ok: false, error: 'a retomada do Claude Code passou de 30 min' });
      }, CLAUDE_RESUME_TIMEOUT_MS);
      timer.unref?.();
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 16_000) stderr += chunk.toString('utf8').slice(0, 16_000 - stderr.length);
      });
      child.once('error', (err: NodeJS.ErrnoException) => {
        finish({ ok: false, error: err.code === 'ENOENT' || err.code === 'EACCES' ? `não consegui rodar o Claude Code (${bin})` : err.message });
      });
      child.once('close', (code) => {
        finish(code === 0 ? { ok: true } : { ok: false, error: firstLine(stderr) ?? `claude --resume falhou (código ${String(code ?? '?')})` });
      });
    } catch {
      finish({ ok: false, error: 'não consegui iniciar a retomada do Claude Code' });
    }
  });
}
