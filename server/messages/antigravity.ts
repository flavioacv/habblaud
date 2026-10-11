// Mensagens a sessões Antigravity pelo `agy agentapi send-message`.
// O executável injeta o conteúdo na conversa pelo conversationId; sem shell e com prazo limitado.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** Prazo do `agy agentapi send-message`. */
export const SEND_TIMEOUT_MS = 20_000;
const ERROR_MAX = 300;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AntigravityMessageJob {
  /** ID da conversa observado pelo AntigravitySource. */
  conversationId: string;
  /** Texto que será injetado na conversa. */
  text: string;
}

export type AntigravityMessageResult = { ok: true } | { ok: false; error: string };
export type AntigravityMessageRunner = (job: AntigravityMessageJob) => Promise<AntigravityMessageResult>;

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Executável do Antigravity: HABBLAUD_AGY_BIN ou `agy` no PATH. */
export function findAntigravityBin(
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (path: string) => boolean = canExecute,
): string | undefined {
  const explicit = env.HABBLAUD_AGY_BIN?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : undefined;
  const name = process.platform === 'win32' ? 'agy.exe' : 'agy';
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  const home = env.HOME?.trim() || homedir();
  const fallback = join(home, '.local', 'bin', name);
  return isExecutable(fallback) ? fallback : undefined;
}

/** Roda `agy agentapi send-message <conversationId> <text>` sem interpretar o texto como shell. */
export function createAntigravityMessageRunner(
  bin: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): AntigravityMessageRunner {
  const timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS;
  return (job) =>
    new Promise<AntigravityMessageResult>((done) => {
      if (!CONVERSATION_ID.test(job.conversationId)) {
        return done({ ok: false, error: 'id de conversa do Antigravity inválido' });
      }
      const env = { ...(opts.env ?? process.env) };
      try {
        execFile(
          bin,
          ['agentapi', 'send-message', job.conversationId, job.text],
          { env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' },
          (err, stdout, stderr) => {
            if (err) {
              const e = err as NodeJS.ErrnoException & { killed?: boolean };
              if (e.killed) return done({ ok: false, error: `o agy agentapi não respondeu em ${Math.round(timeoutMs / 1_000)} s` });
              if (e.code === 'ENOENT' || e.code === 'EACCES') return done({ ok: false, error: `não consegui rodar o Antigravity (${bin})` });
              return done({ ok: false, error: firstLine(stderr) ?? `o agy agentapi falhou (código ${String(e.code ?? '?')})` });
            }
            let result: unknown;
            try {
              result = JSON.parse(stdout);
            } catch {
              return done({ ok: false, error: 'o agy agentapi retornou uma resposta inválida' });
            }
            const response = result && typeof result === 'object' ? (result as { response?: unknown; error?: unknown }) : undefined;
            const sendMessage = response?.response && typeof response.response === 'object'
              ? (response.response as { sendMessage?: unknown }).sendMessage
              : undefined;
            if (response?.error || !sendMessage || typeof sendMessage !== 'object') {
              return done({ ok: false, error: firstLine(typeof response?.error === 'string' ? response.error : stderr) ?? 'o Antigravity não aceitou a mensagem' });
            }
            const recipientId = (sendMessage as { recipientId?: unknown }).recipientId;
            if (recipientId !== job.conversationId) {
              return done({ ok: false, error: 'o Antigravity confirmou um destinatário diferente da conversa solicitada' });
            }
            done({ ok: true });
          },
        );
      } catch {
        // Argumentos com NUL não podem ser passados ao processo.
        done({ ok: false, error: 'a mensagem contém caracteres inválidos para o Antigravity' });
      }
    });
}

function firstLine(value: string | undefined): string | undefined {
  const line = (value ?? '').split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}
