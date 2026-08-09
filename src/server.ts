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

export const prisma = new PrismaClient();

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

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

async function start() {
  const app = await buildApp();
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
    console.log(`     GET    /health             — health check\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
