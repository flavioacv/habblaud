// Mensagens pelo escritório para as sessões do Codex. Sessão ocupada: `codex queue` põe a mensagem na fila. Sessão
// ociosa: `codex exec resume` abre um novo turno na mesma conversa, inclusive quando o turno anterior foi interrompido.
// Os comandos rodam no Mac (host), com o CODEX_HOME da conta:
// - modo Node: o próprio servidor roda o comando (binário HABBLAUD_CODEX_BIN ou `codex` do PATH);
// - Docker: o auxiliar do host (scripts/codex-bridge.ts, npm run codex:bridge) busca as mensagens em
//   POST /api/codex/bridge/poll, roda o mesmo comando e confirma em POST /api/codex/bridge/ack.
// Sem shell e com prazo; nunca passa -c, --enable, --disable nem --no-daemon (mudariam a configuração ou o servidor
// da sessão). `queue` confirma que entrou na fila; `exec resume` confirma quando o novo turno termina. Erros trazem a
// primeira linha do stderr. Se o servidor compartilhado do Codex (daemon) não estiver no ar, o próprio comando o sobe.
// Node puro e sem dependências: também é importado pelo auxiliar do host (via tsx).
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Prazo de um `codex queue`. */
export const QUEUE_TIMEOUT_MS = 20_000;
/** Prazo máximo de uma retomada não interativa. */
export const RESUME_TIMEOUT_MS = 30 * 60_000;
/** Id de thread do Codex (UUID; `codex queue --thread` também aceitaria nomes, mas o Habblaud só manda ids). */
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_MAX = 300;

export interface CodexQueueJob {
  /** Pasta CODEX_HOME da conta (caminho do host). */
  codexHome: string;
  /** Id do thread (AgentInfo.sessionId do agente do Codex). */
  thread: string;
  /** O texto como foi digitado. */
  text: string;
  /** Abre um novo turno na mesma conversa ociosa em vez de apenas enfileirar. */
  resume?: boolean;
}

export type CodexQueueResult = { ok: true } | { ok: false; error: string };
export type CodexQueueRunner = (job: CodexQueueJob) => Promise<CodexQueueResult>;

function canExecute(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Nome do binário no PATH. No Windows, só o `codex.exe`: o `codex` sem extensão e o `codex.cmd` que o npm põe ao lado
 * são scripts, e o execFile (sem shell) não os roda.
 */
export const CODEX_BIN_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';

/** Binário do Codex: HABBLAUD_CODEX_BIN (caminho de um executável) ou `codex` no PATH. undefined = não achou. */
export function findCodexBin(env: NodeJS.ProcessEnv, isExecutable: (p: string) => boolean = canExecute): string | undefined {
  const explicit = env.HABBLAUD_CODEX_BIN?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, CODEX_BIN_NAME);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

/** Argumentos de `codex queue` (com "=": um texto que começa com "-" nunca vira uma opção). */
export function queueArgs(thread: string, text: string): string[] {
  return ['queue', `--thread=${thread}`, `--message=${text}`];
}

/** Argumentos para criar um turno headless na conversa existente. */
export function resumeArgs(thread: string, text: string): string[] {
  return ['exec', 'resume', '--json', thread, text];
}

/** Primeira linha não vazia (o Codex escreve o erro como "Error: ..."), cortada. */
export function firstLine(s: string | undefined): string | undefined {
  const line = (s ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

/** Roda `codex queue` com o binário dado. Nunca rejeita: falha vira `{ok: false, error}`. */
export function createCodexQueueRunner(bin: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): CodexQueueRunner {
  const timeoutMs = opts.timeoutMs ?? QUEUE_TIMEOUT_MS;
  return (job) =>
    new Promise<CodexQueueResult>((done) => {
      if (!THREAD_ID.test(job.thread)) return done({ ok: false, error: 'id de thread do Codex inválido' });
      if (!isAbsolute(job.codexHome)) return done({ ok: false, error: 'pasta da conta do Codex inválida' });
      const env = { ...(opts.env ?? process.env), CODEX_HOME: job.codexHome };
      if (job.resume) {
        let child: ReturnType<typeof spawn> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stderr = '';
        let settled = false;
        const finish = (result: CodexQueueResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          done(result);
        };
        timer = setTimeout(() => {
          child?.kill('SIGTERM');
          finish({ ok: false, error: `a retomada do Codex passou de ${Math.round(RESUME_TIMEOUT_MS / 60_000)} min` });
        }, RESUME_TIMEOUT_MS);
        timer.unref?.();
        try {
          const spawned = spawn(bin, resumeArgs(job.thread, job.text), { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
          child = spawned;
          spawned.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < 16_000) stderr += chunk.toString('utf8').slice(0, 16_000 - stderr.length);
          });
          spawned.once('error', (err: NodeJS.ErrnoException) => {
            finish({ ok: false, error: err.code === 'ENOENT' || err.code === 'EACCES' ? `não consegui rodar o Codex (${bin})` : err.message });
          });
          spawned.once('close', (code) => {
            finish(code === 0 ? { ok: true } : { ok: false, error: firstLine(stderr) ?? `codex exec resume falhou (código ${String(code ?? '?')})` });
          });
        } catch {
          finish({ ok: false, error: 'a mensagem tem caracteres que não dá para mandar ao Codex' });
        }
        return;
      }
      try {
        execFile(bin, queueArgs(job.thread, job.text), { env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' }, (err, _stdout, stderr) => {
          if (!err) return done({ ok: true });
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.killed) return done({ ok: false, error: `o codex queue não respondeu em ${Math.round(timeoutMs / 1_000)} s (a mensagem pode ter entrado na fila mesmo assim)` });
          if (e.code === 'ENOENT' || e.code === 'EACCES') return done({ ok: false, error: `não consegui rodar o Codex (${bin})` });
          done({ ok: false, error: firstLine(stderr) ?? `o codex queue falhou (código ${String(e.code ?? '?')})` });
        });
      } catch {
        // Argumento que não dá para passar a um processo (ex.: caractere NUL no texto).
        done({ ok: false, error: 'a mensagem tem caracteres que não dá para mandar ao Codex' });
      }
    });
}
