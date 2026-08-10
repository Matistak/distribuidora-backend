import type { FastifyInstance } from "fastify";
import type { VentaRow } from "../lib/types.js";
import { prisma } from "../server.js";

export async function ventasRoutes(app: FastifyInstance) {
  const DEFAULT_PAGE_SIZE = 20;
  const MAX_PAGE_SIZE = 100;

  /** GET /api/ventas — filas paginadas con filtros opcionales */
  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      desde?: string;
      hasta?: string;
      vendedor?: string;
      canal?: string;
      ciudad?: string;
      zona?: string;
    };
  }>("/api/ventas", async (req, reply) => {
    const requestedPage = Number.parseInt(req.query.page ?? "1", 10);
    const page =
      Number.isSafeInteger(requestedPage) && requestedPage > 0
        ? requestedPage
        : 1;
    const requestedPageSize = Number.parseInt(
      req.query.pageSize ?? String(DEFAULT_PAGE_SIZE),
      10,
    );
    const pageSize = Math.min(
      Math.max(
        Number.isSafeInteger(requestedPageSize) && requestedPageSize > 0
          ? requestedPageSize
          : DEFAULT_PAGE_SIZE,
        1,
      ),
      MAX_PAGE_SIZE,
    );
    const { desde, hasta, vendedor, canal, ciudad, zona } = req.query;

    const where: Record<string, unknown> = {};
    if (desde || hasta) {
      const fecha: { gte?: Date; lt?: Date } = {};
      if (desde) fecha.gte = new Date(`${desde}T00:00:00.000Z`);
      if (hasta) {
        const siguienteDia = new Date(`${hasta}T00:00:00.000Z`);
        siguienteDia.setUTCDate(siguienteDia.getUTCDate() + 1);
        fecha.lt = siguienteDia;
      }
      where.fecha = fecha;
    }
    if (vendedor) where.vendedor = vendedor;
    if (canal) where.canal = canal;
    if (ciudad) where.ciudad = ciudad;
    if (zona) where.zona = zona;

    const [data, total] = await Promise.all([
      prisma.venta.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ fecha: "desc" }, { nroDoc: "asc" }],
      }),
      prisma.venta.count({ where }),
    ]);

    const rows: VentaRow[] = data.map((v) => ({
      codCompania: v.codCompania,
      compania: v.compania,
      codDistribuidora: v.codDistribuidora,
      distribuidora: v.distribuidora,
      codCliente: v.codCliente,
      razonSocial: v.razonSocial,
      codProducto: v.codProducto,
      producto: v.producto,
      codMarca: v.codMarca,
      marca: v.marca,
      fecha: v.fecha.toISOString().slice(0, 10),
      anhoMes: v.anhoMes,
      anho: v.anho,
      mes: v.mes,
      dia: v.dia,
      vtaUnit: v.vtaUnit,
      montoIvaBrutaGua: v.montoIvaBrutaGua,
      costoVtaGua: v.costoVtaGua,
      montoVtaNetaGua: v.montoVtaNetaGua,
      codCanal: v.codCanal,
      canal: v.canal,
      codRamo: v.codRamo,
      ramo: v.ramo,
      codVendedor: v.codVendedor,
      vendedor: v.vendedor,
      tipoDoc: v.tipoDoc,
      nroDoc: v.nroDoc,
      nroComprobante: Number(v.nroComprobante),
      codZona: v.codZona,
      zona: v.zona,
      codTipoProducto: v.codTipoProducto,
      tipoProducto: v.tipoProducto,
      precioConIva: v.precioConIva,
      precioSinIva: v.precioSinIva,
      porcDescuento: v.porcDescuento,
      precioLista: v.precioLista,
      iva: v.iva,
      ciudad: v.ciudad,
      ruc: v.ruc,
      latitud: v.latitud,
      longitud: v.longitud,
    }));

    return reply.send({ data: rows, total });
  });
}
