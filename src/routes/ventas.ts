import type { FastifyInstance } from "fastify";
import type { VentaRow } from "../lib/types.js";
import { prisma } from "../server.js";

export async function ventasRoutes(app: FastifyInstance) {
  /** GET /api/ventas — filas paginadas con filtros opcionales */
  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      vendedor?: string;
      canal?: string;
      ciudad?: string;
      zona?: string;
    };
  }>("/api/ventas", async (req, reply) => {
    const page = Math.max(parseInt(req.query.page ?? "1", 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize ?? "20", 10) || 20, 1), 100);
    const { vendedor, canal, ciudad, zona } = req.query;

    const where: Record<string, unknown> = {};
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
      nroComprobante: v.nroComprobante,
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
