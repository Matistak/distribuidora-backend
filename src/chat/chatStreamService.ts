import {
  CodexNotAuthenticatedError,
  CodexNotInstalledError,
  type CodexService,
} from "./codexService.js";
import { CodexTransportError, JsonRpcRequestError } from "./jsonrpc.js";
import { autoApproveVentasToolCalls } from "./autoApproval.js";

/**
 * Traduccion de un turno de `app-server` al contrato SSE de la aplicacion
 * (Etapa 5). El frontend no conoce el protocolo de Codex: solo recibe
 * `message.start`, `message.delta`, `message.completed` y `message.error`.
 *
 * Orquestacion:
 * 1. Suscribirse a los eventos del thread ANTES de enviar `turn/start` para
 *    no perder ningun delta.
 * 2. Enviar `turn/start` (timeout generoso: la respuesta llega cuando el
 *    turno arranca; los deltas llegan despues como notificaciones).
 * 3. Al arrancar, emitir `message.start` con el `turnId` (lo necesita el
 *    frontend para cancelar con `turn/interrupt`).
 * 4. Los deltas se encolan hasta el arranque y se emiten como
 *    `message.delta`; `turn/completed` cierra con `message.completed`.
 * 5. Errores (respuesta JSON-RPC, notificacion `error`, turno `failed` o
 *    `interrupted`) cierran con `message.error`.
 *
 * Notas:
 * - La notificacion `error` puede llegar con `willRetry: true`: la app no
 *   reanuda el stream, asi que se corta e interrumpe el turno para no seguir
 *   gastando tokens en un reintento invisible.
 * - `streamMessage` resuelve cuando el turno arranca (o falla al arrancar);
 *   el final real del turno se notifica con `onDone`, que la ruta usa para
 *   cerrar la respuesta SSE y actualizar los metadatos de la conversacion.
 * - El controlador de cancelacion se devuelve para que la ruta lo ejecute al
 *   desconectarse el cliente.
 */

export type ChatSseEvent =
  | { event: "message.start"; data: { turnId: string | null } }
  | { event: "message.delta"; data: { text: string } }
  | { event: "message.completed"; data: { turnId: string } }
  | { event: "message.error"; data: { message: string } };

export interface ChatTurnControl {
  /** Interrumpe el turno en curso con `turn/interrupt` (si ya arranco). */
  cancel(): Promise<void>;
}

export interface ChatStreamInput {
  threadId: string;
  model: string;
  message: string;
  send: (event: ChatSseEvent) => void;
  /** Se ejecuta al emitirse el evento terminal (completado o error). */
  onDone?: () => void;
}

export class ChatStreamService {
  constructor(private readonly codex: CodexService) {}

  async streamMessage(input: ChatStreamInput): Promise<ChatTurnControl> {
    const { threadId, model, message, send, onDone } = input;

    let turnId: string | null = null;
    let started = false;
    let terminal: ChatSseEvent | null = null;
    const deltas: string[] = [];

    const emitDone = () => {
      if (started && terminal) onDone?.();
    };

    const cancel = async () => {
      if (!turnId || terminal) return;
      try {
        await this.codex.interruptTurn({ threadId, turnId });
      } catch {
        // El turno ya pudo terminar; la cancelacion es best-effort.
      }
    };

    const setTerminal = (event: ChatSseEvent, interrupt: boolean) => {
      if (terminal) return;
      terminal = event;
      if (interrupt) void cancel();
      // Primero el evento terminal y despues onDone: `onDone` cierra la
      // respuesta SSE, y escribir sobre un socket cerrado se pierde.
      if (started) send(event);
      cleanup();
      emitDone();
    };

    const off = this.codex.onThreadEvent(threadId, (event) => {
      switch (event.method) {
        case "turn/started":
          turnId ??= event.params.turn.id;
          break;
        case "item/agentMessage/delta":
          if (terminal) return;
          if (started) send({ event: "message.delta", data: { text: event.params.delta } });
          else deltas.push(event.params.delta);
          break;
        case "error":
          setTerminal(
            { event: "message.error", data: { message: event.params.error.message } },
            true,
          );
          break;
        case "turn/completed": {
          const turn = event.params.turn;
          if (turn.status === "failed") {
            setTerminal(
              {
                event: "message.error",
                data: { message: turn.error?.message ?? "El turno falló." },
              },
              false,
            );
          } else if (turn.status === "interrupted") {
            setTerminal(
              { event: "message.error", data: { message: "La generación fue cancelada." } },
              false,
            );
          } else {
            setTerminal({ event: "message.completed", data: { turnId: turn.id } }, false);
          }
          break;
        }
      }
    });

    // Etapa 6: las llamadas a herramientas del MCP de ventas requieren una
    // aprobacion del cliente; como el chat no tiene flujo de aprobaciones y
    // el servidor es de solo lectura, se responden automaticamente.
    const offApproval = autoApproveVentasToolCalls(this.codex);
    const cleanup = () => {
      off();
      offApproval();
    };

    try {
      const { turn } = await this.codex.startTurn({
        threadId,
        input: [{ type: "text", text: message }],
        model,
      });
      turnId = turn.id;
    } catch (error) {
      cleanup();
      terminal = { event: "message.error", data: { message: turnStartErrorMessage(error) } };
      send(terminal);
      emitDone();
      return { cancel };
    }

    started = true;
    send({ event: "message.start", data: { turnId } });
    for (const delta of deltas) {
      if (terminal) break;
      send({ event: "message.delta", data: { text: delta } });
    }
    deltas.length = 0;
    // Si el turno ya termino mientras esperabamos el arranque (respuesta muy
    // rapida), emitir el evento terminal despues del start para conservar el
    // orden start -> (deltas) -> fin.
    if (terminal) send(terminal);
    emitDone();

    return { cancel };
  }
}

/** Convierte un error de arranque de turno en un mensaje legible. */
export function turnStartErrorMessage(error: unknown): string {
  if (error instanceof CodexNotAuthenticatedError || error instanceof CodexNotInstalledError) {
    return error.message;
  }
  if (error instanceof JsonRpcRequestError) {
    // "JSON-RPC turn/start fallo (-32000): <mensaje del servidor>"
    const index = error.message.indexOf(": ");
    const detail = index >= 0 ? error.message.slice(index + 2) : error.message;
    return detail.trim() || "Codex no pudo iniciar el turno.";
  }
  if (error instanceof CodexTransportError) return error.message;
  return error instanceof Error ? error.message : "Error desconocido al enviar el mensaje.";
}
