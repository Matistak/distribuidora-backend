import type { FastifyInstance } from "fastify";
import { prisma } from "../server.js";
import { etiquetaCliente } from "../lib/clientes.js";
import { obtenerClientes } from "../services/clientesService.js";
import type { Filtros } from "../lib/types.js";

const LIMITE_DEFAULT = 10;
const LIMITE_MAX = 100;

export async function clientesRoutes(app: FastifyInstance) {
  /** GET /api/clientes/resumen — KPIs + resumen agregado por cliente */
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
  }>("/api/clientes/resumen", async (req, reply) => {
    const { desde = "", hasta = "", cliente, vendedor, canal, ciudad, zona } = req.query;

    const filtros: Filtros = { cliente, vendedor, canal, ciudad, zona };
    // Los KPIs solo responden al rango de fechas, nunca al cliente.
    const filtrosKpis: Filtros = { vendedor, canal, ciudad, zona };
    const data = await obtenerClientes(prisma, desde, hasta, filtros, filtrosKpis);

    return reply.send(data);
  });

  /** GET /api/clientes — búsqueda de clientes por nombre */
  app.get<{ Querystring: { q?: string; limite?: string } }>(
    "/api/clientes",
    async (req, reply) => {
      const q = (req.query.q ?? "").trim();
      const solicitado = Number.parseInt(
        req.query.limite ?? String(LIMITE_DEFAULT),
        10,
      );
      const limite = Math.min(
        Math.max(
          Number.isSafeInteger(solicitado) && solicitado > 0
            ? solicitado
            : LIMITE_DEFAULT,
          1,
        ),
        LIMITE_MAX,
      );

      const filas = await prisma.cliente.findMany({
        where: {
          razonSocial: { not: null },
          ...(q
            ? {
                OR: [
                  { razonSocial: { contains: q } },
                  { ruc: { contains: q } },
                ],
              }
            : {}),
        },
        select: { razonSocial: true, ruc: true },
        orderBy: { razonSocial: "asc" },
        take: limite,
      });

      return reply.send([
        ...new Set(
          filas
            .map((fila) => etiquetaCliente(fila.ruc, fila.razonSocial))
            .filter((cliente): cliente is string => cliente !== null),
        ),
      ]);
    },
  );
}
