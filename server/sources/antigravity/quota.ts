// Leitor de quota e limites do Antigravity via endpoint oficial
// (https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary)
// Autenticação obtida do Keychain do macOS ("gemini" / "antigravity").
import { execFileSync } from 'node:child_process';
import type { AccountUsage } from '../../../shared/types';
import { log } from '../../log';

export interface AntigravityBucket {
  bucketId: string;
  displayName: string;
  window: '5h' | 'weekly' | string;
  resetTime?: string;
  remainingFraction: number;
}

export interface AntigravityQuotaGroup {
  displayName: string;
  buckets?: AntigravityBucket[];
}

export interface AntigravityQuotaResponse {
  groups?: AntigravityQuotaGroup[];
}

/** Tenta extrair o access token do Keychain do macOS ("gemini" / "antigravity") ou variável de ambiente. */
export function getAntigravityAccessToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.ANTIGRAVITY_TOKEN?.trim() || env.GEMINI_CLI_TOKEN?.trim();
  if (explicit) return explicit;

  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!raw) return undefined;
      const b64 = raw.replace(/^go-keyring-base64:/, '');
      const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
      const data = JSON.parse(jsonStr);
      return data?.token?.access_token;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Consulta a quota ao vivo do Antigravity na API do CloudCode / Gemini.
 * Converte as frações restantes em percentual de utilização (100 - remaining%).
 */
export async function fetchAntigravityUsage(token?: string, now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<AccountUsage | undefined> {
  const accessToken = token ?? getAntigravityAccessToken(env);
  if (!accessToken) return undefined;

  try {
    const res = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity',
      },
      body: '{}',
    });

    if (!res.ok) {
      log.warnOnce('antigravity-quota-http', `Antigravity quota HTTP error: ${res.status}`);
      return undefined;
    }

    const data = (await res.json()) as AntigravityQuotaResponse;
    const groups = data.groups ?? [];
    const geminiGroup = groups.find((g) => /gemini/i.test(g.displayName)) ?? groups[0];
    const claudeGroup = groups.find((g) => /claude|gpt/i.test(g.displayName));

    if (!geminiGroup || !geminiGroup.buckets?.length) return undefined;

    const usage: AccountUsage = {
      source: 'antigravity',
      fetchedAt: now,
    };

    for (const b of geminiGroup.buckets) {
      const remainingPct = Math.max(0, Math.min(1, b.remainingFraction));
      const usedPct = Number(((1 - remainingPct) * 100).toFixed(2));
      const resetsAt = b.resetTime ? Date.parse(b.resetTime) : undefined;

      if (b.window === '5h' || /5h|five/i.test(b.bucketId)) {
        usage.fiveHour = {
          utilization: usedPct,
          resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
        };
      } else if (b.window === 'weekly' || /weekly|week/i.test(b.bucketId)) {
        usage.sevenDay = {
          utilization: usedPct,
          resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
        };
      }
    }

    // Se houver grupo Claude and GPT models no Antigravity, expõe a janela semanal de terceiros
    if (claudeGroup?.buckets?.length) {
      const claudeWeekly = claudeGroup.buckets.find((b) => b.window === 'weekly' || /weekly|week/i.test(b.bucketId));
      if (claudeWeekly) {
        const remainingPct = Math.max(0, Math.min(1, claudeWeekly.remainingFraction));
        const usedPct = Number(((1 - remainingPct) * 100).toFixed(2));
        const resetsAt = claudeWeekly.resetTime ? Date.parse(claudeWeekly.resetTime) : undefined;
        usage.sevenDaySonnet = {
          utilization: usedPct,
          resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
        };
      }
    }

    return usage;
  } catch (err) {
    log.warnOnce('antigravity-quota-fetch', `Falha ao consultar quota do Antigravity: ${String(err)}`);
    return undefined;
  }
}
