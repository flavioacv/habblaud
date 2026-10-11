import { randomBytes } from 'node:crypto';
import { truncate } from '../../shared/activity';
import type { Activity, AgentInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import type { MessageRegistry } from '../messages/registry';
import type { OfficeLike } from '../messages/registry';
import type { CreateTaskParams, InterAgentTask, InterAgentTaskStatus, TaskListFilter } from './types';

const TASK_ID_MAX = 300;
const TASK_ERROR_MAX = 1_000;
const TASK_CONTENT_MAX = 16_000;
const TASKS_MAX = 2_000;
const TASK_KEEP_MS = 24 * 60 * 60_000;
const DEFAULT_TICK_MS = 500;

export class TaskRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TaskRegistryOptions {
  office: OfficeLike;
  messages: MessageRegistry;
  now?: () => number;
  tickMs?: number;
  keepMs?: number;
  maxTasks?: number;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function shortString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
}

function present(agent: AgentInfo | undefined): agent is AgentInfo {
  return !!agent && agent.status !== 'offline' && agent.status !== 'done';
}

function isTerminal(status: InterAgentTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Valida o corpo de POST /api/tasks. */
export function parseCreateTask(raw: unknown): CreateTaskParams {
  const body = rec(raw);
  const sourceAgentId = shortString(body?.sourceAgentId, TASK_ID_MAX);
  const targetAgentId = shortString(body?.targetAgentId, TASK_ID_MAX);
  const description = typeof body?.description === 'string' ? body.description : undefined;
  if (!body || !sourceAgentId || !targetAgentId || !description?.trim()) {
    throw new TaskRequestError(400, 'esperado {sourceAgentId, targetAgentId, description}');
  }
  if (description.length > TASK_CONTENT_MAX) throw new TaskRequestError(400, `description passa de ${TASK_CONTENT_MAX} caracteres`);
  return { sourceAgentId, targetAgentId, description };
}

/** Mantém e acompanha tarefas interagentes usando a entrega existente do MessageRegistry. */
export class TaskRegistry {
  private readonly tasks = new Map<string, InterAgentTask>();
  private readonly now: () => number;
  private readonly keepMs: number;
  private readonly maxTasks: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(private readonly opts: TaskRegistryOptions) {
    this.now = opts.now ?? Date.now;
    this.keepMs = opts.keepMs ?? TASK_KEEP_MS;
    this.maxTasks = opts.maxTasks ?? TASKS_MAX;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.warnOnce(`tasks-tick:${errMsg(err)}`, `Tarefas interagentes: falha no relógio (${errMsg(err)}).`);
      }
    }, this.opts.tickMs ?? DEFAULT_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  createTask(raw: unknown): InterAgentTask {
    const params = parseCreateTask(raw);
    const source = this.opts.office.get(params.sourceAgentId);
    const target = this.opts.office.get(params.targetAgentId);
    if (!present(source) || source.kind !== 'main') throw new TaskRequestError(404, 'agente solicitante não encontrado ou não está ativo');
    if (!present(target) || target.kind !== 'main') throw new TaskRequestError(404, 'agente de destino não encontrado ou não está ativo');
    if (source.id === target.id) throw new TaskRequestError(400, 'o agente não pode delegar uma tarefa para si mesmo');
    if (!this.opts.messages.canMessage(source.id)) {
      throw new TaskRequestError(409, 'o agente solicitante não tem um canal ativo para receber a resposta');
    }

    const now = this.now();
    this.prune(now);
    if (this.tasks.size >= this.maxTasks) throw new TaskRequestError(429, 'há tarefas demais aguardando ou retidas no registro');

    const id = `task_${now.toString(36)}_${++this.seq}_${randomBytes(9).toString('base64url')}`;
    const task: InterAgentTask = {
      id,
      sourceAgentId: source.id,
      targetAgentId: target.id,
      description: params.description,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);

    const sent = this.opts.messages.send({ agentId: target.id, text: this.taskPrompt(task, source) });
    if ('message' in sent) {
      task.messageId = sent.message.id;
      this.refresh(task);
    } else {
      const error = sent.error === 'unavailable'
        ? sent.reason
        : sent.error === 'too-many'
          ? 'a fila de mensagens do agente de destino está cheia'
          : 'o agente de destino não foi encontrado';
      this.transition(task, 'failed', { error }, false);
    }
    return { ...task };
  }

  completeTask(taskId: string, agentId: string, result: string): InterAgentTask {
    const task = this.requireTask(taskId);
    this.authorizeTarget(task, agentId);
    this.refresh(task);
    if (isTerminal(task.status)) throw new TaskRequestError(409, `a tarefa já foi encerrada (${task.status})`);
    if (typeof result !== 'string' || !result.trim()) throw new TaskRequestError(400, 'result não pode estar vazio');
    if (result.length > TASK_CONTENT_MAX) throw new TaskRequestError(400, `result passa de ${TASK_CONTENT_MAX} caracteres`);
    this.transition(task, 'completed', { result });
    return { ...task };
  }

  failTask(taskId: string, agentId: string, error: string): InterAgentTask {
    const task = this.requireTask(taskId);
    this.authorizeTarget(task, agentId);
    this.refresh(task);
    if (isTerminal(task.status)) throw new TaskRequestError(409, `a tarefa já foi encerrada (${task.status})`);
    if (typeof error !== 'string' || !error.trim()) throw new TaskRequestError(400, 'error não pode estar vazio');
    this.transition(task, 'failed', { error: truncate(error, TASK_ERROR_MAX) });
    return { ...task };
  }

  getTask(taskId: string): InterAgentTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    this.refresh(task);
    return { ...task };
  }

  listTasks(filter: TaskListFilter = {}): InterAgentTask[] {
    this.tick();
    return [...this.tasks.values()]
      .filter((task) => !filter.status || task.status === filter.status)
      .filter((task) => !filter.agentId || task.sourceAgentId === filter.agentId || task.targetAgentId === filter.agentId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((task) => ({ ...task }));
  }

  tick(): void {
    const now = this.now();
    for (const task of this.tasks.values()) this.refresh(task);
    this.prune(now);
  }

  private taskPrompt(task: InterAgentTask, source: AgentInfo): string {
    return [
      '[Habblaud] Você recebeu uma tarefa de outro agente.',
      `taskId: ${task.id}`,
      `Solicitante: ${source.name} (${source.id})`,
      '',
      'Descrição da tarefa:',
      task.description,
      '',
      'Ao concluir, devolva seu resultado pelo MCP do Habblaud usando habblaud_complete_task com este taskId e seu agentId.',
      'Se não conseguir concluir, use habblaud_fail_task com o mesmo taskId, seu agentId e o motivo.',
    ].join('\n');
  }

  private requireTask(taskId: string): InterAgentTask {
    const id = shortString(taskId, TASK_ID_MAX);
    if (!id) throw new TaskRequestError(400, 'taskId inválido');
    const task = this.tasks.get(id);
    if (!task) throw new TaskRequestError(404, 'tarefa desconhecida ou expirada');
    return task;
  }

  private authorizeTarget(task: InterAgentTask, agentId: string): void {
    if (shortString(agentId, TASK_ID_MAX) !== task.targetAgentId) {
      throw new TaskRequestError(403, 'somente o agente de destino pode concluir ou falhar esta tarefa');
    }
  }

  private refresh(task: InterAgentTask): void {
    if (task.status !== 'pending' && task.status !== 'in_progress') return;
    const target = this.opts.office.get(task.targetAgentId);
    if (!present(target)) {
      this.transition(task, 'failed', { error: 'o agente de destino saiu do escritório' });
      return;
    }
    if (!task.messageId) return;
    const message = this.opts.messages.get(task.messageId);
    if (message?.status === 'delivered' && task.status === 'pending') {
      task.status = 'in_progress';
      task.updatedAt = this.now();
      this.addTaskActivity(task, '✉️', 'Tarefa recebida de outro agente', task.description);
    } else if (message?.status === 'failed') {
      this.transition(task, 'failed', { error: message.error ?? 'a mensagem da tarefa não foi entregue' });
    } else if (!message && task.status === 'pending') {
      this.transition(task, 'failed', { error: 'a mensagem da tarefa expirou antes de confirmar a entrega' });
    }
  }

  private transition(
    task: InterAgentTask,
    status: Extract<InterAgentTaskStatus, 'completed' | 'failed'>,
    fields: { result?: string; error?: string },
    notify = true,
  ): void {
    const now = this.now();
    task.status = status;
    task.updatedAt = now;
    task.completedAt = now;
    if (fields.result !== undefined) task.result = fields.result;
    if (fields.error !== undefined) task.error = fields.error;
    this.addTaskActivity(
      task,
      status === 'completed' ? '✅' : '⚠️',
      status === 'completed' ? 'Tarefa interagente concluída' : 'Tarefa interagente falhou',
      fields.result ?? fields.error ?? task.description,
    );
    if (notify) this.notifySource(task, status, fields.result ?? fields.error ?? '');
  }

  private addTaskActivity(task: InterAgentTask, icon: string, text: string, detail: string): void {
    const activity: Activity = {
      id: `${task.targetAgentId}#task:${task.id}:${task.status}`,
      at: this.now(),
      kind: 'communicate',
      icon,
      text: truncate(text, 46),
      detail: truncate(detail, 300),
      tool: 'HabblaudTask',
    };
    this.opts.office.addActivity(task.targetAgentId, activity, false);
  }

  private notifySource(task: InterAgentTask, status: 'completed' | 'failed', detail: string): void {
    const target = this.opts.office.get(task.targetAgentId);
    const title = status === 'completed' ? 'concluiu' : 'não conseguiu concluir';
    const text = [
      `[Habblaud] O agente ${target?.name ?? task.targetAgentId} ${title} a tarefa ${task.id}.`,
      '',
      status === 'completed' ? 'Resultado:' : 'Motivo:',
      detail,
    ].join('\n');
    const sent = this.opts.messages.send({ agentId: task.sourceAgentId, text });
    if ('message' in sent) return;
    task.notificationError = sent.error === 'unavailable'
      ? sent.reason
      : sent.error === 'too-many'
        ? 'a fila do agente solicitante está cheia'
        : 'o agente solicitante saiu do escritório';
  }

  private prune(now: number): void {
    for (const [id, task] of this.tasks) {
      if (isTerminal(task.status) && now - (task.completedAt ?? task.updatedAt) >= this.keepMs) this.tasks.delete(id);
    }
  }
}
