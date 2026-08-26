import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../server.js";
import { parseExcel } from "../services/excelParser.js";
import { RowValidationError } from "../services/ventaRowParser.js";
import {
  SourceConfigError,
  fetchVentasSource,
  sourceConfig,
} from "../services/ventasSource.js";
import {
  type RangoFechas,
  insertRows,
  rangoDeFilas,
  rangoDeMeses,
} from "../services/ventaImporter.js";
import { optimizeSqlite } from "../services/sqlitePerformance.js";
import type { UploadHistorial, UploadResponse, VentaRow } from "../lib/types.js";

const cargaBaseSchema = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}$/, "desde debe tener formato YYYY-MM"),
  hasta: z.string().regex(/^\d{4}-\d{2}$/, "hasta debe tener formato YYYY-MM"),
});

type ParsedCarga = {
  filas: VentaRow[];
  filasTotales: number;
  filasErrores: number;
  errores: UploadResponse["errores"];
  erroresTruncados: boolean;
};

export async function uploadRoutes(app: FastifyInstance) {
  /**
   * Persiste una carga (Excel o base externa) dentro de una sola transacción.
   * Es un reemplazo del rango: se borra todo lo que haya entre `rango.desde` y
   * `rango.hasta` y queda únicamente lo que trajo este origen, sin descartar
   * ninguna fila.
   */
  async function guardarCarga(origen: string, parsed: ParsedCarga, rango: RangoFechas | null) {
    const result = await prisma.$transaction(
      async (tx) => {
        const carga = await tx.carga.create({
          data: {
            archivo: origen,
            filasTotales: parsed.filasTotales,
            filasErrores: parsed.filasErrores,
            estado: "procesando",
          },
        });
        const inserto = await insertRows(tx, parsed.filas, carga.id, rango);
        return tx.carga.update({
          where: { id: carga.id },
          data: {
            filasNuevas: inserto.filasNuevas,
            filasReemplazadas: inserto.filasReemplazadas,
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
      filasReemplazadas: result.filasReemplazadas,
      filasErrores: result.filasErrores,
      errores: parsed.errores,
      ...(parsed.erroresTruncados ? { erroresTruncados: true } : {}),
      estado: result.estado,
      ...(rango ? { rango } : {}),
    };
    return respuesta;
  }

  /** POST /api/uploads — sube y procesa un Excel */
  app.post("/api/uploads", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: "No se recibió ningún archivo" });

    const buffer = await data.toBuffer();
    let parsed: ReturnType<typeof parseExcel>;
    try {
      parsed = parseExcel(buffer);
    } catch (error) {
      if (error instanceof RowValidationError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }

    // El Excel no declara su período: el rango a reemplazar sale de sus filas.
    return reply.send(await guardarCarga(data.filename, parsed, rangoDeFilas(parsed.filas)));
  });

  /**
   * GET /api/uploads/origen — indica si el origen externo está configurado.
   * No abre conexión ni consulta la vista: sólo mira la configuración, para que
   * la ventana de carga pueda avisar antes de que el usuario pida los datos.
   */
  app.get("/api/uploads/origen", async (_req, reply) => {
    const config = sourceConfig();
    return reply.send(
      config ? { configurado: true, tabla: config.tabla } : { configurado: false },
    );
  });

  /** POST /api/uploads/base — importa desde la base externa por rango de meses (YYYY-MM) */
  app.post("/api/uploads/base", async (req, reply) => {
    const body = cargaBaseSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? "Rango inválido" });
    }
    const { desde, hasta } = body.data;

    let parsed: Awaited<ReturnType<typeof fetchVentasSource>>;
    try {
      parsed = await fetchVentasSource(desde, hasta);
    } catch (error) {
      if (error instanceof RowValidationError || error instanceof SourceConfigError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }

    if (parsed.truncado) {
      app.log.warn(
        { desde, hasta, filas: parsed.filasTotales },
        "La carga por base de datos alcanzó el límite de filas configurado",
      );
    }

    // Acá el rango lo eligió el usuario: se reemplazan los meses completos.
    const respuesta = await guardarCarga(
      `Base de datos ${desde} a ${hasta}`,
      parsed,
      rangoDeMeses(desde, hasta),
    );
    return reply.send({ ...respuesta, truncado: parsed.truncado });
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
        filasReemplazadas: true,
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
