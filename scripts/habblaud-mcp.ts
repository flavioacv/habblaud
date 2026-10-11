import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const DEFAULT_URL = 'http://127.0.0.1:4747';

function apiBase(): URL {
  const raw = process.env.HABBLAUD_URL ?? DEFAULT_URL;
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('HABBLAUD_URL deve usar HTTP ou HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('HABBLAUD_URL não deve conter credenciais, query ou fragmento');
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host)) {
    throw new Error('HABBLAUD_URL deve apontar para localhost por segurança');
  }
  return new URL(url.pathname.replace(/\/$/, '') + '/', url);
}

const base = apiBase();
const defaultAgentId = process.env.HABBLAUD_AGENT_ID?.trim() || undefined;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path.replace(/^\//, ''), base), {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Habblaud respondeu HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(error: unknown) {
  return { ...textResult({ error: error instanceof Error ? error.message : String(error) }), isError: true };
}

function requireAgentId(agentId?: string): string {
  const id = agentId?.trim() || defaultAgentId;
  if (!id) throw new Error('Informe agentId ou configure HABBLAUD_AGENT_ID no MCP.');
  return id;
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'habblaud', version: '0.8.0' });

  server.registerTool('habblaud_list_agents', {
    description: 'Lista os agentes ativos no escritório Habblaud e indica quais aceitam mensagens.',
    inputSchema: {},
  }, async () => {
    try {
      const snapshot = await api<{ agents?: Array<Record<string, unknown>> }>('/api/snapshot');
      const agents = (snapshot.agents ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        provider: agent.provider ?? 'claude',
        role: agent.role,
        status: agent.status,
        canReceiveMessages: agent.canMessage === true,
      }));
      return textResult({ agents });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('habblaud_delegate_task', {
    description: 'Cria uma tarefa interagente e a envia ao agente de destino. sourceAgentId pode ser omitido se HABBLAUD_AGENT_ID estiver configurado.',
    inputSchema: {
      sourceAgentId: z.string().optional().describe('ID do agente solicitante; usa HABBLAUD_AGENT_ID se omitido.'),
      targetAgentId: z.string().min(1).describe('ID do agente destinatário, obtido em habblaud_list_agents.'),
      description: z.string().min(1).describe('Instrução completa para o agente destinatário.'),
    },
  }, async ({ sourceAgentId, targetAgentId, description }) => {
    try {
      const task = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ sourceAgentId: requireAgentId(sourceAgentId), targetAgentId, description }),
      });
      return textResult(task);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('habblaud_get_task', {
    description: 'Consulta o estado atual e o resultado de uma tarefa interagente.',
    inputSchema: { taskId: z.string().min(1).describe('ID retornado por habblaud_delegate_task.') },
  }, async ({ taskId }) => {
    try {
      return textResult(await api(`/api/tasks/${encodeURIComponent(taskId)}`));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('habblaud_complete_task', {
    description: 'Conclui uma tarefa e entrega o resultado ao agente solicitante. agentId pode ser omitido com HABBLAUD_AGENT_ID configurado.',
    inputSchema: {
      taskId: z.string().min(1),
      agentId: z.string().optional().describe('ID do agente de destino; usa HABBLAUD_AGENT_ID se omitido.'),
      result: z.string().min(1).describe('Resultado da tarefa para o agente solicitante.'),
    },
  }, async ({ taskId, agentId, result }) => {
    try {
      return textResult(await api(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
        method: 'POST',
        body: JSON.stringify({ agentId: requireAgentId(agentId), result }),
      }));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('habblaud_fail_task', {
    description: 'Registra que o agente de destino não conseguiu concluir a tarefa e informa o motivo ao solicitante.',
    inputSchema: {
      taskId: z.string().min(1),
      agentId: z.string().optional().describe('ID do agente de destino; usa HABBLAUD_AGENT_ID se omitido.'),
      error: z.string().min(1).describe('Motivo da falha.'),
    },
  }, async ({ taskId, agentId, error }) => {
    try {
      return textResult(await api(`/api/tasks/${encodeURIComponent(taskId)}/fail`, {
        method: 'POST',
        body: JSON.stringify({ agentId: requireAgentId(agentId), error }),
      }));
    } catch (err) {
      return toolError(err);
    }
  });

  return server;
}

serveStdio(createServer);
