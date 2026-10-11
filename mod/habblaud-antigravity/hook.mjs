#!/usr/bin/env node
// Hook do Habblaud para o Antigravity (CLI `agy` e IDE):
// Intercepta eventos PreToolUse do Antigravity, registra a solicitação em POST /api/permissions
// e aguarda decisão em GET /api/permissions/:id/wait.
//
// Retornos de decisão do PreToolUse para o Antigravity:
// - allow: {"decision": "allow"}
// - deny: {"decision": "deny", "reason": "..."}
// - responder no terminal / timeout / erro: {"decision": "ask"} (ou {"decision": "force_ask"})
//
// Regras: Node puro (22+), apenas `node:*`, sem dependências externas.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 4747;
export const DEFAULT_WAIT_S = 25;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 120;
export const CONFIG_FILE = 'antigravity-hook.json';

const REGISTER_TIMEOUT_MS = 2_000;
const POLL_S = 25;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
const MAX_STRING = 8_000;
const MAX_BODY = 200_000;

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-antigravity] ${msg}\n`) : () => {};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function readConfig(env = process.env) {
  const file = join(env.HOME || homedir(), '.habblaud', CONFIG_FILE);
  let port = DEFAULT_PORT;
  let waitS = DEFAULT_WAIT_S;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (isObject(raw)) {
      if (typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65_536) port = raw.port;
      if (typeof raw.permissionTimeoutS === 'number' && Number.isFinite(raw.permissionTimeoutS)) {
        waitS = Math.min(MAX_WAIT_S, Math.max(MIN_WAIT_S, Math.round(raw.permissionTimeoutS)));
      }
    }
  } catch {
    // Config opcional
  }
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65_536) port = envPort;
  const envWait = Number(env.HABBLAUD_PERMISSION_TIMEOUT ?? '');
  if (Number.isFinite(envWait) && envWait > 0) waitS = Math.min(MAX_WAIT_S, Math.max(MIN_WAIT_S, Math.round(envWait)));
  return { port, waitMs: waitS * 1_000 };
}

export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

function fitted(v, size) {
  let out = v;
  for (const max of [MAX_STRING, 1_000, 200]) {
    out = trimInput(v, max);
    if (size(out) <= MAX_BODY) break;
  }
  return out;
}

/**
 * Normaliza o payload PreToolUse do Antigravity para o formato esperado pelo Habblaud:
 * Antigravity envia em stdin:
 * {
 *   "conversationId": "...",
 *   "toolCall": { "name": "run_command", "args": { "CommandLine": "..." } },
 *   "stepIdx": 10,
 *   "workspacePaths": ["/path/to/project"],
 *   ...
 * }
 */
export function permissionBody(input, timeoutMs) {
  const conversationId = String(input.conversationId ?? input.session_id ?? '');
  const toolCall = isObject(input.toolCall) ? input.toolCall : {};
  const toolName = String(toolCall.name ?? input.tool_name ?? 'unknown');
  const toolArgs = isObject(toolCall.args) ? toolCall.args : isObject(input.tool_input) ? input.tool_input : {};
  const cwd = Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string'
    ? input.workspacePaths[0]
    : typeof input.cwd === 'string' ? input.cwd : undefined;

  const body = {
    provider: 'antigravity',
    session_id: conversationId,
    tool_name: toolName,
    tool_input: {},
    timeout_ms: timeoutMs,
  };
  if (cwd) body.cwd = cwd;
  body.tool_input = fitted(toolArgs, (toolInput) => JSON.stringify({ ...body, tool_input: toolInput }).length);
  return body;
}

/**
 * Converte a decisão do Habblaud para a saída JSON esperada pelo Antigravity PreToolUse.
 */
export function decisionOutput(result) {
  if (!result || result.status !== 'decided') {
    return { decision: 'ask' };
  }
  if (result.behavior === 'allow') {
    return { decision: 'allow' };
  }
  if (result.behavior === 'deny') {
    const custom = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    const reason = custom ? `Recusado pelo usuário no Habblaud: ${custom}` : 'Recusado pelo usuário no Habblaud.';
    return { decision: 'deny', reason };
  }
  return { decision: 'ask' };
}

function readStdin() {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    const finish = (text) => {
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(undefined));
  });
}

async function call(base, method, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`${method} ${path}: ${err?.name ?? 'erro'} ${err?.message ?? ''}`);
    return null;
  }
}

export async function run(env = process.env, stdinText) {
  const startedAt = Date.now();
  try {
    const raw = stdinText ?? (await readStdin());
    if (!raw) return { decision: 'ask' };
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return { decision: 'ask' };
    }
    if (!isObject(input)) return { decision: 'ask' };

    const conversationId = input.conversationId ?? input.session_id;
    if (!conversationId) return { decision: 'ask' };

    const cfg = readConfig(env);
    const base = `http://127.0.0.1:${cfg.port}`;
    const deadline = startedAt + cfg.waitMs;

    const reg = await call(
      base,
      'POST',
      '/api/permissions',
      permissionBody(input, Math.max(0, deadline - Date.now())),
      REGISTER_TIMEOUT_MS,
    );

    if (!reg || reg.status !== 201 || typeof reg.json?.id !== 'string') {
      debug(`sem desvio ou erro ao registrar: ${reg ? `${reg.status} ${JSON.stringify(reg.json ?? null)}` : 'Habblaud offline'}`);
      return { decision: 'ask' };
    }

    const id = encodeURIComponent(reg.json.id);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        debug('tempo esgotado: delegando para o terminal');
        return { decision: 'ask' };
      }
      const waitS = Math.max(0.05, Math.min(POLL_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return { decision: 'ask' };
      if (r.json?.status === 'pending') continue;
      debug(`resposta do Habblaud: ${JSON.stringify(r.json)}`);
      return decisionOutput(r.json);
    }
  } catch (err) {
    debug(`erro no hook: ${err?.message ?? err}`);
    return { decision: 'ask' };
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  run().then((out) => {
    if (out) process.stdout.write(JSON.stringify(out));
  });
}
