import type { FastifyInstance } from "fastify";
import { prisma } from "../server.js";
import { parseExcel } from "../services/excelParser.js";
import type { UploadResponse, UploadHistorial } from "../lib/types.js";

export async function uploadRoutes(app: FastifyInstance) {
  /** POST /api/uploads — sube y procesa un Excel */
  app.post("/api/uploads", async (req, reply) => {
    let archivo = "desconocido.xlsx";
    let buffer: Buffer;

    const data = await req.file();
    if (!data) return reply.status(400).send({ error: "No se recibió ningún archivo" });

    archivo = data.filename;
    buffer = await data.toBuffer();

    const filas = parseExcel(buffer.buffer as ArrayBuffer);

    if (filas.length === 0) {
      return reply.status(422).send({ error: "El archivo no contiene registros válidos" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const carga = await tx.carga.create({
        data: { archivo, filasTotales: filas.length, estado: "procesando" },
      });

      const insertData = filas.map((f) => ({
        ...f,
        fecha: new Date(f.fecha),
        cargaId: carga.id,
      }));

      const batch = await tx.venta.createMany({
        data: insertData,
        skipDuplicates: true,
      });

      const omitidas = filas.length - batch.count;

      const actualizada = await tx.carga.update({
        where: { id: carga.id },
        data: { filasNuevas: batch.count, filasOmitidas: omitidas, estado: "procesado" },
      });

      return actualizada;
    });

    const respuesta: UploadResponse = {
      id: result.id,
      archivo: result.archivo,
      filasTotales: result.filasTotales,
      filasNuevas: result.filasNuevas,
      filasOmitidas: result.filasOmitidas,
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
        creadoEn: true,
        estado: true,
      },
    });

    const resultado: UploadHistorial[] = cargas.map((c) => ({
      ...c,
      creadoEn: c.creadoEn.toISOString(),
    }));

    return reply.send(resultado);
  });

  /** GET /api/uploads/:id — estado de una carga */
  app.get<{ Params: { id: string } }>("/api/uploads/:id", async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: "ID inválido" });

    const carga = await prisma.carga.findUnique({ where: { id } });
    if (!carga) return reply.status(404).send({ error: "Carga no encontrada" });

    const respuesta: UploadHistorial = {
      ...carga,
      creadoEn: carga.creadoEn.toISOString(),
    };

    return reply.send(respuesta);
  });
}
