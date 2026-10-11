import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import type { InterAgentTaskStatus } from './types';
import { TaskRegistry, TaskRequestError } from './registry';

const ITEM = /^\/api\/tasks\/([^/]+)(?:\/(complete|fail))?$/;
const STATUSES = new Set<InterAgentTaskStatus>(['pending', 'in_progress', 'completed', 'failed', 'cancelled']);

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: 'método não permitido' });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else if (err instanceof TaskRequestError) sendJson(res, err.status, { error: err.message });
  else sendJson(res, 500, { error: 'erro interno' });
}

function bodyRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Rotas HTTP do registro de tarefas interagentes. */
export function createTaskRoutes(registry: TaskRegistry): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const post = (req: IncomingMessage, res: ServerResponse, handler: (body: unknown) => unknown, status = 200) => {
    if ((req.method ?? 'GET') !== 'POST') return methodNotAllowed(res, 'POST');
    readJson(req)
      .then((body) => sendJson(res, status, handler(body)))
      .catch((err) => fail(res, err));
  };

  return (req, res, path) => {
    if (path === '/api/tasks') {
      const method = req.method ?? 'GET';
      if (method === 'POST') {
        return post(req, res, (body) => registry.createTask(body), 201);
      }
      if (method !== 'GET') return methodNotAllowed(res, 'GET, POST');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const statusParam = url.searchParams.get('status') ?? undefined;
      const agentId = url.searchParams.get('agentId') ?? undefined;
      if (statusParam && !STATUSES.has(statusParam as InterAgentTaskStatus)) return sendJson(res, 400, { error: 'status inválido' });
      sendJson(res, 200, {
        tasks: registry.listTasks({ status: statusParam as InterAgentTaskStatus | undefined, agentId }),
      });
      return;
    }

    const match = ITEM.exec(path);
    if (!match) return sendJson(res, 404, { error: 'rota desconhecida' });
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return sendJson(res, 400, { error: 'taskId inválido' });
    }

    const action = match[2];
    if (action === 'complete') {
      return post(req, res, (raw) => {
        const body = bodyRecord(raw);
        if (typeof body?.agentId !== 'string' || typeof body.result !== 'string') {
          throw new TaskRequestError(400, 'esperado {agentId, result}');
        }
        return registry.completeTask(id, body.agentId, body.result);
      });
    }
    if (action === 'fail') {
      return post(req, res, (raw) => {
        const body = bodyRecord(raw);
        if (typeof body?.agentId !== 'string' || typeof body.error !== 'string') {
          throw new TaskRequestError(400, 'esperado {agentId, error}');
        }
        return registry.failTask(id, body.agentId, body.error);
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
    const task = registry.getTask(id);
    if (!task) return sendJson(res, 404, { error: 'tarefa desconhecida ou expirada' });
    sendJson(res, 200, task);
  };
}
