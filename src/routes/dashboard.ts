import type { FastifyInstance } from "fastify";
import { prisma } from "../server.js";
import { obtenerDashboard } from "../services/dashboardService.js";
import { obtenerResumen } from "../services/resumenService.js";
import { obtenerAlertas } from "../services/alertasService.js";
import type { Filtros } from "../lib/types.js";

export async function dashboardRoutes(app: FastifyInstance) {
  /** GET /api/dashboard — KPIs, series y rankings con filtros */
  app.get<{
    Querystring: {
      desde?: string;
      hasta?: string;
      cliente?: string;
      vendedor?: string;
      canal?: string;
      ciudad?: string;
      zona?: string;
    };
  }>("/api/dashboard", async (req, reply) => {
    const { desde = "", hasta = "", cliente, vendedor, canal, ciudad, zona } = req.query;

    const filtros: Filtros = { cliente, vendedor, canal, ciudad, zona };
    const data = await obtenerDashboard(prisma, desde, hasta, filtros);

    return reply.send(data);
  });

  app.get<{
    Querystring: {
      cliente?: string;
      vendedor?: string;
      canal?: string;
      ciudad?: string;
      zona?: string;
    };
  }>("/api/dashboard/resumen", async (req, reply) => {
    const { cliente, vendedor, canal, ciudad, zona } = req.query;

    const filtros: Filtros = { cliente, vendedor, canal, ciudad, zona };
    const data = await obtenerResumen(prisma, filtros);

    return reply.send(data);
  });

  /** GET /api/dashboard/alertas — señales de caída/crecimiento del mes vigente */
  app.get<{
    Querystring: {
      cliente?: string;
      vendedor?: string;
      canal?: string;
      ciudad?: string;
      zona?: string;
    };
  }>("/api/dashboard/alertas", async (req, reply) => {
    const { cliente, vendedor, canal, ciudad, zona } = req.query;

    const filtros: Filtros = { cliente, vendedor, canal, ciudad, zona };
    const data = await obtenerAlertas(prisma, filtros);

    return reply.send(data);
  });
}
