// Fonte de agentes do Antigravity (AgentSource 'antigravity', ver sources/source.ts):
// Observa as sessões ABERTAS em cada pasta do Antigravity (presence/<convId>.lock),
// acompanha os transcripts em tempo real e alimenta o Office e o AccountsService.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import type { TerminalParser } from '../terminal';
import type { AgentStatus, SourceInfo } from '../../../shared/types';
import { detectAntigravityAccounts } from './accounts';
import { createAntigravityTerminalParser } from './terminal';
import {
  createAntigravityState,
  parseAntigravityLine,
  type AntigravityLineResult,
  type AntigravityState,
} from './transcript';

const MAIN_ROLE = 'Agente principal (Antigravity)';

export interface AntigravitySourceOptions {
  accounts: AccountsService;
  office: Office;
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  tailBytes?: number;
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
    const detected = detectAntigravityAccounts(this.dirs, { home, env });

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
    } catch (err) {
      log.error(`Falha no boot da fonte Antigravity: ${errMsg(err)}`);
    } finally {
      this.opts.office.endBoot();
    }

    if (!this.stopped) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const t of this.trackers.values()) {
      t.tail?.close();
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

  /** Lê arquivos de presença (*.lock) e o history.jsonl de cada conta. */
  private poll(): void {
    const now = this.now();
    for (const acc of this.accounts) {
      this.pollAccount(acc, now);
    }

    // Limpa conversas que não têm mais lock há mais de 3 segundos
    for (const [key, t] of this.trackers.entries()) {
      if (now - t.lastSeenAt > 3_000) {
        if (t.inOffice) {
          this.opts.office.closeMain(key);
          t.inOffice = false;
        }
        t.tail?.close();
        this.trackers.delete(key);
      }
    }
  }

  private pollAccount(acc: AntigravityAccountTracker, now: number): void {
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

    for (const name of names) {
      if (!name.endsWith('.lock')) continue;
      const convId = name.slice(0, -'.lock'.length);
      const key = `${acc.id}:${convId}`;

      let tracker = this.trackers.get(key);
      if (!tracker) {
        const cwd = workspaces.get(convId) || acc.dir;
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
        if (!tracker.cwd && workspaces.has(convId)) {
          tracker.cwd = workspaces.get(convId);
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
        } else if (sig.type === 'usage') {
          this.opts.accounts.setUsage(t.acc.id, sig.usage);
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
      title: t.state.title,
      startedAt: t.state.firstAt ?? now,
      status: t.status,
    });
    t.inOffice = this.opts.office.has(t.key);
  }

  private readWorkspaces(acc: AntigravityAccountTracker): Map<string, string> {
    const map = new Map<string, string>();
    const historyFile = join(acc.dir, 'history.jsonl');
    if (!existsSync(historyFile)) return map;

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
    return map;
  }
}
