// Terminal do Antigravity: converte linhas do transcript.jsonl em TerminalEntry
// (prompts, respostas, thinking, tool_calls, saídas de ferramentas).
import type { TerminalEntry } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, INPUT_MAX, type TerminalParser } from '../terminal';

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

const SEEN_MAX = 20_000;

export class AntigravityTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();

  push(line: string): TerminalEntry[] {
    this.out = [];
    try {
      this.parseLine(line);
    } catch {
      // Ignora erro em linha malformada
    }
    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    this.out.push(e);
  }

  private parseLine(raw: string): void {
    if (!raw.trim()) return;
    const j = JSON.parse(raw) as Rec;
    if (!rec(j)) return;

    const stepIndex = num(j.step_index) ?? 0;
    const at = toMs(j.created_at) ?? Date.now();
    const type = str(j.type);
    const source = str(j.source);

    // 1. Entrada do usuário
    if (type === 'USER_INPUT' || source === 'USER_EXPLICIT') {
      const content = str(j.content);
      if (content) {
        const text = prepare(content, TEXT_MAX);
        this.emit({ id: `step-${stepIndex}:user`, kind: 'user', text, at });
      }
      return;
    }

    // 2. Resposta do modelo
    if (type === 'PLANNER_RESPONSE') {
      // Thinking
      const thinking = str(j.thinking);
      if (thinking) {
        const text = prepare(thinking, THINKING_MAX);
        this.emit({ id: `step-${stepIndex}:think`, kind: 'thinking', text, at });
      }

      // Tool calls
      const toolCalls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      toolCalls.forEach((tc, idx) => {
        const item = rec(tc);
        if (!item) return;
        const name = str(item.name) ?? 'ferramenta';
        const rawArgs = item.args;
        let input = '';
        if (typeof rawArgs === 'string') input = rawArgs;
        else if (rawArgs) input = JSON.stringify(rawArgs, null, 2);

        this.emit({
          id: `step-${stepIndex}:tool:${idx}`,
          kind: 'tool',
          tool: name,
          title: name,
          input: input ? prepare(input, INPUT_MAX) : undefined,
          at,
        });
      });

      // Texto de resposta
      const content = str(j.content);
      if (content) {
        const text = prepare(content, TEXT_MAX);
        this.emit({ id: `step-${stepIndex}:asst`, kind: 'assistant', text, at });
      }
      return;
    }

    // 3. Resultado de ferramenta
    if (type === 'GENERIC') {
      const content = str(j.content) ?? str(j.error) ?? '';
      if (content) {
        const text = prepare(content, RESULT_MAX);
        this.emit({
          id: `step-${stepIndex}:res`,
          kind: 'result',
          tool: 'tool',
          text,
          error: j.status === 'ERROR' || !!j.error,
          at,
        });
      }
    }
  }
}

export function createAntigravityTerminalParser(): TerminalParser {
  return new AntigravityTerminalParser();
}
