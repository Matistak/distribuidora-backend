import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "../server.js";
import {
  CodexNotAuthenticatedError,
  CodexNotInstalledError,
  CodexService,
} from "../chat/codexService.js";
import {
  ConversationService,
  ModeloChatInvalidoError,
} from "../chat/conversationService.js";
import {
  ChatStreamService,
  type ChatSseEvent,
  type ChatTurnControl,
} from "../chat/chatStreamService.js";
import { ventasMcpInfo, ventasMcpLaunchArgs } from "../mcp/ventasMcpConfig.js";

/**
 * Rutas del chat:
 *
 * GET  /api/chat/status                  — estado: instalado, version, corriendo, cuenta (sin tokens)
 * GET  /api/chat/models                  — modelos visibles, modelo por defecto y validacion opcional
 * POST /api/chat/restart                 — cierra y reinicia app-server de forma controlada
 * GET  /api/chat/conversations           — historial local de conversaciones
 * POST /api/chat/conversations           — crea una conversacion (thread/start + metadatos)
 *  GET  /api/chat/conversations/:id       — metadatos + mensajes desde el historial de Codex
 *  DELETE /api/chat/conversations/:id     — borra la conversacion (thread/delete + local)
 *  POST /api/chat/conversations/:id/resume — reanuda el thread de Codex para continuarlo
 * POST /api/chat/conversations/:id/messages — envia un mensaje y responde por SSE (Etapa 5)
 * POST /api/chat/conversations/:id/cancel — interrumpe un turno en curso (turn/interrupt)
 *
 * Etapa 1: el backend inicia `codex app-server` por stdio, completa el
 * handshake initialize/initialized y confirma la cuenta via `account/read`.
 * Etapa 3: expone la lista de modelos habilitados para la cuenta.
 * Etapa 4: conversaciones con metadatos locales en SQLite e historial de
 * mensajes provisto por `thread/read`.
 * Etapa 5: `POST .../messages` traduce `turn/start` + notificaciones de Codex
 * a un contrato SSE pequeno y estable (message.start/delta/tool_call/completed/error).
 * Etapa 7: el historial incluye las consultas de herramientas (MCP de ventas)
 * resumidas en cada mensaje del asistente.
 * Nunca se exponen credenciales ni tokens en las respuestas.
 */

/** Traduce errores de Codex a respuestas accionables y legibles. */
function sendCodexError(reply: FastifyReply, error: unknown): void {
  if (error instanceof CodexNotInstalledError) {
    reply.status(503).send({ error: error.message });
    return;
  }
  if (error instanceof CodexNotAuthenticatedError) {
    reply.status(401).send({ error: error.message });
    return;
  }
  if (error instanceof ModeloChatInvalidoError) {
    reply.status(400).send({ error: error.message });
    return;
  }
  throw error;
}

const idParam = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** Tope de duracion de un turno; pasado este tiempo se interrumpe y corta el SSE. */
const TURNO_TIMEOUT_MS = 10 * 60 * 1000;
/** Longitud maxima del mensaje que el usuario puede enviar. */
const MENSAJE_MAX_LENGTH = 20_000;

/** CORS no se aplica despues de `reply.hijack()`, asi que se replica para SSE. */
function sseCorsHeaders(origin: string | undefined): Record<string, string> {
  const allowed =
    process.env["CORS_ORIGIN"]?.split(",").map((value) => value.trim()).filter(Boolean) ?? ["*"];
  if (!origin || (!allowed.includes("*") && !allowed.includes(origin))) return {};
  return {
    "Access-Control-Allow-Origin": allowed.includes("*") ? "*" : origin,
    ...(allowed.includes("*") ? {} : { Vary: "Origin" }),
  };
}

