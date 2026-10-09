// Testes das contas do Antigravity: descoberta de pastas, letras, cores e metadados.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  detectAntigravityAccounts,
  discoverAntigravityDirs,
  isAntigravityHome,
} from './accounts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function home() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const agy = (name: string, withBrain = true) => {
    const dir = join(tmp.dir, name);
    if (withBrain) {
      mkdirSync(join(dir, 'brain'), { recursive: true });
      mkdirSync(join(dir, 'presence'), { recursive: true });
    } else {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  };
  return { dir: tmp.dir, agy };
}

describe('contas do Antigravity', () => {
  it('reconhece pasta do Antigravity por isAntigravityHome', () => {
    const h = home();
    const valid = h.agy('agy-valid', true);
    const empty = h.agy('agy-empty', false);
    expect(isAntigravityHome(valid)).toBe(true);
    expect(isAntigravityHome(empty)).toBe(false);
  });

  it('descoberta de pastas via ANTIGRAVITY_HOME ou ~/.gemini/antigravity-cli', () => {
    const h = home();
    const defaultDir = join(h.dir, '.gemini', 'antigravity-cli');
    mkdirSync(join(defaultDir, 'brain'), { recursive: true });

    const found = discoverAntigravityDirs({}, h.dir);
    expect(found).toContain(defaultDir);

    const custom = h.agy('custom-agy', true);
    const foundWithEnv = discoverAntigravityDirs({ ANTIGRAVITY_HOME: custom }, h.dir);
    expect(foundWithEnv[0]).toBe(custom);
  });

  it('detecta contas e gera nomes e letras', () => {
    const h = home();
    const d1 = h.agy('agy-1', true);
    const d2 = h.agy('agy-2', true);

    const accounts = detectAntigravityAccounts([d1, d2], { home: h.dir });
    expect(accounts).toHaveLength(2);
    expect(accounts[0].provider).toBe('antigravity');
    expect(accounts[0].name).toBe('Antigravity A');
    expect(accounts[1].provider).toBe('antigravity');
    expect(accounts[0].plan).toBe('Subscription');
  });
});
