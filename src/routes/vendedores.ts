import type { FastifyInstance } from "fastify";
import { prisma } from "../server.js";
import { obtenerVendedores } from "../services/vendedoresService.js";
import type { Filtros } from "../lib/types.js";

export async function vendedoresRoutes(app: FastifyInstance) {
  /** GET /api/vendedores — KPIs + resumen agregado por vendedor */
  app.get<{
    Querystring: {
      desde?: string;
      hasta?: string;
      vendedor?: string;
      cliente?: string;
    };
  }>("/api/vendedores", async (req, reply) => {
    const { desde = "", hasta = "", vendedor, cliente } = req.query;

    const filtros: Filtros = { vendedor, cliente };
    // Los KPIs solo responden al rango de fechas, nunca al vendedor.
    const filtrosKpis: Filtros = { cliente };
    const data = await obtenerVendedores(prisma, desde, hasta, filtros, filtrosKpis);

    return reply.send(data);
  });
}
