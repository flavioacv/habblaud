import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { AntigravityLive } from '../sources/antigravity/live';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { antigravityAccountOf, parseAntigravityEvent } from './http';

setQuiet(true);

const EVENT = { conversationId: 'conv-1234-abcd', eventType: 'SessionStart', workspacePaths: ['/p/projeto'] };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(live?: AntigravityLive): Promise<{ base: string; accounts: AccountsService }> {
  const tmp = tempDir();
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10 });
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  accounts.setProviderAccounts('antigravity', [
    { dir: '/montada/agy', detected: { id: 'antigravity-cli', configDir: '/Users/flavio/.gemini/antigravity-cli', short: 'G', name: 'Antigravity', color: '#a77bf3' } },
  ]);
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, antigravityLive: live });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  close = () =>
    new Promise((ok) => {
      hub.stop();
      server.closeAllConnections();
      server.close(() => {
        tmp.cleanup();
        ok();
      });
    });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, accounts };
}

describe('POST /api/antigravity/events', () => {
  it('repassa o evento à fonte do Antigravity e devolve {ok}', async () => {
    const calls: Array<[string | undefined, Record<string, unknown>]> = [];
    const { base } = await serve({ applyHookEvent: (a, e) => (calls.push([a, e]), true) });
    const r = await request(base, '/api/antigravity/events', { method: 'POST', body: { account: 'antigravity-cli', event: EVENT } });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    expect(calls).toEqual([['antigravity-cli', EVENT]]);
  });

  it('sem a fonte do Antigravity (ou se ela falha): 200 {ok: false}', async () => {
    const s = await serve();
    expect(await request(s.base, '/api/antigravity/events', { method: 'POST', body: { event: EVENT } })).toMatchObject({ status: 200, json: { ok: false } });
  });

  it('valida o corpo da requisição', () => {
    expect(() => parseAntigravityEvent({})).toThrow();
    expect(() => parseAntigravityEvent({ event: {} })).toThrow();
    expect(parseAntigravityEvent({ event: EVENT })).toEqual({ event: EVENT });
    expect(antigravityAccountOf([], undefined, undefined)).toBeUndefined();
  });
});
