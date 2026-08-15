import type { FastifyInstance } from "fastify";
import { prisma } from "../server.js";
import type { OpcionesFiltro } from "../lib/types.js";
import { etiquetaCliente } from "../lib/clientes.js";

export async function filtrosRoutes(app: FastifyInstance) {
  /** GET /api/filtros — listas de clientes / vendedores / canales / ciudades / zonas */
  app.get("/api/filtros", async (_req, reply) => {
    const [clientes, vendedores, canales, ciudades, zonas, tiposDoc] = await Promise.all([
      prisma.cliente.findMany({
        where: { razonSocial: { not: null } },
        select: { razonSocial: true, ruc: true },
        orderBy: { razonSocial: "asc" },
        take: 10,
      }),
      prisma.vendedor.findMany({
        where: { vendedor: { not: null } },
        select: { vendedor: true },
        orderBy: { vendedor: "asc" },
      }),
      prisma.venta.findMany({ select: { canal: true }, distinct: ["canal"], orderBy: { canal: "asc" } }),
      prisma.venta.findMany({ select: { ciudad: true }, distinct: ["ciudad"], orderBy: { ciudad: "asc" } }),
      prisma.venta.findMany({ select: { zona: true }, distinct: ["zona"], orderBy: { zona: "asc" } }),
      prisma.venta.findMany({
        select: { tipoDoc: true },
        distinct: ["tipoDoc"],
        orderBy: { tipoDoc: "asc" },
      }),
    ]);

    const resultado: OpcionesFiltro = {
      clientes: [
        ...new Set(
          clientes
            .map((c) => etiquetaCliente(c.ruc, c.razonSocial))
            .filter((c): c is string => c !== null),
        ),
      ],
      vendedores: vendedores.map((v) => v.vendedor).filter((v): v is string => v !== null),
      canales: canales.map((c) => c.canal).filter((c): c is string => c !== null),
      ciudades: ciudades.map((c) => c.ciudad).filter((c): c is string => c !== null),
      zonas: zonas.map((z) => z.zona).filter((z): z is string => z !== null),
      tiposDoc: tiposDoc.map((t) => t.tipoDoc).filter((t): t is string => t !== null),
    };

    return reply.send(resultado);
  });
}
