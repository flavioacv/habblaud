import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../test/fixtures';
import { AccountsService } from '../../accounts/service';
import { Office } from '../../model/office';
import { AntigravitySource } from './source';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe('AntigravitySource', () => {
  it('registra conta e atualiza quota via refreshQuota', async () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);

    const agyDir = join(tmp.dir, 'antigravity-cli');
    mkdirSync(join(agyDir, 'presence'), { recursive: true });
    writeFileSync(join(agyDir, 'history.jsonl'), '');

    const office = new Office({} as any);
    const accounts = new AccountsService({
      dirs: [],
      home: tmp.dir,
      env: {},
      onChange: () => {},
    });

    const mockUsage = {
      source: 'antigravity' as const,
      fetchedAt: Date.now(),
      fiveHour: { utilization: 28.5 },
      sevenDay: { utilization: 8.6 },
    };

    const source = new AntigravitySource({
      accounts,
      office,
      dirs: [agyDir],
      home: tmp.dir,
      env: {},
      fetchUsage: async () => mockUsage,
    });

    source.start();
    await source.refreshQuota();

    const accs = accounts.list(new Map());
    const agyAcc = accs.find((a) => a.provider === 'antigravity');
    expect(agyAcc).toBeDefined();
    expect(agyAcc?.usageStatus).toBe('ok');
    expect(agyAcc?.usage?.fiveHour?.utilization).toBe(28.5);
    expect(agyAcc?.usage?.sevenDay?.utilization).toBe(8.6);

    source.stop();
  });

  it('recupera workspace do SQLite quando ausente no history.jsonl', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);

    const agyDir = join(tmp.dir, 'antigravity-cli');
    mkdirSync(join(agyDir, 'presence'), { recursive: true });
    mkdirSync(join(agyDir, 'conversations'), { recursive: true });
    mkdirSync(join(agyDir, 'brain', 'conv-123', '.system_generated', 'logs'), { recursive: true });
    writeFileSync(join(agyDir, 'history.jsonl'), '');

    // Cria banco SQLite com trajectory_metadata_blob
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = join(agyDir, 'conversations', 'conv-123.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY, data blob);');
    const payload = Buffer.from('\x10\x01file:///Volumes/Projetos/meu-app\x12\x05extra');
    db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', payload);
    db.close();

    writeFileSync(join(agyDir, 'presence', 'conv-123.lock'), '');
    writeFileSync(join(agyDir, 'brain', 'conv-123', '.system_generated', 'logs', 'transcript.jsonl'), '{"step_index":0,"source":"MODEL","type":"PLANNER_RESPONSE","content":"ok"}\n');

    let addedMain: any = null;
    const office = {
      beginBoot: () => {},
      endBoot: () => {},
      addMain: (m: any) => { addedMain = m; },
      has: () => true,
      addActivity: () => {},
      setStatus: () => {},
      applyTranscript: () => {},
      closeMain: () => {},
    } as any;

    const accounts = {
      setProviderAccounts: (_provider: string, list: any[]) =>
        list.map((item, idx) => ({ id: `antigravity-${idx}`, dir: item.dir, detected: item.detected })),
      setUsage: () => {},
    } as any;

    const source = new AntigravitySource({
      accounts,
      office,
      dirs: [agyDir],
      home: tmp.dir,
      env: {},
    });

    source.start();
    expect(addedMain).toBeDefined();
    expect(addedMain?.cwd).toBe('/Volumes/Projetos/meu-app');
    source.stop();
  });

  it('não entra no escritório com acc.dir quando o projeto ainda é desconhecido', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);

    const agyDir = join(tmp.dir, 'antigravity-cli');
    mkdirSync(join(agyDir, 'presence'), { recursive: true });
    mkdirSync(join(agyDir, 'brain', 'conv-sem-projeto', '.system_generated', 'logs'), { recursive: true });
    writeFileSync(join(agyDir, 'history.jsonl'), '');

    // Sessão sem DB SQLite e sem histórico
    writeFileSync(join(agyDir, 'presence', 'conv-sem-projeto.lock'), '');
    writeFileSync(join(agyDir, 'brain', 'conv-sem-projeto', '.system_generated', 'logs', 'transcript.jsonl'), '{"step_index":0,"source":"MODEL","type":"PLANNER_RESPONSE","content":"ok"}\n');

    let addedMain: any = null;
    const office = {
      beginBoot: () => {},
      endBoot: () => {},
      addMain: (m: any) => { addedMain = m; },
      has: () => true,
      addActivity: () => {},
      setStatus: () => {},
      applyTranscript: () => {},
      closeMain: () => {},
    } as any;

    const accounts = {
      setProviderAccounts: (_provider: string, list: any[]) =>
        list.map((item, idx) => ({ id: `antigravity-${idx}`, dir: item.dir, detected: item.detected })),
      setUsage: () => {},
    } as any;

    const source = new AntigravitySource({
      accounts,
      office,
      dirs: [agyDir],
      home: tmp.dir,
      env: {},
    });

    source.start();
    // Como o projeto é desconhecido, NÃO deve ter entrado com agyDir (antigravity-cli)
    expect(addedMain).toBeNull();
    source.stop();
  });
});