export async function chatRoutes(app: FastifyInstance) {
  const codex = new CodexService({
    // Etapa 8: la resolucion del comando es cross-platform (PATH, Homebrew,
    // npm/scoop en Windows); `CODEX_CLI_COMMAND` sigue siendo un override.
    extraArgs: ventasMcpLaunchArgs(),
    logger: (level, message, extra) => {
      if (level === "info") app.log.info({ extra }, message);
      else if (level === "warn") app.log.warn({ extra }, message);
      else app.log.error({ extra }, message);
    },
  });
  const conversations = new ConversationService(codex, prisma);
  const stream = new ChatStreamService(codex);

  app.get("/api/chat/status", async (_req, reply) => {
    const status = await codex.status();
    return reply.send({ ...status, mcp: ventasMcpInfo() });
  });

  app.get<{ Querystring: { model?: string } }>("/api/chat/models", async (req, reply) => {
    try {
      const visible = await codex.visibleModels();
      const defaultModel = await codex.defaultModel();
      const valid = req.query.model ? await codex.validateModel(req.query.model) : null;
      return reply.send({
        models: visible.map(({ id, displayName, description }) => ({
          id,
          displayName,
          description,
        })),
        defaultModel,
        valid,
      });
    } catch (error) {
      sendCodexError(reply, error);
    }
  });

  app.post("/api/chat/restart", async (_req, reply) => {
    await codex.restart();
    return reply.send({ restarted: true });
  });

  app.get("/api/chat/conversations", async (_req, reply) => {
    try {
      return reply.send({ conversations: await conversations.list() });
    } catch (error) {
      sendCodexError(reply, error);
    }
  });

  app.post<{ Body: { model?: string; title?: string } }>(
    "/api/chat/conversations",
    async (req, reply) => {
      try {
        const model = req.body?.model?.trim() || (await codex.defaultModel());
        if (!model) {
          reply.status(400).send({ error: "No hay modelos disponibles para la cuenta." });
          return;
        }
        const conversation = await conversations.create({ model, title: req.body?.title });
        return reply.status(201).send({ conversation });
      } catch (error) {
        sendCodexError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/chat/conversations/:id", async (req, reply) => {
    const id = idParam(req.params.id);
    if (id === null) {
      reply.status(404).send({ error: "Conversación no encontrada." });
      return;
    }
    try {
      const conversation = await conversations.remove(id);
      if (!conversation) {
        reply.status(404).send({ error: "Conversación no encontrada." });
        return;
      }
      return reply.send({ deleted: true });
    } catch (error) {
      sendCodexError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/chat/conversations/:id", async (req, reply) => {
    const id = idParam(req.params.id);
    if (id === null) {
      reply.status(404).send({ error: "Conversación no encontrada." });
      return;
    }
    try {
      const detalle = await conversations.read(id);
      if (!detalle) {
        reply.status(404).send({ error: "Conversación no encontrada." });
        return;
      }
      return reply.send(detalle);
    } catch (error) {
      sendCodexError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { model?: string } }>(
    "/api/chat/conversations/:id/resume",
    async (req, reply) => {
      const id = idParam(req.params.id);
      if (id === null) {
        reply.status(404).send({ error: "Conversación no encontrada." });
        return;
      }
      try {
        const conversation = await conversations.resume(id, req.body?.model);
        if (!conversation) {
          reply.status(404).send({ error: "Conversación no encontrada." });
          return;
        }
        return reply.send({ conversation });
      } catch (error) {
        sendCodexError(reply, error);
      }
    },
  );

  /**
   * Envia un mensaje a la conversacion y responde con un stream SSE
   * (`message.start`, `message.delta`, `message.tool_call`, `message.completed`
   * o `message.error`). El `turnId` llega en `message.start` para que el
   * frontend pueda cancelar.
   */
  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/api/chat/conversations/:id/messages",
    async (req, reply) => {
      const id = idParam(req.params.id);
      if (id === null) {
        reply.status(404).send({ error: "Conversación no encontrada." });
        return;
      }
      const message = req.body?.message?.trim();
      if (!message) {
        reply.status(400).send({ error: "El mensaje no puede estar vacío." });
        return;
      }
      if (message.length > MENSAJE_MAX_LENGTH) {
        reply.status(400).send({ error: `El mensaje no puede superar los ${MENSAJE_MAX_LENGTH} caracteres.` });
        return;
      }

      let conversation;
      try {
        conversation = await conversations.get(id);
        if (!conversation) {
          reply.status(404).send({ error: "Conversación no encontrada." });
          return;
        }
        // Reanuda el thread (necesario para threads "frios") y valida la cuenta.
        await conversations.resume(id);
      } catch (error) {
        sendCodexError(reply, error);
        return;
      }

      // Desde aca todo lo que falle se reporta por SSE, no como JSON.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...sseCorsHeaders(req.headers.origin),
      });

      const send = (event: ChatSseEvent) => {
        if (res.destroyed || res.writableEnded) return;
        res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      };

      let control: ChatTurnControl | null = null;
      const safety = setTimeout(() => {
        send({ event: "message.error", data: { message: "El turno tardó demasiado y se canceló." } });
        void control?.cancel();
        if (!res.writableEnded) res.end();
      }, TURNO_TIMEOUT_MS);

      res.on("close", () => {
        // El cliente se desconecto a mitad de turno: interrumpir para no
        // seguir gastando tokens en una respuesta que nadie vera.
        if (res.writableEnded) return;
        void control?.cancel();
      });

      try {
        control = await stream.streamMessage({
          threadId: conversation.codexThreadId,
          model: conversation.selectedModel,
          message,
          send,
          onDone: async () => {
            clearTimeout(safety);
            // Refresca el orden de la lista y el titulo derivado del preview.
            await prisma.chatConversation.update({
              where: { id },
              data: { updatedAt: new Date() },
            });
            if (!res.writableEnded) res.end();
          },
        });
      } catch {
        clearTimeout(safety);
        send({ event: "message.error", data: { message: "No se pudo iniciar el turno." } });
        if (!res.writableEnded) res.end();
      }
    },
  );

  /** Interrumpe un turno en curso (`turn/interrupt`), si todavia sigue. */
  app.post<{ Params: { id: string }; Body: { turnId?: string } }>(
    "/api/chat/conversations/:id/cancel",
    async (req, reply) => {
      const id = idParam(req.params.id);
      const turnId = req.body?.turnId?.trim();
      if (id === null || !turnId) {
        reply.status(400).send({ error: "Falta el identificador del turno." });
        return;
      }
      let conversation;
      try {
        conversation = await conversations.get(id);
        if (!conversation) {
          reply.status(404).send({ error: "Conversación no encontrada." });
          return;
        }
        await codex.interruptTurn({ threadId: conversation.codexThreadId, turnId });
      } catch (error) {
        sendCodexError(reply, error);
        return;
      }
      return reply.send({ canceled: true });
    },
  );

  app.addHook("onClose", async () => {
    await codex.close();
  });
}
