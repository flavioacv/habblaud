// Histórico de sessões do Antigravity (HistoryProvider 'antigravity').
// Lê as entradas recentes de history.jsonl e mapeia para RecentSession.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { createAntigravityTerminalParser } from './terminal';

export interface AntigravityHistoryAccount {
  id: string;
  dir: string;
}

export interface AntigravityHistoryOptions {
  accounts: () => readonly AntigravityHistoryAccount[];
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

interface RawHistoryEntry {
  display?: string;
  timestamp?: number;
  workspace?: string;
  conversationId?: string;
}

export class AntigravityHistory implements HistoryProvider {
  readonly provider = 'antigravity' as const;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: AntigravityHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const minTimestamp = now - this.maxAgeMs;
    const out: RecentSession[] = [];
    const accounts = this.opts.accounts();

    for (const acc of accounts) {
      const historyFile = join(acc.dir, 'history.jsonl');
      if (!existsSync(historyFile)) continue;

      let content = '';
      try {
        content = readFileSync(historyFile, 'utf8');
      } catch {
        continue;
      }

      const byConversation = new Map<string, RawHistoryEntry>();
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as RawHistoryEntry;
          if (entry.conversationId && entry.timestamp && entry.timestamp >= minTimestamp) {
            byConversation.set(entry.conversationId, entry);
          }
        } catch {
          // ignore linha corrompida
        }
      }

      for (const [convId, entry] of byConversation.entries()) {
        const transcriptPath = join(acc.dir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
        let size = 0;
        try {
          if (existsSync(transcriptPath)) {
            size = statSync(transcriptPath).size;
          }
        } catch {
          // ignore
        }

        const agentId = this.opts.openAgentOf(acc.id, convId);
        const cwd = entry.workspace || '';
        out.push({
          account: acc.id,
          provider: 'antigravity',
          sessionId: convId,
          projectDir: cwd ? encodeCwd(cwd) : 'workspace',
          lastAt: entry.timestamp ?? now,
          size,
          open: !!agentId,
          title: entry.display,
        });
      }
    }

    out.sort((a, b) => b.lastAt - a.lastAt);
    return out.slice(0, this.limit);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: 'Conta não encontrada' };

    // Evita path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return { status: 400, error: 'ID de sessão inválido' };
    }

    const transcriptPath = join(acc.dir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(transcriptPath)) {
      return { status: 404, error: 'Conversa não encontrada' };
    }

    return {
      path: transcriptPath,
      createParser: () => createAntigravityTerminalParser(),
    };
  }
}
