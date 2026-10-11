export type InterAgentTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** Tarefa interagentes mantida pelo servidor enquanto acompanha sua entrega e resposta. */
export interface InterAgentTask {
  id: string;
  sourceAgentId: string;
  targetAgentId: string;
  description: string;
  status: InterAgentTaskStatus;
  messageId?: string;
  result?: string;
  error?: string;
  /** Falha ao enviar a notificação de conclusão; o resultado continua disponível por GET /api/tasks/:id. */
  notificationError?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CreateTaskParams {
  sourceAgentId: string;
  targetAgentId: string;
  description: string;
}

export interface TaskListFilter {
  status?: InterAgentTaskStatus;
  agentId?: string;
}
