import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CodexNotAuthenticatedError,
  CodexNotInstalledError,
  CodexService,
} from "../chat/codexService.js";

/**
 * Rutas del chat:
 *
 * GET  /api/chat/status   — estado: instalado, version, corriendo, cuenta (sin tokens)
 * GET  /api/chat/models   — modelos visibles, modelo por defecto y validacion opcional
 * POST /api/chat/restart  — cierra y reinicia app-server de forma controlada
 *
 * Etapa 1: el backend inicia `codex app-server` por stdio, completa el
 * handshake initialize/initialized y confirma la cuenta via `account/read`.
 * Etapa 3: expone la lista de modelos habilitados para la cuenta.
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
  throw error;
}

export async function chatRoutes(app: FastifyInstance) {
  const codex = new CodexService({
    command: process.env["CODEX_CLI_COMMAND"] ?? "codex",
    logger: (level, message, extra) => {
      if (level === "info") app.log.info({ extra }, message);
      else if (level === "warn") app.log.warn({ extra }, message);
      else app.log.error({ extra }, message);
    },
  });

  app.get("/api/chat/status", async (_req, reply) => {
    const status = await codex.status();
    return reply.send(status);
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

  app.addHook("onClose", async () => {
    await codex.close();
  });
}
