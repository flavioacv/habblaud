// Eventos dos hooks do Antigravity (a parte "ao vivo" da fonte do Antigravity):
// O script de hook manda o stdin do evento para POST /api/antigravity/events e a rota repassa aqui.
// A fonte do Antigravity (sources/antigravity/source.ts) implementa.

export interface AntigravityLive {
  /**
   * Aplica um evento de hook do Antigravity (o stdin dele: `conversationId`, `workspacePaths`,
   * `transcriptPath`, `toolCall`...) ao escritório. `account` = conta do Antigravity de quem mandou.
   * Devolve false para evento desconhecido ou sessão que não casa com nenhuma conta.
   */
  applyHookEvent(account: string | undefined, event: Record<string, unknown>): boolean;
}
