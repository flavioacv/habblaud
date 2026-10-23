// Parser de eventos e transcrições do Antigravity (brain/<conversation-id>/.system_generated/logs/transcript.jsonl).
// Converte passos (step_index, source, type, thinking, tool_calls, tokens...) em atividades e estado para o Office.
import { cleanPromptText, describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { GitHubEvent } from '../../../shared/github';
import type { Activity, AgentStats, TaskItem } from '../../../shared/types';
import { detectGitHubResult, githubCallOf, type GitHubCall } from '../github';
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

export function extractMarkdownTasks(text: string): TaskItem[] {
  const lines = text.split('\n');
  const tasks: TaskItem[] = [];
  let idx = 1;
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s+(.+)$/);
    if (m) {
      const completed = m[1].toLowerCase() === 'x';
      tasks.push({
        id: String(idx++),
        title: truncate(m[2].trim(), 120),
        status: completed ? 'completed' : 'pending',
      });
    }
  }
  return tasks;
}

export interface AntigravityPendingSubagent {
  id: string;
  role: string;
  prompt?: string;
  typeName?: string;
}

export interface AntigravityState {
  title?: string;
  model?: string;
  stats: AgentStats;
  turnOpen?: boolean;
  firstAt?: number;
  lastAt?: number;
  current?: { id: string; kind: Activity['kind']; at: number; callId?: string };
  tasks?: TaskItem[];
  github?: Map<string, GitHubCall>;
  pendingCalls?: Map<string, { tool: string; callId: string; subagent?: AntigravityPendingSubagent }>;
}

export function createAntigravityState(): AntigravityState {
  return {
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    github: new Map(),
    pendingCalls: new Map(),
  };
}

