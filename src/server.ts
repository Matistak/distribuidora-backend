import "dotenv/config";
import { bootstrap } from "./bootstrap.js";
bootstrap();

import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { PrismaClient } from "@prisma/client";
import { uploadRoutes } from "./routes/uploads.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { ventasRoutes } from "./routes/ventas.js";
import { filtrosRoutes } from "./routes/filtros.js";
import { clientesRoutes } from "./routes/clientes.js";
import { chatRoutes } from "./routes/chat.js";
import { configureSqlite } from "./services/sqlitePerformance.js";
import { runWeeklyBackup } from "./backups.js";

export const prisma = new PrismaClient();

async function ensureImportSchema() {
  try {
    await prisma.$queryRaw`SELECT "filasErrores" FROM "Carga" LIMIT 1`;
  } catch {
    // Actualiza instalaciones existentes que fueron creadas antes del contador de errores.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Carga" ADD COLUMN "filasErrores" INTEGER NOT NULL DEFAULT 0',
    );
  }

  // Prisma guarda los DateTime de SQLite como epoch en milisegundos. Convertimos
  // esos valores heredados para que fecha quede siempre como YYYY-MM-DD.
  await prisma.$executeRaw`
    UPDATE "Venta"
    SET "fecha" = strftime('%Y-%m-%d', CAST("fecha" AS INTEGER) / 1000, 'unixepoch')
    WHERE typeof("fecha") IN ('integer', 'real')
       OR (
         typeof("fecha") = 'text'
         AND trim("fecha") NOT GLOB '*[^0-9]*'
         AND length(trim("fecha")) >= 12
       )
  `;
}

/**
 * Etapa 8: alinea el schema en bases existentes. Las instalaciones creadas
 * antes de la Fase 4 no tienen la tabla `ChatConversation`; crearla no
 * destruye datos (es una tabla nueva). Con esto las actualizaciones no
 * pierden el historial de conversaciones.
 */
async function ensureChatSchema() {
  try {
    await prisma.$queryRaw`SELECT "codexThreadId" FROM "ChatConversation" LIMIT 1`;
  } catch {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ChatConversation" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "codexThreadId" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "selectedModel" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "ChatConversation_codexThreadId_key"
        ON "ChatConversation"("codexThreadId");
    `);
    console.log("Tabla ChatConversation creada en una base existente.");
  }
}

const PUBLIC_ERROR_MESSAGES: Record<number, string> = {
  400: "Solicitud inválida",
  401: "No autorizado",
  403: "Acceso denegado",
  404: "Recurso no encontrado",
  409: "Conflicto al procesar la solicitud",
  413: "El archivo excede el tamaño máximo permitido",
  422: "Los datos enviados no son válidos",
  429: "Demasiadas solicitudes",
};

export async function buildApp() {
  const app = Fastify({ logger: true });

  await configureSqlite(prisma);
  await ensureImportSchema();
  await ensureChatSchema();

  const origins = process.env["CORS_ORIGIN"]?.split(",").map((s) => s.trim()).filter(Boolean) ?? ["*"];
  await app.register(cors, {
    origin: origins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  app.setErrorHandler((error, _req, reply) => {
    const err = error as Error & { statusCode?: number };
    app.log.error(err);

    const statusCode =
      typeof err.statusCode === "number" &&
      err.statusCode >= 400 &&
      err.statusCode < 600
        ? err.statusCode
        : 500;
    const message =
      statusCode >= 500
        ? "Error interno del servidor"
        : (PUBLIC_ERROR_MESSAGES[statusCode] ?? "Solicitud inválida");

    reply.status(statusCode).send({ error: message });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: "Recurso no encontrado" });
  });

  await app.register(uploadRoutes);
  await app.register(dashboardRoutes);
  await app.register(ventasRoutes);
  await app.register(filtrosRoutes);
  await app.register(clientesRoutes);
  await app.register(chatRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

async function start() {
  const app = await buildApp();

  // Etapa 8: backup semanal del historial (conversaciones + ventas).
  await runWeeklyBackup(prisma);

  const port = parseInt(process.env["PORT"] ?? "3001", 10);

  try {
    await app.listen({ port, host: "127.0.0.1" });
    console.log(`\n  🚀 Backend corriendo en http://localhost:${port}`);
    console.log(`  📋 Endpoints:`);
    console.log(`     POST   /api/uploads        — subir Excel`);
    console.log(`     GET    /api/uploads        — historial de cargas`);
    console.log(`     GET    /api/uploads/:id    — estado de carga`);
    console.log(`     GET    /api/dashboard      — KPIs + rankings`);
    console.log(`     GET    /api/ventas         — filas paginadas`);
    console.log(`     GET    /api/filtros        — opciones de filtro`);
    console.log(`     GET    /api/chat/status    — estado de Codex`);
    console.log(`     GET    /api/chat/models    — modelos disponibles`);
    console.log(`     POST   /api/chat/restart   — reiniciar app-server`);
    console.log(`     GET    /api/chat/conversations        — historial de conversaciones`);
    console.log(`     POST   /api/chat/conversations        — nueva conversación`);
    console.log(`     GET    /api/chat/conversations/:id    — mensajes de una conversación`);
    console.log(`     POST   /api/chat/conversations/:id/resume — reanudar thread`);
    console.log(`     POST   /api/chat/conversations/:id/messages — enviar mensaje (SSE)`);
    console.log(`     POST   /api/chat/conversations/:id/cancel — interrumpir turno`);
    console.log(`     GET    /health             — health check\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
