import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { handlerFor, hasActiveHandler, hookCommand, isOurHandler, planInstall, planUninstall } from '../../scripts/antigravity-install';
import { servePermissions } from './permission-server';

const HOOK = resolve(__dirname, '../../mod/habblaud-antigravity/hook.mjs');
interface HookModule {
  permissionBody(input: unknown, timeoutMs: number): Record<string, unknown>;
  decisionOutput(result: unknown): unknown;
  run(env?: Record<string, string>, stdinText?: string): Promise<unknown>;
}
const hook = (await import(pathToFileURL(HOOK).href)) as HookModule;

describe('Antigravity Hooks & Permissions', () => {
  describe('antigravity-install.ts', () => {
    const cmd = hookCommand('/path/to/habblaud/mod/habblaud-antigravity/hook.mjs');

    it('identifica corretamente o comando e nosso handler', () => {
      expect(cmd).toBe('node "/path/to/habblaud/mod/habblaud-antigravity/hook.mjs"');
      expect(isOurHandler({ command: cmd })).toBe(true);
      expect(isOurHandler({ command: 'other-hook' })).toBe(false);
    });

    it('planeja instalação preservando outros hooks', () => {
      const existing = {
        'other-hook': {
          PreToolUse: [{ matcher: 'run_command', hooks: [{ command: 'lint.sh' }] }],
        },
      };

      const plan = planInstall(existing, cmd, 25);
      expect(plan.action).toBe('install');
      const habblaud = plan.hooks?.['habblaud-permissions'] as any;
      expect(plan.hooks?.['other-hook']).toBeDefined();
      expect(habblaud).toBeDefined();
      expect(habblaud?.PreToolUse[0]?.matcher).toBe('*');
      expect(habblaud?.PreToolUse[0]?.hooks[0]?.command).toBe(cmd);
      expect(habblaud?.PreToolUse[0]?.hooks[0]?.timeout).toBe(35);
    });

    it('planeja instalação preservando outros handlers no próprio bloco habblaud-permissions', () => {
      const existing = {
        'habblaud-permissions': {
          enabled: true,
          PreToolUse: [{ matcher: 'custom', hooks: [{ command: 'my-custom-hook' }] }],
          PostToolUse: [{ matcher: '*', hooks: [{ command: 'post-hook' }] }],
        },
      };

      const plan = planInstall(existing, cmd, 25);
      expect(plan.action).toBe('install');
      const habblaud = plan.hooks?.['habblaud-permissions'] as any;
      expect(habblaud.PostToolUse).toBeDefined();
      expect(habblaud.PreToolUse).toHaveLength(2);
      expect(habblaud.PreToolUse[0].matcher).toBe('custom');
      expect(habblaud.PreToolUse[1].matcher).toBe('*');
      expect(habblaud.PreToolUse[1].hooks[0].command).toBe(cmd);
    });

    it('isola o handler do Habblaud em grupo próprio com matcher "*" se ele estiver co-localizado com outros handlers em grupo restrito', () => {
      const existing = {
        'habblaud-permissions': {
          enabled: true,
          PreToolUse: [
            {
              matcher: 'run_command',
              hooks: [
                { command: 'security-check.sh', type: 'command' },
                { command: cmd, type: 'command', timeout: 35 },
              ],
            },
          ],
        },
      };

      const plan = planInstall(existing, cmd, 25);
      expect(plan.action).toBe('install');
      const habblaud = plan.hooks?.['habblaud-permissions'] as any;
      expect(habblaud.PreToolUse).toHaveLength(2);
      // O grupo original mantém seu matcher restrito e o outro handler intacto:
      expect(habblaud.PreToolUse[0].matcher).toBe('run_command');
      expect(habblaud.PreToolUse[0].hooks).toHaveLength(1);
      expect(habblaud.PreToolUse[0].hooks[0].command).toBe('security-check.sh');
      // O handler do Habblaud foi movido para seu próprio grupo com matcher "*":
      expect(habblaud.PreToolUse[1].matcher).toBe('*');
      expect(habblaud.PreToolUse[1].hooks).toHaveLength(1);
      expect(habblaud.PreToolUse[1].hooks[0].command).toBe(cmd);
    });

    it('planeja desinstalação preservando outros handlers no próprio bloco habblaud-permissions', () => {
      const existing = {
        'habblaud-permissions': {
          enabled: true,
          PreToolUse: [
            { matcher: 'custom', hooks: [{ command: 'my-custom-hook' }] },
            { matcher: '*', hooks: [{ command: cmd }] },
          ],
        },
      };
      const plan = planUninstall(existing);
      expect(plan.action).toBe('uninstall');
      const habblaud = plan.hooks?.['habblaud-permissions'] as any;
      expect(habblaud).toBeDefined();
      expect(habblaud.PreToolUse).toHaveLength(1);
      expect(habblaud.PreToolUse[0].matcher).toBe('custom');
    });

    it('planeja desinstalação completa quando só havia o hook do Habblaud', () => {
      const existing = {
        'habblaud-permissions': {
          enabled: true,
          PreToolUse: [{ matcher: '*', hooks: [{ command: cmd }] }],
        },
        'other-hook': { enabled: true },
      };
      const plan = planUninstall(existing);
      expect(plan.action).toBe('uninstall');
      expect(plan.hooks?.['habblaud-permissions']).toBeUndefined();
      expect(plan.hooks?.['other-hook']).toBeDefined();
    });

    it('instala e desinstala múltiplos eventos do ciclo de vida (PreToolUse, SessionStart, Stop)', () => {
      const plan = planInstall({}, cmd, 25);
      expect(plan.action).toBe('install');
      const habblaud = plan.hooks?.['habblaud-permissions'] as any;
      expect(habblaud.PreToolUse).toBeDefined();
      expect(habblaud.SessionStart).toBeDefined();
      expect(habblaud.Stop).toBeDefined();
      expect(habblaud.PreToolUse[0].hooks[0].command).toBe(cmd);
      expect(habblaud.SessionStart[0].hooks[0].command).toBe(cmd);
      expect(habblaud.Stop[0].hooks[0].command).toBe(cmd);

      const unplan = planUninstall(plan.hooks!);
      expect(unplan.action).toBe('uninstall');
      expect(unplan.hooks?.['habblaud-permissions']).toBeUndefined();
    });

    it('hasActiveHandler valida se o hook está realmente configurado e habilitado', () => {
      expect(hasActiveHandler({})).toBe(false);
      expect(hasActiveHandler({ 'habblaud-permissions': { enabled: false } })).toBe(false);
      expect(hasActiveHandler({ 'habblaud-permissions': { enabled: true, PreToolUse: [] } })).toBe(false);
      expect(hasActiveHandler({ 'habblaud-permissions': { enabled: true, PreToolUse: [{ hooks: [{ command: 'other' }] }] } })).toBe(false);
      expect(hasActiveHandler({ 'habblaud-permissions': { enabled: true, PreToolUse: [{ hooks: [{ command: cmd }] }] } }, cmd)).toBe(true);
    });
  });

  describe('mod/habblaud-antigravity/hook.mjs', () => {
    it('formata permissionBody a partir do payload PreToolUse do Antigravity', () => {
      const input = {
        conversationId: 'conv-1234',
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'ls -la' },
        },
        workspacePaths: ['/workspace/app'],
        stepIdx: 5,
      };

      const body = hook.permissionBody(input, 25_000);
      expect(body).toEqual({
        provider: 'antigravity',
        session_id: 'conv-1234',
        tool_name: 'run_command',
        tool_input: { CommandLine: 'ls -la' },
        timeout_ms: 25_000,
        cwd: '/workspace/app',
      });
    });

    it('converte decisões para o contrato do Antigravity PreToolUse', () => {
      expect(hook.decisionOutput({ status: 'decided', behavior: 'allow' })).toEqual({
        decision: 'allow',
      });

      expect(hook.decisionOutput({ status: 'decided', behavior: 'allow', permissionOverrides: ['run_command'] })).toEqual({
        decision: 'allow',
        permissionOverrides: ['run_command'],
      });

      expect(hook.decisionOutput({ status: 'decided', behavior: 'allow', remember: true, tool_name: 'edit_file' })).toEqual({
        decision: 'allow',
        permissionOverrides: ['edit_file'],
      });

      expect(hook.decisionOutput({ status: 'decided', behavior: 'deny', message: 'Bloqueado' })).toEqual({
        decision: 'deny',
        reason: 'Recusado pelo usuário no Habblaud: Bloqueado',
      });

      expect(hook.decisionOutput({ status: 'released', reason: 'terminal' })).toEqual({
        decision: 'ask',
      });

      expect(hook.decisionOutput({ status: 'pending' })).toEqual({
        decision: 'ask',
      });
    });
  });

  describe('Execução do hook contra o servidor HTTP', () => {
    it('registra o pedido no servidor e retorna allow quando aprovado pelo Habblaud', async () => {
      const srv = await servePermissions({ antigravity: true });
      const env = { HABBLAUD_PORT: String(srv.port), HABBLAUD_PERMISSION_TIMEOUT: '5' };

      const input = {
        conversationId: 'conv-123',
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'npm test' },
        },
        workspacePaths: ['/p/loja'],
      };

      const hookPromise = hook.run(env, JSON.stringify(input));

      // Espera o pedido aparecer no registry
      await new Promise((r) => setTimeout(r, 50));
      const snap = srv.registry?.snapshot();
      const agentPerm = snap?.get('antigravity-cli:conv-123');
      expect(agentPerm).toBeDefined();
      expect(agentPerm?.tool).toBe('run_command');

      // Aprova pelo Habblaud
      srv.registry?.decide(agentPerm!.id, { behavior: 'allow' });

      const output = await hookPromise;
      expect(output).toEqual({ decision: 'allow' });

      await srv.close();
    });

    it('registra e processa perguntas interativas ask_question', async () => {
      const srv = await servePermissions({ antigravity: true });
      const env = { HABBLAUD_PORT: String(srv.port), HABBLAUD_PERMISSION_TIMEOUT: '5' };

      const input = {
        conversationId: 'conv-123',
        toolCall: {
          name: 'ask_question',
          args: {
            questions: [
              {
                question: 'Deseja rodar os testes?',
                options: ['Sim', 'Não'],
                is_multi_select: false,
              },
            ],
          },
        },
        workspacePaths: ['/p/loja'],
      };

      const hookPromise = hook.run(env, JSON.stringify(input));
      await new Promise((r) => setTimeout(r, 50));
      const snap = srv.registry?.snapshot();
      const agentPerm = snap?.get('antigravity-cli:conv-123');
      expect(agentPerm).toBeDefined();
      expect(agentPerm?.questions).toHaveLength(1);
      expect(agentPerm?.questions?.[0].question).toBe('Deseja rodar os testes?');

      srv.registry?.decide(agentPerm!.id, {
        behavior: 'answer',
        answers: [{ question: 0, options: [0] }],
      });

      const output = await hookPromise;
      expect(output).toEqual({ decision: 'allow' });

      await srv.close();
    });
  });
});
