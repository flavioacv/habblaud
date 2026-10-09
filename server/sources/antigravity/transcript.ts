// Parser de eventos e transcrições do Antigravity (brain/<conversation-id>/.system_generated/logs/transcript.jsonl).
// Converte passos (step_index, source, type, thinking, tool_calls, tokens...) em atividades e estado para o Office.
import { describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { AccountUsage, Activity, AgentStats, UsageWindow } from '../../../shared/types';
import type { ParsedActivity } from '../transcript';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

export interface AntigravityState {
  title?: string;
  model?: string;
  stats: AgentStats;
  turnOpen?: boolean;
  firstAt?: number;
  lastAt?: number;
  usage?: AccountUsage;
  current?: { id: string; kind: Activity['kind']; at: number; callId?: string };
}

export function createAntigravityState(): AntigravityState {
  return {
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
  };
}

export type AntigravitySignal =
  | { type: 'turnStart' }
  | { type: 'turnEnd'; aborted: boolean }
  | { type: 'usage'; usage: AccountUsage }
  | { type: 'subagentSpawn'; count: number };

export interface AntigravityLineResult {
  activities: ParsedActivity[];
  signals: AntigravitySignal[];
  changed: boolean;
  at: number;
}

export interface AntigravityParseContext {
  idPrefix: string;
  now: number;
  activities?: boolean;
}

/** Descreve ferramentas nativas do Antigravity para formato legível de atividades do Habblaud. */
export function describeAntigravityTool(rawName: string, rawArgs: unknown): { desc: ActivityDescription; tool: string } {
  const args = rec(rawArgs) ?? {};
  switch (rawName) {
    case 'run_command': {
      const command = str(args.CommandLine) ?? '';
      return { desc: describeTool('Bash', { command, description: args.toolSummary ?? args.toolAction }), tool: 'Bash' };
    }
    case 'view_file': {
      const filePath = str(args.AbsolutePath) ?? 'arquivo';
      return { desc: describeTool('Read', { file_path: filePath }), tool: 'Read' };
    }
    case 'replace_file_content': {
      const filePath = str(args.TargetFile) ?? 'arquivo';
      return { desc: describeTool('Edit', { file_path: filePath }), tool: 'Edit' };
    }
    case 'write_to_file': {
      const filePath = str(args.TargetFile) ?? 'arquivo';
      return { desc: describeTool('Write', { file_path: filePath }), tool: 'Write' };
    }
    case 'search_web': {
      const q = str(args.query) ?? '';
      return { desc: describeTool('WebSearch', { query: q }), tool: 'WebSearch' };
    }
    case 'read_url_content': {
      const url = str(args.Url) ?? '';
      return { desc: describeTool('WebSearch', { query: url }), tool: 'WebSearch' };
    }
    case 'call_mcp_tool': {
      const server = str(args.ServerName) ?? 'mcp';
      const tool = str(args.ToolName) ?? 'tool';
      const fullName = `mcp__${server}__${tool}`;
      return { desc: describeTool(fullName, rec(args.Arguments) ?? {}), tool: fullName };
    }
    case 'invoke_subagent': {
      const subagents = Array.isArray(args.Subagents) ? args.Subagents : [];
      const first = rec(subagents[0]);
      const role = str(first?.Role) ?? 'Subagente';
      const prompt = str(first?.Prompt);
      return { desc: describeTool('Agent', { description: prompt ? truncate(prompt, 60) : role, subagent_type: role }), tool: 'Agent' };
    }
    case 'ask_question': {
      return { desc: describeTool('AskUserQuestion', { questions: args.questions }), tool: 'AskUserQuestion' };
    }
    case 'manage_task':
    case 'schedule': {
      return { desc: { kind: 'wait', icon: '⏱️', text: 'Gerenciando tarefas agendadas' }, tool: rawName };
    }
    default:
      return { desc: describeTool(rawName, args), tool: rawName };
  }
}

/** Interpreta uma linha de transcript.jsonl do Antigravity. */
export function parseAntigravityLine(rawLine: string, s: AntigravityState, ctx: AntigravityParseContext): AntigravityLineResult {
  const lineAt = ctx.now;
  const out: AntigravityLineResult = {
    activities: [],
    signals: [],
    changed: false,
    at: lineAt,
  };

  let j: Rec;
  try {
    const parsed = JSON.parse(rawLine) as unknown;
    if (!rec(parsed)) return out;
    j = parsed as Rec;
  } catch {
    return out;
  }

  const createdAt = toMs(j.created_at) ?? lineAt;
  out.at = createdAt;
  if (!s.firstAt) s.firstAt = createdAt;
  s.lastAt = Math.max(s.lastAt ?? 0, createdAt);

  const stepIndex = num(j.step_index) ?? 0;
  const type = str(j.type);
  const source = str(j.source);

  // Helper para adicionar atividade
  const pushActivity = (desc: ActivityDescription, opts: { key?: string; tool?: string; current?: boolean; durationMs?: number; callId?: string } = {}) => {
    if (ctx.activities === false) return;
    const key = opts.key ?? `step-${stepIndex}`;
    const activity: Activity = {
      id: `${ctx.idPrefix}#${key}`,
      at: createdAt,
      ...desc,
    };
    if (opts.tool) activity.tool = opts.tool;
    if (opts.durationMs !== undefined) activity.durationMs = opts.durationMs;
    if (desc.kind === 'error') activity.error = true;
    const current = opts.current ?? true;
    out.activities.push(opts.callId ? { activity, current, toolUseId: opts.callId } : { activity, current });
    if (current) s.current = { id: activity.id, kind: desc.kind, at: createdAt, callId: opts.callId };
  };

  // Tokens consumidos
  const inTokens = num(j.input_tokens) ?? 0;
  const outTokens = num(j.output_tokens) ?? 0;
  const cacheTokens = num(j.cache_read_tokens) ?? 0;
  if (inTokens > 0 || outTokens > 0 || cacheTokens > 0) {
    s.stats.tokensIn += inTokens + cacheTokens;
    s.stats.tokensOut += outTokens;
    out.changed = true;

    // Constrói ou atualiza AccountUsage do Antigravity baseado no consumo
    const usage: AccountUsage = {
      source: 'antigravity',
      fetchedAt: createdAt,
      fiveHour: { utilization: Math.min(100, Math.round((s.stats.tokensIn / 1_000_000) * 100)) },
      sevenDay: { utilization: Math.min(100, Math.round(((s.stats.tokensIn + s.stats.tokensOut) / 5_000_000) * 100)) },
    };
    s.usage = usage;
    out.signals.push({ type: 'usage', usage });
  }

  // 1. Prompt do usuário (USER_INPUT)
  if (type === 'USER_INPUT' || source === 'USER_EXPLICIT') {
    const content = str(j.content);
    if (content) {
      if (!s.title) {
        s.title = truncate(maskSecrets(content.slice(0, 500)), 90);
        out.changed = true;
      }
      s.turnOpen = true;
      out.signals.push({ type: 'turnStart' });
      pushActivity(describePrompt(content), { key: `prompt-${stepIndex}` });
    }
    return out;
  }

  // 2. Resposta do modelo / planejamento (PLANNER_RESPONSE)
  if (type === 'PLANNER_RESPONSE') {
    // Thinking
    const thinking = str(j.thinking);
    if (thinking) {
      pushActivity(SPECIAL.think(), { key: `think-${stepIndex}` });
    }

    // Ferramentas chamadas
    const toolCalls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
    if (toolCalls.length > 0) {
      s.stats.toolCalls += toolCalls.length;
      out.changed = true;

      toolCalls.forEach((tc, idx) => {
        const item = rec(tc);
        if (!item) return;
        const name = str(item.name) ?? 'tool';
        const { desc, tool } = describeAntigravityTool(name, item.args);

        if (name === 'invoke_subagent') {
          s.stats.subagents++;
          out.signals.push({ type: 'subagentSpawn', count: 1 });
        }

        const callId = `call-${stepIndex}-${idx}`;
        pushActivity(desc, { key: callId, tool, callId });
      });
    } else {
      // Resposta em texto finalizando ou comunicando
      const content = str(j.content);
      if (content) {
        pushActivity(SPECIAL.respond(content), { key: `resp-${stepIndex}` });
      }
      if (j.status === 'DONE') {
        s.turnOpen = false;
        out.signals.push({ type: 'turnEnd', aborted: false });
        pushActivity(SPECIAL.turnDone(), { key: `done-${stepIndex}`, current: false });
      }
    }

    return out;
  }

  // 3. Resultado de execução genérica (GENERIC)
  if (type === 'GENERIC') {
    const status = str(j.status);
    const err = str(j.error);
    if (status === 'ERROR' || err) {
      pushActivity(SPECIAL.error(undefined, truncate(err ?? 'Erro na execução', 140)), {
        key: `err-${stepIndex}`,
        current: false,
      });
    }
    return out;
  }

  return out;
}
