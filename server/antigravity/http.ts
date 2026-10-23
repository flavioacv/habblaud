// Eventos dos hooks do Antigravity (mod/habblaud-antigravity/hook.mjs, que npm run antigravity:install
// acrescenta em ~/.gemini/config/hooks.json): SessionStart, PreToolUse, PostToolUse e Stop chegam aqui com a conta
// e vão para a fonte do Antigravity (AntigravityLive), atualizando o agente imediatamente, sem depender de polling de locks.
//
//   POST /api/antigravity/events   (hook)   {account?, event: <stdin do hook>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { AccountEntry } from '../accounts/service';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { AntigravityLive } from '../sources/antigravity/live';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

export interface AntigravityHookEvent {
  account?: string;
  antigravityHome?: string;
  event: Rec;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Corpo de POST /api/antigravity/events. Sem `event` (objeto com conversationId): 400. */
export function parseAntigravityEvent(raw: unknown): AntigravityHookEvent {
  const r = rec(raw);
  const event = rec(r?.event);
  const conversationId = shortStr(event?.conversationId ?? event?.session_id, 200);
  if (!r || !event || !conversationId) {
    throw new HttpError(400, 'esperado {account?, event: <JSON do hook do Antigravity com conversationId>}');
  }
  const out: AntigravityHookEvent = { event };
  const account = shortStr(r.account, 200);
  const antigravityHome = shortStr(r.antigravityHome, 4_096);
  if (account) out.account = account;
  if (antigravityHome) out.antigravityHome = antigravityHome;
  return out;
}

/** Identifica a conta Antigravity correspondente ao diretório ou id informado. */
export function antigravityAccountOf(
  entries: readonly AccountEntry[],
  account: string | undefined,
  homeDir: string | undefined,
): string | undefined {
  if (homeDir && isAbsolute(homeDir)) {
    const abs = resolve(homeDir);
    const e = entries.find((x) => resolve(x.detected.configDir) === abs || resolve(x.dir) === abs);
    if (e) return e.id;
  }
  if (account) {
    const byId = entries.find((x) => x.id === account);
    if (byId) return byId.id;
  }
  return entries[0]?.id ?? account;
}

/** Trata POST /api/antigravity/events. */
export async function handleAntigravityEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: AntigravityLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  const body = parseAntigravityEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      const acc = antigravityAccountOf(deps.entries(), body.account, body.antigravityHome);
      ok = deps.live.applyHookEvent(acc, body.event) === true;
    } catch (err) {
      log.warnOnce(`antigravity-event:${errMsg(err)}`, tr('Eventos do Antigravity: falha ao aplicar evento ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}
