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

export function planInstall(existingHooks: Rec, command: string, waitS: number): PlanResult {
  const hooks = { ...existingHooks };
  const handler = handlerFor(command, waitS);

  const currentHabblaud = rec(hooks['habblaud-permissions']) ? { ...(rec(hooks['habblaud-permissions']) as Rec) } : {};
  const preToolUseList: unknown[] = Array.isArray(currentHabblaud.PreToolUse) ? [...currentHabblaud.PreToolUse] : [];

  let foundGroupIndex = -1;
  let foundHandlerIndex = -1;

  for (let gi = 0; gi < preToolUseList.length; gi++) {
    const group = rec(preToolUseList[gi]);
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
    const group = { ...(rec(preToolUseList[foundGroupIndex]) as Rec) };
    const groupHooks = Array.isArray(group.hooks) ? [...group.hooks] : [];
    const hasOtherHandlersInGroup = groupHooks.some((_, i) => i !== foundHandlerIndex);

    if (hasOtherHandlersInGroup) {
      // Se houver outros handlers no grupo, remove o do Habblaud desse grupo para preservar seu matcher e integridade
      groupHooks.splice(foundHandlerIndex, 1);
      group.hooks = groupHooks;
      preToolUseList[foundGroupIndex] = group;

      // E adiciona o handler do Habblaud em um grupo exclusivo com matcher: '*'
      preToolUseList.push({
        matcher: '*',
        hooks: [handler],
      });
      changed = true;
    } else {
      // O grupo contém somente o nosso handler: pode atualizar comandos, timeout e garantir matcher '*'
      const existing = rec(groupHooks[foundHandlerIndex]);
      if (existing?.command !== handler.command || existing?.timeout !== handler.timeout || group.matcher !== '*') {
        groupHooks[foundHandlerIndex] = handler;
        group.matcher = '*';
        group.hooks = groupHooks;
        preToolUseList[foundGroupIndex] = group;
        changed = true;
      }
    }
  } else {
    preToolUseList.push({
      matcher: '*',
      hooks: [handler],
    });
    changed = true;
  }

  if (currentHabblaud.enabled === false) {
    currentHabblaud.enabled = true;
    changed = true;
  }

  if (!changed && hasActiveHandler(existingHooks, command)) {
    return { action: 'none', message: 'já instalado e atualizado' };
  }

  currentHabblaud.PreToolUse = preToolUseList;
  hooks['habblaud-permissions'] = currentHabblaud;

  return { action: 'install', message: 'configurado hook PreToolUse para o Habblaud', hooks };
}

export function planUninstall(existingHooks: Rec): PlanResult {
  const currentHabblaud = rec(existingHooks['habblaud-permissions']);
  if (!currentHabblaud) {
    return { action: 'none', message: 'não estava instalado' };
  }

  const hooks = { ...existingHooks };
  const updatedHabblaud = { ...currentHabblaud };
  const preToolUseList: unknown[] = Array.isArray(updatedHabblaud.PreToolUse) ? [...updatedHabblaud.PreToolUse] : [];

  const newPreToolUse: unknown[] = [];
  let removedCount = 0;

  for (const item of preToolUseList) {
    const group = rec(item);
    if (!group || !Array.isArray(group.hooks)) {
      newPreToolUse.push(item);
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
      newPreToolUse.push({ ...group, hooks: filteredHooks });
    }
  }

  if (removedCount === 0) {
    return { action: 'none', message: 'nenhum hook do Habblaud encontrado' };
  }

  // Se PreToolUse ficou vazio e não há outros eventos configurados no bloco habblaud-permissions, remove a entrada.
  // Se ainda existirem outros eventos ou hooks de terceiros, preserva o restante do objeto.
  const otherKeys = Object.keys(updatedHabblaud).filter((k) => k !== 'enabled' && k !== 'PreToolUse');
  if (newPreToolUse.length === 0 && otherKeys.length === 0) {
    delete hooks['habblaud-permissions'];
  } else {
    if (newPreToolUse.length > 0) {
      updatedHabblaud.PreToolUse = newPreToolUse;
    } else {
      delete updatedHabblaud.PreToolUse;
    }
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
