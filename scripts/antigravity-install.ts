// Instala (ou remove) o hook do Habblaud no Antigravity CLI e IDE (~/.gemini/config/hooks.json).
//
// Uso:
//   npm run antigravity:install     # adiciona o hook PreToolUse em ~/.gemini/config/hooks.json
//   npm run antigravity:uninstall   # remove o hook do Habblaud de ~/.gemini/config/hooks.json
//   npm run antigravity:status      # verifica se o hook está configurado
//
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quotePath, readSettings, tildify, writeSettings, type Settings } from './statusline-install';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SCRIPT = join(ROOT, 'mod', 'habblaud-antigravity', 'hook.mjs');
const HOOK_MARK = /habblaud-antigravity[\\/]+hook\.mjs/;
export const DEFAULT_PORT = 4747;
export const DEFAULT_WAIT_S = 25;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 120;
export const TIMEOUT_SLACK_S = 10;
export const CONFIG_NAME = 'antigravity-hook.json';
export const MIN_NODE_MAJOR = 22;

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

export function hookCommand(scriptPath: string, nodeBin?: string): string {
  return `${nodeBin ? quotePath(nodeBin) : 'node'} ${quotePath(scriptPath)}`;
}

export function isOurHandler(handler: unknown): boolean {
  const r = rec(handler);
  return typeof r?.command === 'string' && HOOK_MARK.test(r.command);
}

export function handlerFor(command: string, waitS: number) {
  return {
    type: 'command',
    command,
    timeout: waitS + TIMEOUT_SLACK_S,
  };
}

export function getGlobalConfigDir(home = homedir()): string {
  return join(home, '.gemini', 'config');
}

export function getHooksPath(home = homedir()): string {
  return join(getGlobalConfigDir(home), 'hooks.json');
}

export interface PlanResult {
  action: 'install' | 'uninstall' | 'none' | 'skip';
  message: string;
  hooks?: Rec;
}

export function hasActiveHandler(existingHooks: Rec, command?: string): boolean {
  const currentHabblaud = rec(existingHooks['habblaud-permissions']);
  if (!currentHabblaud || currentHabblaud.enabled === false) return false;
  const preToolUse = Array.isArray(currentHabblaud.PreToolUse) ? currentHabblaud.PreToolUse : [];
  return preToolUse.some((group: any) =>
    Array.isArray(group?.hooks) && group.hooks.some((h: any) => isOurHandler(h) && (!command || h.command === command))
  );
}

export const HOOK_EVENTS = ['PreToolUse', 'SessionStart', 'Stop'] as const;

export function planInstall(existingHooks: Rec, command: string, waitS: number): PlanResult {
  const hooks = { ...existingHooks };
  const handler = handlerFor(command, waitS);

  const currentHabblaud = rec(hooks['habblaud-permissions']) ? { ...(rec(hooks['habblaud-permissions']) as Rec) } : {};
  let changed = false;

  for (const ev of HOOK_EVENTS) {
    const existingList = Array.isArray(currentHabblaud[ev]) ? currentHabblaud[ev] : [];
    const res = installEventHooks(existingList, handler);
    currentHabblaud[ev] = res.list;
    if (res.changed) changed = true;
  }

  if (currentHabblaud.enabled === false) {
    currentHabblaud.enabled = true;
    changed = true;
  }

  if (!changed && hasActiveHandler(existingHooks, command)) {
    return { action: 'none', message: 'já instalado e atualizado' };
  }

  hooks['habblaud-permissions'] = currentHabblaud;

  return { action: 'install', message: 'configurado hooks do Habblaud (PreToolUse, SessionStart, Stop)', hooks };
}

function installEventHooks(list: unknown[], handler: ReturnType<typeof handlerFor>): { list: unknown[]; changed: boolean } {
  const eventList = Array.isArray(list) ? [...list] : [];
  let foundGroupIndex = -1;
  let foundHandlerIndex = -1;

  for (let gi = 0; gi < eventList.length; gi++) {
    const group = rec(eventList[gi]);
    if (Array.isArray(group?.hooks)) {
      const hi = group.hooks.findIndex((h) => isOurHandler(h));
      if (hi >= 0) {
        foundGroupIndex = gi;
        foundHandlerIndex = hi;
        break;
      }
    }
  }

  let changed = false;

  if (foundGroupIndex >= 0) {
    const group = { ...(rec(eventList[foundGroupIndex]) as Rec) };
    const groupHooks = Array.isArray(group.hooks) ? [...group.hooks] : [];
    const hasOtherHandlersInGroup = groupHooks.some((_, i) => i !== foundHandlerIndex);

    if (hasOtherHandlersInGroup) {
      groupHooks.splice(foundHandlerIndex, 1);
      group.hooks = groupHooks;
      eventList[foundGroupIndex] = group;
      eventList.push({
        matcher: '*',
        hooks: [handler],
      });
      changed = true;
    } else {
      const existing = rec(groupHooks[foundHandlerIndex]);
      if (existing?.command !== handler.command || existing?.timeout !== handler.timeout || group.matcher !== '*') {
        groupHooks[foundHandlerIndex] = handler;
        group.matcher = '*';
        group.hooks = groupHooks;
        eventList[foundGroupIndex] = group;
        changed = true;
      }
    }
  } else {
    eventList.push({
      matcher: '*',
      hooks: [handler],
    });
    changed = true;
  }

  return { list: eventList, changed };
}

