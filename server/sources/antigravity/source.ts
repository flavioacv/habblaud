// Fonte de agentes do Antigravity (AgentSource 'antigravity', ver sources/source.ts):
// Observa as sessões ABERTAS em cada pasta do Antigravity (presence/<convId>.lock),
// acompanha os transcripts em tempo real e alimenta o Office e o AccountsService.
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import type { TerminalParser } from '../terminal';
import type { AgentStatus, SourceInfo } from '../../../shared/types';
import { detectAntigravityAccounts } from './accounts';
import { createAntigravityTerminalParser } from './terminal';
import { fetchAntigravityUsage } from './quota';
import {
  createAntigravityState,
  parseAntigravityLine,
  type AntigravityLineResult,
  type AntigravityState,
} from './transcript';

import { execSync } from 'node:child_process';

const esmRequire = createRequire(import.meta.url);

function getDatabaseSync(): any {
  try {
    return esmRequire('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
}

const MAIN_ROLE = 'Agente principal (Antigravity)';
const STARTUP_GRACE_MS = 5_000;
const QUOTA_REFRESH_MS = 60_000;

export interface RunningAntigravityProcess {
  pid: number;
  /** Alguns builds do Antigravity ocultam --conversation no título do processo. */
  convId?: string;
  cwd?: string;
}

/** Retorna processos agy/antigravity ativos com CWD e, quando disponível, o ID da conversa. */
export function runningAntigravityProcesses(): Map<string, RunningAntigravityProcess> {
  const map = new Map<string, RunningAntigravityProcess>();
  try {
    const out = execSync('ps -eo pid,command', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (m && /(?:^|\s)(?:agy|antigravity)(?:\s|$)/i.test(m[2])) {
        const pid = parseInt(m[1], 10);
        const convId = m[2].match(/--conversation=([0-9a-fA-F-]+)/)?.[1];
        let cwd: string | undefined;
        try {
          if (process.platform === 'darwin') {
            const lsofOut = execSync(`lsof -a -p ${pid} -d cwd -Fn`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            for (const l of lsofOut.split('\n')) {
              if (l.startsWith('n/')) {
                cwd = l.slice(1);
                break;
              }
            }
          } else if (process.platform === 'linux') {
            cwd = readlinkSync(`/proc/${pid}/cwd`);
          }
        } catch {
          // ignore
        }
        // No macOS, `ps` pode mostrar somente "agy". Mantemos o processo pelo PID
        // para associá-lo ao workspace e ao lock da conversa em pollAccount.
        const processInfo: RunningAntigravityProcess = { pid, ...(convId ? { convId } : {}), cwd };
        map.set(convId ?? `@pid:${pid}`, processInfo);
      }
    }
  } catch {
    // ignore
  }
  return map;
}

/** Retorna os IDs de conversas que possuem processo agy rodando na máquina agora. */
export function runningAntigravityConversations(): Set<string> {
  return new Set([...runningAntigravityProcesses().values()].flatMap((p) => p.convId ? [p.convId] : []));
}

export interface AntigravitySourceOptions {
  accounts: AccountsService;
  office: Office;
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  tailBytes?: number;
  fetchUsage?: () => Promise<import('../../../shared/types').AccountUsage | undefined>;
}

interface AntigravityAccountTracker {
  id: string;
  dir: string;
  configDir: string;
}

interface ConversationTracker {
  key: string;
  acc: AntigravityAccountTracker;
  conversationId: string;
  cwd?: string;
  inOffice: boolean;
  status: AgentStatus;
  statusAt: number;
  state: AntigravityState;
  tail?: FileTail;
  transcriptPath?: string;
  lastSeenAt: number;
}

export class AntigravitySource implements AgentSource {
  readonly provider = 'antigravity' as const;
  private readonly dirs: string[];
  private readonly now: () => number;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private quotaTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private accounts: AntigravityAccountTracker[] = [];
  private readonly trackers = new Map<string, ConversationTracker>();

  constructor(private readonly opts: AntigravitySourceOptions) {
    this.dirs = opts.dirs;
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 2_000;
  }

  start(): void {
    const env = this.opts.env ?? process.env;
    const home = this.opts.home ?? (env.HOME || homedir());
    const existing = this.opts.accounts.entries?.() ?? [];
    const detected = detectAntigravityAccounts(this.dirs, {
      home,
      env,
      taken: {
        shorts: existing.map((e) => e.detected.short),
        colors: existing.map((e) => e.detected.color),
      },
    });

    const entries = this.opts.accounts.setProviderAccounts(
      'antigravity',
      this.dirs.map((dir, i) => ({ dir, detected: detected[i] })),
    );

    this.accounts = entries.map((e) => ({
      id: e.id,
      dir: e.dir,
      configDir: e.detected.configDir,
    }));

    this.opts.office.beginBoot();
    try {
      this.poll();
      this.refreshQuota();
    } catch (err) {
      log.error(`Falha no boot da fonte Antigravity: ${errMsg(err)}`);
    } finally {
      this.opts.office.endBoot();
    }

    if (!this.stopped) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref?.();

      this.quotaTimer = setInterval(() => this.refreshQuota(), QUOTA_REFRESH_MS);
      this.quotaTimer.unref?.();
    }
  }

  /** Atualiza o uso da conta a partir da API oficial ou token salvo no Keychain. */
  async refreshQuota(): Promise<void> {
    try {
      const usage = this.opts.fetchUsage ? await this.opts.fetchUsage() : await fetchAntigravityUsage(undefined, this.now());
      if (usage) {
        for (const acc of this.accounts) {
          this.opts.accounts.setUsage(acc.id, usage);
        }
      }
    } catch (err) {
      log.warnOnce('antigravity-quota-refresh', `Erro ao atualizar cota do Antigravity: ${errMsg(err)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.quotaTimer) {
      clearInterval(this.quotaTimer);
      this.quotaTimer = null;
    }
    this.trackers.clear();
  }

  sources(): SourceInfo[] {
    return this.accounts.map((a) => {
      let activeSessions = 0;
      for (const t of this.trackers.values()) {
        if (t.acc.id === a.id && t.inOffice) activeSessions++;
      }
      return {
        label: a.id,
        provider: 'antigravity',
        path: a.dir,
        sessions: activeSessions,
        ok: true,
      };
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    return this.trackers.get(agentId)?.transcriptPath;
  }

  terminalParser(_agentId: string): TerminalParser {
    return createAntigravityTerminalParser();
  }

  /** Lê arquivos de presença (*.lock) e processos em execução. */
  private poll(): void {
    const now = this.now();
    const running = runningAntigravityProcesses();
    for (const acc of this.accounts) {
      this.pollAccount(acc, now, running);
    }

    // Limpa conversas que não têm mais processo ativo
    for (const [key, t] of this.trackers.entries()) {
      if (now - t.lastSeenAt >= this.pollMs + 500) {
        if (t.inOffice) {
          this.opts.office.closeMain(key);
          t.inOffice = false;
        }
        this.trackers.delete(key);
      }
    }
  }

  private pollAccount(acc: AntigravityAccountTracker, now: number, running: Map<string, RunningAntigravityProcess>): void {
    const presenceDir = join(acc.dir, 'presence');
    if (!existsSync(presenceDir)) return;

    let names: string[];
    try {
      names = readdirSync(presenceDir);
    } catch {
      return;
    }

    // Mapa de workspace por conversa lido do history.jsonl
    const workspaces = this.readWorkspaces(acc);

    // Associa processos cujo título não expõe --conversation (comum no macOS)
    // ao lock mais recente do mesmo workspace. Locks antigos não vencem um lock
    // mais novo, e a quantidade de conversas ativadas não excede a de processos.
    const activeProcesses = new Map(running);
    const unnamed = [...running.values()].filter((p) => !p.convId && p.cwd && !this.isInternalDir(acc, p.cwd));
    const candidates = names
      .filter((name) => name.endsWith('.lock'))
      .map((name) => {
        const convId = name.slice(0, -'.lock'.length);
        const workspace = this.resolveWorkspace(acc, convId, workspaces, running);
        let modifiedAt = 0;
        try { modifiedAt = statSync(join(presenceDir, name)).mtimeMs; } catch { /* lock removido durante a leitura */ }
        return { convId, workspace, modifiedAt };
      })
      .filter((c) => c.workspace && unnamed.some((p) => p.cwd === c.workspace) && !running.has(c.convId))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    const assigned = new Set<string>();
    for (const proc of unnamed) {
      const candidate = candidates.find((c) => c.workspace === proc.cwd && !assigned.has(c.convId));
      if (candidate) {
        activeProcesses.set(candidate.convId, proc);
        assigned.add(candidate.convId);
      }
    }

    for (const name of names) {
      if (!name.endsWith('.lock')) continue;
      const convId = name.slice(0, -'.lock'.length);
      const key = `${acc.id}:${convId}`;
      const lockPath = join(presenceDir, name);
      const transcriptPath = join(acc.dir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');

      // Verifica se a conversa está realmente ativa (processo rodando no SO ou lock recém-criado)
      const isRunning = activeProcesses.has(convId);
      if (!isRunning) {
        let isStarting = false;
        try {
          const lockMtime = statSync(lockPath).mtimeMs;
          // Se o processo não está rodando, só aceitamos se o lock foi criado há menos de 5 segundos (processo inicializando)
          isStarting = now - lockMtime < STARTUP_GRACE_MS;
        } catch {
          // ignore
        }
        if (!isStarting) {
          // Processo não está rodando no terminal: sessão encerrada ou lock antigo
          continue;
        }
      }

      let tracker = this.trackers.get(key);
      if (!tracker) {
        const cwd = this.resolveWorkspace(acc, convId, workspaces, activeProcesses);
        const transcriptPath = join(acc.dir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');

        tracker = {
          key,
          acc,
          conversationId: convId,
          cwd,
          inOffice: false,
          status: 'working',
          statusAt: now,
          state: createAntigravityState(),
          transcriptPath,
          lastSeenAt: now,
        };
        this.trackers.set(key, tracker);
      } else {
        tracker.lastSeenAt = now;
        if (!tracker.cwd) {
          const resolved = this.resolveWorkspace(acc, convId, workspaces, activeProcesses);
          if (resolved) {
            tracker.cwd = resolved;
          }
        }
      }

      this.pump(tracker, now);
    }
  }

  private pump(t: ConversationTracker, now: number): void {
    if (!t.transcriptPath || !existsSync(t.transcriptPath)) return;

    if (!t.tail) {
      try {
        t.tail = new FileTail(t.transcriptPath);
        if (this.opts.tailBytes) {
          t.tail.seekTail(this.opts.tailBytes);
        }
      } catch {
        return;
      }
    }

    const readRes = t.tail.read();
    let hasChanges = false;

    for (const line of readRes.lines) {
      const res: AntigravityLineResult = parseAntigravityLine(line, t.state, {
        idPrefix: t.key,
        now,
      });

      if (!t.inOffice && t.cwd) {
        this.enter(t, now);
      }

      if (t.inOffice) {
        for (const act of res.activities) {
          this.opts.office.addActivity(t.key, act.activity, act.current, { feed: true });
        }
      }

      for (const sig of res.signals) {
        if (sig.type === 'turnStart') {
          t.status = 'working';
          t.statusAt = now;
          if (t.inOffice) this.opts.office.setStatus(t.key, 'working');
        } else if (sig.type === 'turnEnd') {
          t.status = 'idle';
          t.statusAt = now;
          if (t.inOffice) this.opts.office.setStatus(t.key, 'idle');
        }
      }

      if (res.changed) hasChanges = true;
    }

    if (!t.inOffice && t.cwd) {
      this.enter(t, now);
    }

    if (t.inOffice && hasChanges) {
      const summary: TranscriptSummary = {
        tasks: [],
        stats: { ...t.state.stats },
        title: t.state.title,
        model: t.state.model,
      };
      this.opts.office.applyTranscript(t.key, summary);
    }
  }

  private enter(t: ConversationTracker, now: number): void {
    if (t.inOffice || !t.cwd) return;
    this.opts.office.addMain({
      id: t.key,
      provider: 'antigravity',
      account: t.acc.id,
      sessionId: t.conversationId,
      cwd: t.cwd,
      role: MAIN_ROLE,
      startedAt: t.state.firstAt ?? now,
      status: t.status,
    });
    t.inOffice = this.opts.office.has(t.key);
  }

  private readWorkspaces(acc: AntigravityAccountTracker): Map<string, string> {
    const map = new Map<string, string>();
    const historyFile = join(acc.dir, 'history.jsonl');
    if (existsSync(historyFile)) {
      try {
        const content = readFileSync(historyFile, 'utf8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          const j = JSON.parse(line) as { conversationId?: string; workspace?: string };
          if (j.conversationId && j.workspace) {
            map.set(j.conversationId, j.workspace);
          }
        }
      } catch {
        // ignore
      }
    }
    return map;
  }

  private isInternalDir(acc: AntigravityAccountTracker, path: string): boolean {
    return path === acc.dir || path.startsWith(acc.dir + '/');
  }

  private resolveWorkspace(
    acc: AntigravityAccountTracker,
    convId: string,
    workspaces: Map<string, string>,
    running: Map<string, RunningAntigravityProcess>,
  ): string | undefined {
    // 1. Processo ativo no SO: CWD onde o comando agy/antigravity está rodando
    const proc = running.get(convId);
    if (proc?.cwd && !this.isInternalDir(acc, proc.cwd)) {
      return proc.cwd;
    }

    // 2. Histórico salvo em history.jsonl
    const fromHistory = workspaces.get(convId);
    if (fromHistory && !this.isInternalDir(acc, fromHistory)) {
      return fromHistory;
    }

    // 3. Metadados da trajetória no SQLite da conversa
    const fromDb = this.readWorkspaceFromDb(acc, convId);
    if (fromDb && !this.isInternalDir(acc, fromDb)) {
      return fromDb;
    }

    // Nunca usa acc.dir como fallback: aguarda o projeto real ser conhecido
    return undefined;
  }

  private readWorkspaceFromDb(acc: AntigravityAccountTracker, convId: string): string | undefined {
    const dbPath = join(acc.dir, 'conversations', `${convId}.db`);
    if (!existsSync(dbPath)) return undefined;

    const DatabaseSync = getDatabaseSync();
    if (!DatabaseSync) return undefined;

    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT data FROM trajectory_metadata_blob WHERE id = ?').get('main') as { data?: ArrayBuffer | Uint8Array } | undefined;
        if (row && row.data) {
          const str = Buffer.from(row.data as Uint8Array).toString('utf8');
          const m = str.match(/file:\/\/([^\s\x00-\x1f\x7f-\x9f]+)/);
          if (m) {
            return decodeURIComponent(m[1]);
          }
        }
      } finally {
        db.close();
      }
    } catch {
      // Fallback em caso de erro na leitura do SQLite
    }
    return undefined;
  }
}
