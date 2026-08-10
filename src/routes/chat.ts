import type { FastifyInstance } from "fastify";
import { CodexService } from "../chat/codexService.js";

/**
 * GET /api/chat/status
 * POST /api/chat/restart
 *
 * Etapa 1: el backend inicia `codex app-server` por stdio, completa el
 * handshake initialize/initialized y confirma la cuenta via `account/read`.
 * Nunca se exponen credenciales ni tokens en las respuestas.
 */

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

  app.post("/api/chat/restart", async (_req, reply) => {
    await codex.restart();
    return reply.send({ restarted: true });
  });

  app.addHook("onClose", async () => {
    await codex.close();
  });
}
