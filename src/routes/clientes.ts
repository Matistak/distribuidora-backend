import type { FastifyInstance } from "fastify";
import { prisma } from "../server.js";

const LIMITE_MAX = 100;

export async function clientesRoutes(app: FastifyInstance) {
  /** GET /api/clientes — búsqueda de clientes por nombre (para el buscador con debounce) */
  app.get<{ Querystring: { q?: string; limite?: string } }>(
    "/api/clientes",
    async (req, reply) => {
      const q = (req.query.q ?? "").trim();
      const solicitado = Number.parseInt(req.query.limite ?? "50", 10);
      const limite = Math.min(
        Math.max(Number.isSafeInteger(solicitado) && solicitado > 0 ? solicitado : 50, 1),
        LIMITE_MAX,
      );

      const filas = await prisma.cliente.findMany({
        where: {
          razonSocial: {
            not: null,
            ...(q ? { contains: q } : {}),
          },
        },
        select: { razonSocial: true },
        orderBy: { razonSocial: "asc" },
        take: limite,
      });

      return reply.send(filas.map((fila) => fila.razonSocial as string));
    },
  );
}