function uninstallEventHooks(list: unknown[]): { list: unknown[]; removedCount: number } {
  const eventList = Array.isArray(list) ? [...list] : [];
  const newEventList: unknown[] = [];
  let removedCount = 0;

  for (const item of eventList) {
    const group = rec(item);
    if (!group || !Array.isArray(group.hooks)) {
      newEventList.push(item);
      continue;
    }
    const filteredHooks = group.hooks.filter((h) => {
      if (isOurHandler(h)) {
        removedCount++;
        return false;
      }
      return true;
    });
    if (filteredHooks.length > 0) {
      newEventList.push({ ...group, hooks: filteredHooks });
    }
  }

  return { list: newEventList, removedCount };
}

export function planUninstall(existingHooks: Rec): PlanResult {
  const currentHabblaud = rec(existingHooks['habblaud-permissions']);
  if (!currentHabblaud) {
    return { action: 'none', message: 'não estava instalado' };
  }

  const hooks = { ...existingHooks };
  const updatedHabblaud = { ...currentHabblaud };
  let totalRemoved = 0;

  for (const ev of HOOK_EVENTS) {
    const existingList = Array.isArray(updatedHabblaud[ev]) ? updatedHabblaud[ev] : [];
    const res = uninstallEventHooks(existingList);
    totalRemoved += res.removedCount;
    if (res.list.length > 0) {
      updatedHabblaud[ev] = res.list;
    } else {
      delete updatedHabblaud[ev];
    }
  }

  for (const key of Object.keys(updatedHabblaud)) {
    if (key === 'enabled' || (HOOK_EVENTS as readonly string[]).includes(key)) continue;
    if (Array.isArray(updatedHabblaud[key])) {
      const res = uninstallEventHooks(updatedHabblaud[key]);
      totalRemoved += res.removedCount;
      if (res.list.length > 0) {
        updatedHabblaud[key] = res.list;
      } else {
        delete updatedHabblaud[key];
      }
    }
  }

  if (totalRemoved === 0) {
    return { action: 'none', message: 'nenhum hook do Habblaud encontrado' };
  }

  const remainingKeys = Object.keys(updatedHabblaud).filter((k) => k !== 'enabled' && (updatedHabblaud as any)[k] !== undefined);
  if (remainingKeys.length === 0) {
    delete hooks['habblaud-permissions'];
  } else {
    hooks['habblaud-permissions'] = updatedHabblaud;
  }

  return { action: 'uninstall', message: 'removido hook do Habblaud', hooks };
}

export async function run(args: string[] = process.argv.slice(2)): Promise<number> {
  const mode = args[0] || 'status';
  const home = process.env.HOME || homedir();
  const hooksFile = getHooksPath(home);
  const cfgDir = getGlobalConfigDir(home);

  if (!existsSync(cfgDir)) {
    mkdirSync(cfgDir, { recursive: true });
  }

  let fileContent: Rec = {};
  if (existsSync(hooksFile)) {
    try {
      fileContent = JSON.parse(readFileSync(hooksFile, 'utf8')) as Rec;
      if (!rec(fileContent)) fileContent = {};
    } catch {
      fileContent = {};
    }
  }

  const command = hookCommand(HOOK_SCRIPT);

  if (mode === 'install') {
    const plan = planInstall(fileContent, command, DEFAULT_WAIT_S);
    if (plan.action === 'install' && plan.hooks) {
      writeFileSync(hooksFile, JSON.stringify(plan.hooks, null, 2) + '\n', 'utf8');
      console.log(`[Antigravity Hook] Instalado com sucesso em ${hooksFile}`);
    } else {
      console.log(`[Antigravity Hook] ${plan.message}`);
    }
    return 0;
  }

  if (mode === 'uninstall') {
    const plan = planUninstall(fileContent);
    if (plan.action === 'uninstall' && plan.hooks) {
      writeFileSync(hooksFile, JSON.stringify(plan.hooks, null, 2) + '\n', 'utf8');
      console.log(`[Antigravity Hook] Removido com sucesso de ${hooksFile}`);
    } else {
      console.log(`[Antigravity Hook] ${plan.message}`);
    }
    return 0;
  }

  if (mode === 'status') {
    const isInstalled = hasActiveHandler(fileContent, command);
    console.log(`[Antigravity Hook] Status em ${hooksFile}: ${isInstalled ? 'INSTALADO' : 'NÃO INSTALADO'}`);
    return isInstalled ? 0 : 1;
  }

  console.error(`Modo desconhecido: ${mode}. Use: install, uninstall ou status.`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
