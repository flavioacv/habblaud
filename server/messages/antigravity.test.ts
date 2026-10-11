// Runner do `agy agentapi send-message`: executável falso, nunca a sessão Antigravity real.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import {
  createAntigravityMessageRunner,
  type AntigravityMessageJob,
} from './antigravity';

const CONVERSATION = 'de08e85e-ca49-4fa3-869d-19be268a2ec0';
const OTHER_CONVERSATION = 'c27442cf-8605-49d6-9a0b-1260197918fa';

let tmp: ReturnType<typeof tempDir>;
let bin: string;
let log: string;

beforeEach(() => {
  tmp = tempDir();
  const binDir = join(tmp.dir, 'bin');
  mkdirSync(binDir);
  bin = join(binDir, 'agy');
  log = join(tmp.dir, 'calls.json');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(args));
const mode = process.env.FAKE_AGY_MODE;
if (mode === 'invalid-json') {
  process.stdout.write('not-json');
} else {
  const recipientId = mode === 'wrong-recipient' ? ${JSON.stringify(OTHER_CONVERSATION)} : args[2];
  const output = { response: { sendMessage: { recipientId, content: args[3] } } };
  const emit = () => process.stdout.write(JSON.stringify(output));
  if (mode === 'timeout') setTimeout(emit, 2_000);
  else emit();
}
`,
    'utf8',
  );
  chmodSync(bin, 0o755);
});

afterEach(() => tmp.cleanup());

const job = (over: Partial<AntigravityMessageJob> = {}): AntigravityMessageJob => ({
  conversationId: CONVERSATION,
  text: 'Responda com análise\n-- sem executar comandos',
  ...over,
});

function runner(mode: string, timeoutMs = 2_000) {
  return createAntigravityMessageRunner(bin, {
    timeoutMs,
    env: { PATH: process.env.PATH, FAKE_AGY_MODE: mode, FAKE_AGY_LOG: log },
  });
}

describe('agy agentapi send-message (binário falso)', () => {
  it('confirma a entrega e preserva os argumentos como valores separados', async () => {
    expect(await runner('success')(job())).toEqual({ ok: true });
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual([
      'agentapi',
      'send-message',
      CONVERSATION,
      'Responda com análise\n-- sem executar comandos',
    ]);
  });

  it('transforma timeout em erro controlado', async () => {
    expect(await runner('timeout', 500)(job())).toEqual({
      ok: false,
      error: 'o agy agentapi não respondeu em 1 s',
    });
  });

  it('rejeita JSON inválido', async () => {
    expect(await runner('invalid-json')(job())).toEqual({
      ok: false,
      error: 'o agy agentapi retornou uma resposta inválida',
    });
  });

  it('rejeita confirmação para outro recipientId', async () => {
    expect(await runner('wrong-recipient')(job())).toEqual({
      ok: false,
      error: 'o Antigravity confirmou um destinatário diferente da conversa solicitada',
    });
  });
});
