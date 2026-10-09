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
    expect(state.usage).toBeDefined();
    expect(state.usage?.source).toBe('antigravity');

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
