import type { FastifyInstance } from "fastify";
import { prisma } from "../server.js";
import { obtenerDashboard } from "../services/dashboardService.js";
import type { Filtros } from "../lib/types.js";

export async function dashboardRoutes(app: FastifyInstance) {
  /** GET /api/dashboard — KPIs, series y rankings con filtros */
  app.get<{
    Querystring: {
      desde?: string;
      hasta?: string;
      vendedor?: string;
      canal?: string;
      ciudad?: string;
      zona?: string;
    };
  }>("/api/dashboard", async (req, reply) => {
    const { desde = "", hasta = "", vendedor, canal, ciudad, zona } = req.query;

    const filtros: Filtros = { vendedor, canal, ciudad, zona };
    const data = await obtenerDashboard(prisma, desde, hasta, filtros);

    return reply.send(data);
  });
}
