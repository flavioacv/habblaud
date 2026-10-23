import { describe, expect, it } from 'vitest';
import {
  createAntigravityState,
  describeAntigravityTool,
  parseAntigravityLine,
} from './transcript';

describe('Antigravity transcript parser', () => {
  it('descreve ferramentas nativas do Antigravity', () => {
    const cmd = describeAntigravityTool('run_command', { CommandLine: 'npm test' });
    expect(cmd.tool).toBe('Bash');
    expect(cmd.desc.kind).toBe('test');
    expect(cmd.desc.detail).toBe('npm test');

    const cmdRun = describeAntigravityTool('run_command', { CommandLine: 'python main.py' });
    expect(cmdRun.tool).toBe('Bash');
    expect(cmdRun.desc.kind).toBe('run');

    const read = describeAntigravityTool('view_file', { AbsolutePath: '/path/to/file.ts' });
    expect(read.tool).toBe('Read');
    expect(read.desc.kind).toBe('read');

    const edit = describeAntigravityTool('replace_file_content', { TargetFile: '/path/to/file.ts' });
    expect(edit.tool).toBe('Edit');
    expect(edit.desc.kind).toBe('edit');

    const write = describeAntigravityTool('write_to_file', { TargetFile: '/path/to/file.ts' });
    expect(write.tool).toBe('Write');
    expect(write.desc.kind).toBe('write');

    const agent = describeAntigravityTool('invoke_subagent', {
      Subagents: [{ Role: 'Code Researcher', Prompt: 'Pesquise testes' }],
    });
    expect(agent.tool).toBe('Agent');
    expect(agent.desc.kind).toBe('delegate');

    const ask = describeAntigravityTool('ask_question', {
      questions: [{ question: 'Continuar?', options: ['Sim', 'Não'] }],
    });
    expect(ask.tool).toBe('AskUserQuestion');

    const readFile = describeAntigravityTool('read_file', { Path: '/path/to/file.ts' });
    expect(readFile.tool).toBe('Read');
    expect(readFile.desc.kind).toBe('read');

    const editFile = describeAntigravityTool('edit_file', { Path: '/path/to/file.ts', Target: 'a', Replacement: 'b' });
    expect(editFile.tool).toBe('Edit');
    expect(editFile.desc.kind).toBe('edit');

    const writeFile = describeAntigravityTool('write_file', { Path: '/path/to/file.ts', Content: 'hello' });
    expect(writeFile.tool).toBe('Write');
    expect(writeFile.desc.kind).toBe('write');

    const modernAgent = describeAntigravityTool('invoke_subagent', {
      Role: 'Codebase Researcher',
      Prompt: 'Pesquisar arquivos de teste',
      TypeName: 'researcher',
    });
    expect(modernAgent.tool).toBe('Agent');
    expect(modernAgent.desc.kind).toBe('delegate');

    const defineSub = describeAntigravityTool('define_subagent', {
      Name: 'test-runner',
      Description: 'Roda testes',
    });
    expect(defineSub.tool).toBe('define_subagent');
    expect(defineSub.desc.kind).toBe('delegate');

    const manageSubs = describeAntigravityTool('manage_subagents', {
      Action: 'kill',
      ConversationIds: ['c1'],
    });
    expect(manageSubs.tool).toBe('manage_subagents');
    expect(manageSubs.desc.kind).toBe('delegate');

    const sendMsg = describeAntigravityTool('send_message', {
      Recipient: 'subagent-1',
      Message: 'Olá',
    });
    expect(sendMsg.tool).toBe('send_message');
    expect(sendMsg.desc.kind).toBe('communicate');

    const readRes = describeAntigravityTool('read_resource', {
      ServerName: 'filesystem',
      Uri: 'file:///tmp',
    });
    expect(readRes.tool).toBe('read_resource');
    expect(readRes.desc.kind).toBe('read');
  });

  it('detecta spawn e done de subagentes', () => {
    const state = createAntigravityState();
    const spawnLine = JSON.stringify({
      step_index: 10,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-10-09T12:00:10Z',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            Role: 'Test Runner',
            Prompt: 'Rodar npm test',
          },
        },
      ],
    });

    const res1 = parseAntigravityLine(spawnLine, state, { idPrefix: 'antigravity:conv1', now: 1000 });
    expect(state.stats.subagents).toBe(1);
    expect(res1.signals).toHaveLength(1);
    expect(res1.signals[0].type).toBe('subagentSpawn');
    if (res1.signals[0].type === 'subagentSpawn') {
      expect(res1.signals[0].subagent?.role).toBe('Test Runner');
    }

    const genericLine = JSON.stringify({
      step_index: 11,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Subagente completou com sucesso',
      created_at: '2026-10-09T12:00:15Z',
    });

    const res2 = parseAntigravityLine(genericLine, state, { idPrefix: 'antigravity:conv1', now: 2000 });
    expect(res2.signals).toEqual([{ type: 'subagentDone', callId: 'call-10-0' }]);
  });

  it('detecta eventos do GitHub em run_command', () => {
    const state = createAntigravityState();
    const callLine = JSON.stringify({
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-10-09T12:00:00Z',
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: 'gh pr create --title "Add Antigravity" --body "Detalhes"',
          },
        },
      ],
    });

    const res1 = parseAntigravityLine(callLine, state, { idPrefix: 'antigravity:conv1', now: 1000 });
    expect(state.stats.toolCalls).toBe(1);

    const resultLine = JSON.stringify({
      step_index: 6,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'https://github.com/marmottajr/habblaud/pull/123\n',
      created_at: '2026-10-09T12:00:03Z',
    });

    const res2 = parseAntigravityLine(resultLine, state, { idPrefix: 'antigravity:conv1', now: 4000 });
    expect(res2.signals).toHaveLength(1);
    expect(res2.signals[0].type).toBe('github');
    if (res2.signals[0].type === 'github') {
      expect(res2.signals[0].event.kind).toBe('pr_opened');
      expect(res2.signals[0].event.number).toBe(123);
    }
  });

  it('interpreta USER_INPUT e inicia turno', () => {
    const state = createAntigravityState();
    const line = JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Crie uma nova feature',
      created_at: '2026-10-09T12:00:00Z',
    });

    const res = parseAntigravityLine(line, state, { idPrefix: 'antigravity:conv1', now: 1000 });
    expect(state.title).toBe('Crie uma nova feature');
    expect(state.turnOpen).toBe(true);
    expect(res.signals).toEqual([{ type: 'turnStart' }]);
    expect(res.activities).toHaveLength(1);
    expect(res.activities[0].activity.kind).toBe('prompt');
  });

  it('interpreta PLANNER_RESPONSE com thinking e tool_calls', () => {
    const state = createAntigravityState();
    const line = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-10-09T12:00:05Z',
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 500,
      thinking: 'Pensando na melhor abordagem...',
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: 'npm test' },
        },
      ],
    });

    const res = parseAntigravityLine(line, state, { idPrefix: 'antigravity:conv1', now: 1000 });
    expect(state.stats.toolCalls).toBe(1);
    expect(state.stats.tokensIn).toBe(1500);
    expect(state.stats.tokensOut).toBe(200);

    // Atividades: thinking + chamada de ferramenta (npm test -> test)
    expect(res.activities).toHaveLength(2);
    expect(res.activities[0].activity.kind).toBe('think');
    expect(res.activities[1].activity.kind).toBe('test');
  });

  it('interpreta GENERIC de erro', () => {
    const state = createAntigravityState();
    const line = JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'ERROR',
      error: 'Command failed with exit code 1',
      created_at: '2026-10-09T12:00:10Z',
    });

    const res = parseAntigravityLine(line, state, { idPrefix: 'antigravity:conv1', now: 1000 });
    expect(res.activities).toHaveLength(1);
    expect(res.activities[0].activity.kind).toBe('error');
    expect(res.activities[0].activity.error).toBe(true);
  });
});