export type AntigravitySignal =
  | { type: 'turnStart' }
  | { type: 'turnEnd'; aborted: boolean }
  | { type: 'subagentSpawn'; count: number; subagent?: AntigravityPendingSubagent; callId?: string }
  | { type: 'subagentDone'; callId: string }
  | { type: 'github'; event: GitHubEvent; toolUseId: string };

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
    case 'read_file':
    case 'view_file': {
      const filePath = str(args.Path) ?? str(args.AbsolutePath) ?? 'arquivo';
      return { desc: describeTool('Read', { file_path: filePath }), tool: 'Read' };
    }
    case 'edit_file':
    case 'replace_file_content': {
      const filePath = str(args.Path) ?? str(args.TargetFile) ?? 'arquivo';
      return { desc: describeTool('Edit', { file_path: filePath }), tool: 'Edit' };
    }
    case 'write_file':
    case 'write_to_file': {
      const filePath = str(args.Path) ?? str(args.TargetFile) ?? 'arquivo';
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
      const role = str(args.Role) ?? str(first?.Role) ?? str(args.TypeName) ?? 'Subagente';
      const prompt = str(args.Prompt) ?? str(first?.Prompt);
      return { desc: describeTool('Agent', { description: prompt ? truncate(prompt, 60) : role, subagent_type: role }), tool: 'Agent' };
    }
    case 'define_subagent': {
      const name = str(args.Name) ?? 'Subagente';
      const desc = str(args.Description);
      return { desc: { kind: 'delegate', icon: '🤖', text: desc ? `Definindo subagente ${name}: ${truncate(desc, 50)}` : `Definindo subagente ${name}` }, tool: rawName };
    }
    case 'manage_subagents': {
      const action = str(args.Action) ?? 'gerenciar';
      return { desc: { kind: 'delegate', icon: '👥', text: `Gerenciando subagentes (${action})` }, tool: rawName };
    }
    case 'send_message': {
      const recipient = str(args.Recipient) ?? 'agente';
      return { desc: { kind: 'communicate', icon: '💬', text: `Mensagem para ${recipient}` }, tool: rawName };
    }
    case 'list_resources':
    case 'read_resource': {
      const server = str(args.ServerName) ?? 'mcp';
      return { desc: { kind: 'read', icon: '📦', text: `Recurso MCP (${server})` }, tool: rawName };
    }
    case 'ask_question': {
      const rawQs = Array.isArray(args.questions) ? args.questions : [];
      const normalizedQs = rawQs.map((item) => {
        const q = rec(item);
        if (!q) return item;
        const rawOpts = Array.isArray(q.options) ? q.options : [];
        const normalizedOpts = rawOpts.map((opt) => (typeof opt === 'string' ? { label: opt } : opt));
        return {
          ...q,
          multiSelect: q.is_multi_select === true || q.multiSelect === true,
          options: normalizedOpts,
        };
      });
      return { desc: describeTool('AskUserQuestion', { questions: normalizedQs }), tool: 'AskUserQuestion' };
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

  // Modelo da sessão
  const rawModel = str(j.model) ?? (rec(j.metadata) ? str(rec(j.metadata)?.model) : undefined);
  if (rawModel && s.model !== rawModel) {
    s.model = rawModel;
    out.changed = true;
  }

  // Tokens consumidos
  const usage = rec(j.usage) ?? rec(j.token_usage) ?? (rec(j.metadata) ? rec(rec(j.metadata)?.usage) : undefined);
  const inTokens = num(j.input_tokens) ?? (usage ? num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? 0 : 0);
  const outTokens = num(j.output_tokens) ?? (usage ? num(usage.candidates_tokens) ?? num(usage.completion_tokens) ?? num(usage.output_tokens) ?? 0 : 0);
  const cacheTokens = num(j.cache_read_tokens) ?? 0;
  if (inTokens > 0 || outTokens > 0 || cacheTokens > 0) {
    s.stats.tokensIn += inTokens + cacheTokens;
    s.stats.tokensOut += outTokens;
    out.changed = true;
  }

  // 1. Prompt do usuário (USER_INPUT)
  if (type === 'USER_INPUT' || source === 'USER_EXPLICIT') {
    const content = str(j.content);
    if (content) {
      const prompt = cleanPromptText(content);
      if (!s.title) {
        s.title = truncate(maskSecrets(prompt.slice(0, 500)), 90);
        out.changed = true;
      }
      s.turnOpen = true;
      out.signals.push({ type: 'turnStart' });
      pushActivity(describePrompt(prompt), { key: `prompt-${stepIndex}` });
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
        const itemArgs = rec(item.args) ?? {};
        const { desc, tool } = describeAntigravityTool(name, itemArgs);
        const callId = `call-${stepIndex}-${idx}`;

        if (name === 'run_command') {
          const cmd = str(itemArgs.CommandLine);
          const gh = cmd ? githubCallOf('Bash', { command: cmd }) : undefined;
          if (gh && s.github) s.github.set(callId, gh);
        }

        if (name === 'invoke_subagent') {
          s.stats.subagents++;
          const subagents = Array.isArray(itemArgs.Subagents) ? itemArgs.Subagents : [];
          const first = rec(subagents[0]);
          const role = str(itemArgs.Role) ?? str(first?.Role) ?? str(itemArgs.TypeName) ?? 'Subagente';
          const prompt = str(itemArgs.Prompt) ?? str(first?.Prompt);
          const typeName = str(itemArgs.TypeName);
          const subagentId = `${ctx.idPrefix}#sub-${stepIndex}-${idx}`;
          const subInfo: AntigravityPendingSubagent = { id: subagentId, role, prompt, typeName };
          if (s.pendingCalls) s.pendingCalls.set(callId, { tool: name, callId, subagent: subInfo });
          out.signals.push({ type: 'subagentSpawn', count: 1, subagent: subInfo, callId });
        } else if (s.pendingCalls) {
          s.pendingCalls.set(callId, { tool: name, callId });
        }

        pushActivity(desc, { key: callId, tool, callId });
      });
    } else {
      // Resposta em texto finalizando ou comunicando
      const content = str(j.content);
      if (content) {
        pushActivity(SPECIAL.respond(content), { key: `resp-${stepIndex}` });
        const foundTasks = extractMarkdownTasks(content);
        if (foundTasks.length > 0) {
          s.tasks = foundTasks;
          out.changed = true;
        }
      }
      if (j.status === 'DONE') {
        s.turnOpen = false;
        if (s.pendingCalls) {
          for (const [callId, pc] of s.pendingCalls.entries()) {
            if (pc.subagent) out.signals.push({ type: 'subagentDone', callId });
          }
          s.pendingCalls.clear();
        }
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
    const content = str(j.content);

    // Resolve a chamada pendente mais recente, se houver
    if (s.pendingCalls && s.pendingCalls.size > 0) {
      const entries = Array.from(s.pendingCalls.entries());
      const [lastCallId, lastCall] = entries[entries.length - 1];
      s.pendingCalls.delete(lastCallId);

      const gh = s.github?.get(lastCallId);
      if (gh) {
        s.github?.delete(lastCallId);
        const ghEvent = detectGitHubResult(gh, {
          content: content ?? err ?? '',
          tur: { stdout: content ?? '', stderr: err ?? '' },
          isError: status === 'ERROR',
        });
        if (ghEvent) {
          out.signals.push({ type: 'github', event: ghEvent, toolUseId: lastCallId });
        }
      }

      if (lastCall.subagent) {
        out.signals.push({ type: 'subagentDone', callId: lastCallId });
      }
    }

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
