// Contas do Antigravity: uma pasta de dados por conta (~/.gemini/antigravity-cli, etc.). Node puro e sem
// dependências do servidor: também pode ser importado por scripts.
//
// Descoberta: HABBLAUD_ANTIGRAVITY_DIRS (lista separada por vírgula) substitui tudo; senão ANTIGRAVITY_HOME,
// GEMINI_CLI_HOME ou `$HOME/.gemini/antigravity-cli*` que tenham cara de pasta do Antigravity (isAntigravityHome).
// Letra da conta: o alias de shell `alias x='ANTIGRAVITY_HOME=... agy'`; sem alias, letra derivada ("A", "G", "Y"...).
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Pasta padrão do Antigravity: ANTIGRAVITY_HOME, GEMINI_CLI_HOME ou $HOME/.gemini/antigravity-cli. */
export function defaultAntigravityHome(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string {
  const raw = env.ANTIGRAVITY_HOME?.trim() || env.GEMINI_CLI_HOME?.trim();
  return raw ? expandHome(raw, home) : join(home, '.gemini', 'antigravity-cli');
}

/** Checa se a pasta tem a estrutura do Antigravity (brain, presence, conversations, history.jsonl). */
export function isAntigravityHome(p: string): boolean {
  if (isDir(join(p, 'brain')) || isDir(join(p, 'presence')) || isDir(join(p, 'conversations'))) return true;
  if (isFile(join(p, 'history.jsonl')) || isFile(join(p, 'settings.json'))) return true;
  return false;
}

/**
 * Pastas do Antigravity observadas. HABBLAUD_ANTIGRAVITY_DIRS substitui a detecção.
 * Senão: pasta padrão e outras pastas candidatas em ~/.gemini/ e ~/.antigravity*.
 */
export function discoverAntigravityDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_ANTIGRAVITY_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const found: string[] = [];
  const main = defaultAntigravityHome(env, home);
  if (isAntigravityHome(main)) found.push(main);

  const geminiDir = join(home, '.gemini');
  if (isDir(geminiDir)) {
    try {
      for (const ent of readdirSync(geminiDir, { withFileTypes: true })) {
        if (!ent.name.startsWith('antigravity')) continue;
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        const p = join(geminiDir, ent.name);
        if (isAntigravityHome(p)) found.push(p);
      }
    } catch {
      // ignore
    }
  }

  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.antigravity')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      if (isAntigravityHome(p)) found.push(p);
    }
  } catch {
    // ignore
  }

  const dirs = [...new Set(found.map((p) => expandHome(p, home)))];
  dirs.sort((a, b) => (a === main ? 0 : 1) - (b === main ? 0 : 1) || a.localeCompare(b));
  return dirs;
}

/** Overrides das contas do Antigravity em HABBLAUD_ACCOUNTS. */
export function antigravityOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'antigravity');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

function letterCandidates(dir: string): string[] {
  const suffix = /^\.?(?:antigravity|gemini)[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('A', 'G', 'Y', 'V', 'T');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface AntigravityDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/** Detecta contas do Antigravity para os diretórios fornecidos. */
export function detectAntigravityAccounts(dirs: string[], opts: AntigravityDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = antigravityOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home, 'antigravity'), home, defaultAntigravityHome(env, home));
  const ids = accountIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir));
    return { dir, id: str(ov?.id) ?? ids[i], ov, short: short && !usedShorts.has(short.toUpperCase()) ? short : undefined };
  });
  for (const p of partial) if (p.short) usedShorts.add(p.short.toUpperCase());

  return partial.map((p) => {
    const short = p.short ?? letterCandidates(p.dir).find((l) => !usedShorts.has(l)) ?? 'A';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
      usedColors.add(color);
    }
    const acc: DetectedAccount = {
      id: p.id,
      provider: 'antigravity',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `Antigravity ${short}` : 'Antigravity'),
      color,
    };
    const plan = str(p.ov?.plan);
    if (plan) acc.plan = plan;
    else acc.plan = 'Subscription';
    return acc;
  });
}
