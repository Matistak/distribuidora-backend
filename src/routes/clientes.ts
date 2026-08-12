import type { FastifyInstance } from "fastify";
import { prisma } from "../server.js";
import { etiquetaCliente } from "../lib/clientes.js";

const LIMITE_DEFAULT = 10;
const LIMITE_MAX = 100;

export async function clientesRoutes(app: FastifyInstance) {
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
