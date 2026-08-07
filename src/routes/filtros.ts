import type { FastifyInstance } from "fastify";
import { prisma } from "../server.js";
import type { OpcionesFiltro } from "../lib/types.js";

export async function filtrosRoutes(app: FastifyInstance) {
  /** GET /api/filtros — listas de vendedores / canales / ciudades / zonas */
  app.get("/api/filtros", async (_req, reply) => {
    const [vendedores, canales, ciudades, zonas] = await Promise.all([
      prisma.venta.findMany({ select: { vendedor: true }, distinct: ["vendedor"], orderBy: { vendedor: "asc" } }),
      prisma.venta.findMany({ select: { canal: true }, distinct: ["canal"], orderBy: { canal: "asc" } }),
      prisma.venta.findMany({ select: { ciudad: true }, distinct: ["ciudad"], orderBy: { ciudad: "asc" } }),
      prisma.venta.findMany({ select: { zona: true }, distinct: ["zona"], orderBy: { zona: "asc" } }),
    ]);

    const resultado: OpcionesFiltro = {
      vendedores: vendedores.map((v) => v.vendedor),
      canales: canales.map((c) => c.canal),
      ciudades: ciudades.map((c) => c.ciudad),
      zonas: zonas.map((z) => z.zona),
    };

    return reply.send(resultado);
  });
}
