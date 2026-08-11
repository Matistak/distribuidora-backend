import type { CodexService } from "./codexService.js";

/**
 * Auto-aprobacion de las tool calls del MCP de ventas (Etapa 6).
 *
 * El app-server puede interrumpir el turno con `mcpServer/elicitation/request`
 * para que el cliente apruebe una llamada a herramienta MCP. Como este chat
 * no implementa aprobaciones (CHAT-CODEX.md: quedan fuera del MVP) y el
 * servidor de ventas es de solo lectura, se responde automaticamente con
 * `{ action: "accept" }` cuando la peticion es una tool call del servidor
 * `ventas`. Cualquier otra peticion se ignora (queda pendiente en el servidor).
 *
 * Devuelve una funcion para cancelar la suscripcion.
 */
export function autoApproveVentasToolCalls(codex: CodexService): () => void {
  return codex.onClientRequest((request) => {
    if (request.method !== "mcpServer/elicitation/request") return;

    const params = request.params as
      | {
          serverName?: unknown;
          _meta?: { codex_approval_kind?: unknown } | null;
        }
      | undefined;
    const approvalKind = params?._meta?.codex_approval_kind;
    if (params?.serverName !== "ventas" || approvalKind !== "mcp_tool_call") return;

    // Best-effort: si el turno ya termino, la respuesta se descarta sola.
    void codex.respondToClientRequest(request.id, { action: "accept", content: null });
  });
}
