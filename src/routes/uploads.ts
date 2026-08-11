import type { FastifyInstance } from "fastify";
import { prisma } from "../server.js";
import { ExcelValidationError, parseExcel } from "../services/excelParser.js";
import { insertRows } from "../services/ventaImporter.js";
import { optimizeSqlite } from "../services/sqlitePerformance.js";
import type { UploadHistorial, UploadResponse } from "../lib/types.js";

export async function uploadRoutes(app: FastifyInstance) {
  /** POST /api/uploads — sube y procesa un Excel */
  app.post("/api/uploads", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: "No se recibió ningún archivo" });

    const buffer = await data.toBuffer();
    let parsed: ReturnType<typeof parseExcel>;
    try {
      parsed = parseExcel(buffer);
    } catch (error) {
      if (error instanceof ExcelValidationError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }

    const result = await prisma.$transaction(
      async (tx) => {
        const carga = await tx.carga.create({
          data: {
            archivo: data.filename,
            filasTotales: parsed.filasTotales,
            filasErrores: parsed.filasErrores,
            estado: "procesando",
          },
        });
        const filasNuevas = await insertRows(tx, parsed.filas, carga.id);
        return tx.carga.update({
          where: { id: carga.id },
          data: {
            filasNuevas,
            filasOmitidas: parsed.filas.length - filasNuevas,
            estado: parsed.filasErrores > 0 ? "procesado_con_errores" : "procesado",
          },
        });
      },
      { maxWait: 30_000, timeout: 300_000 },
    );

    try {
      await optimizeSqlite(prisma);
    } catch (error) {
      app.log.warn({ error }, "No se pudieron actualizar las estadísticas de SQLite");
    }

    const respuesta: UploadResponse = {
      id: result.id,
      archivo: result.archivo,
      filasTotales: result.filasTotales,
      filasNuevas: result.filasNuevas,
      filasOmitidas: result.filasOmitidas,
      filasErrores: result.filasErrores,
      errores: parsed.errores,
      estado: result.estado,
    };
    return reply.send(respuesta);
  });

  /** GET /api/uploads — historial de cargas */
  app.get("/api/uploads", async (_req, reply) => {
    const cargas = await prisma.carga.findMany({
      orderBy: { creadoEn: "desc" },
      select: {
        id: true,
        archivo: true,
        filasTotales: true,
        filasNuevas: true,
        filasOmitidas: true,
        filasErrores: true,
        creadoEn: true,
        estado: true,
      },
    });
    const resultado: UploadHistorial[] = cargas.map((carga) => ({
      ...carga,
      creadoEn: carga.creadoEn.toISOString(),
    }));
    return reply.send(resultado);
  });

  /** GET /api/uploads/:id — estado de una carga */
  app.get<{ Params: { id: string } }>("/api/uploads/:id", async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return reply.status(400).send({ error: "ID inválido" });
    const carga = await prisma.carga.findUnique({ where: { id } });
    if (!carga) return reply.status(404).send({ error: "Carga no encontrada" });
    const respuesta: UploadHistorial = {
      ...carga,
      creadoEn: carga.creadoEn.toISOString(),
    };
    return reply.send(respuesta);
  });
}
