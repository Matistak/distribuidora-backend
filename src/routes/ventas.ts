import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import type { ComprobanteDetalle, ComprobanteResumen, VentaRow } from "../lib/types.js";
import { prisma } from "../server.js";
import { etiquetaCliente } from "../lib/clientes.js";

type VentasQuery = {
  page?: string;
  pageSize?: string;
  desde?: string;
  hasta?: string;
  cliente?: string;
  vendedor?: string;
  canal?: string;
  ciudad?: string;
  zona?: string;
  tipoDoc?: string;
};

type VentaRecord = Prisma.VentaGetPayload<{}>;

async function resolverCliente(cliente?: string) {
  if (!cliente) return undefined;

  const separador = cliente.indexOf(" - ");
  const ruc = separador >= 0 ? cliente.slice(0, separador) : "";
  const razonSocial = separador >= 0 ? cliente.slice(separador + 3) : "";
  const coincidencias = await prisma.cliente.findMany({
    where: {
      OR: [
        ...(separador >= 0 ? [{ ruc, razonSocial }] : []),
        { razonSocial: { contains: cliente } },
        { ruc: { contains: cliente } },
      ],
    },
    select: { codCliente: true, razonSocial: true, ruc: true },
  });
  const exactas = coincidencias.filter((c) => etiquetaCliente(c.ruc, c.razonSocial) === cliente);
  const candidatas = exactas.length ? exactas : coincidencias;

  return {
    cods: candidatas.map((c) => c.codCliente).filter((c): c is number => c !== null),
    nombres: candidatas.map((c) => c.razonSocial).filter((c): c is string => c !== null),
  };
}

async function construirWhere(query: VentasQuery): Promise<Record<string, unknown>> {
  const { desde, hasta, cliente, vendedor, canal, ciudad, zona, tipoDoc } = query;
  const where: Record<string, unknown> = {};
  if (desde || hasta) {
    const fecha: { gte?: string; lt?: string } = {};
    if (desde) fecha.gte = desde;
    if (hasta) {
      const siguienteDia = new Date(`${hasta}T00:00:00.000Z`);
      siguienteDia.setUTCDate(siguienteDia.getUTCDate() + 1);
      fecha.lt = siguienteDia.toISOString().slice(0, 10);
    }
    where.fecha = fecha;
  }
  if (cliente) {
    const coincidencias = await resolverCliente(cliente);
    const or: Record<string, unknown>[] = [];
    if (coincidencias?.cods.length) or.push({ codCliente: { in: coincidencias.cods } });
    if (coincidencias?.nombres.length) or.push({ razonSocial: { in: coincidencias.nombres } });
    where.OR = or.length ? or : [{ id: { lt: 0 } }];
  }
  if (vendedor) where.vendedor = vendedor;
  if (canal) where.canal = canal;
  if (ciudad) where.ciudad = ciudad;
  if (zona) where.zona = zona;
  if (tipoDoc) where.tipoDoc = tipoDoc;
  return where;
}

async function construirWhereSql(query: VentasQuery): Promise<Prisma.Sql> {
  const { desde, hasta, cliente, vendedor, canal, ciudad, zona, tipoDoc } = query;
  const condiciones: Prisma.Sql[] = [];
  if (desde) condiciones.push(Prisma.sql`v."fecha" >= ${desde}`);
  if (hasta) {
    const siguienteDia = new Date(`${hasta}T00:00:00.000Z`);
    siguienteDia.setUTCDate(siguienteDia.getUTCDate() + 1);
    condiciones.push(Prisma.sql`v."fecha" < ${siguienteDia.toISOString().slice(0, 10)}`);
  }
  if (cliente) {
    const coincidencias = await resolverCliente(cliente);
    const porCliente: Prisma.Sql[] = [];
    if (coincidencias?.cods.length) {
      porCliente.push(Prisma.sql`v."codCliente" IN (${Prisma.join(coincidencias.cods)})`);
    }
    if (coincidencias?.nombres.length) {
      porCliente.push(Prisma.sql`v."razonSocial" IN (${Prisma.join(coincidencias.nombres)})`);
    }
    condiciones.push(
      porCliente.length ? Prisma.sql`(${Prisma.join(porCliente, " OR ")})` : Prisma.sql`1 = 0`,
    );
  }
  if (vendedor) condiciones.push(Prisma.sql`v."vendedor" = ${vendedor}`);
  if (canal) condiciones.push(Prisma.sql`v."canal" = ${canal}`);
  if (ciudad) condiciones.push(Prisma.sql`v."ciudad" = ${ciudad}`);
  if (zona) condiciones.push(Prisma.sql`v."zona" = ${zona}`);
  if (tipoDoc) condiciones.push(Prisma.sql`v."tipoDoc" = ${tipoDoc}`);
  return condiciones.length
    ? Prisma.sql`WHERE ${Prisma.join(condiciones, " AND ")}`
    : Prisma.empty;
}

function toVentaRow(v: VentaRecord): VentaRow {
  return {
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
    fecha: v.fecha,
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
  };
}

function resumenFilas(rows: VentaRecord[]): ComprobanteResumen {
  const primera = rows[0];
  if (!primera) throw new Error("No se puede resumir un comprobante vacío");
  return {
    nroDoc: primera.nroDoc,
    nroComprobante: Number(primera.nroComprobante),
    tipoDoc: primera.tipoDoc,
    fecha: primera.fecha,
    razonSocial: primera.razonSocial,
    ruc: primera.ruc,
    vendedor: primera.vendedor,
    canal: primera.canal,
    ciudad: primera.ciudad,
    cantidadLineas: rows.length,
    unidades: rows.reduce((total, row) => total + (row.vtaUnit ?? 0), 0),
    ventaBruta: rows.reduce((total, row) => total + (row.montoIvaBrutaGua ?? 0), 0),
    ventaNeta: rows.reduce((total, row) => total + (row.montoVtaNetaGua ?? 0), 0),
    esNotaCredito: /CREDITO/i.test(primera.tipoDoc ?? ""),
  };
}

export async function ventasRoutes(app: FastifyInstance) {
  const DEFAULT_PAGE_SIZE = 20;
  const MAX_PAGE_SIZE = 100;

  /** GET /api/ventas — filas paginadas con filtros opcionales */
  app.get<{ Querystring: VentasQuery }>("/api/ventas", async (req, reply) => {
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
    const where = await construirWhere(req.query);

    const [data, total] = await Promise.all([
      prisma.venta.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ fecha: "desc" }, { nroDoc: "asc" }],
      }),
      prisma.venta.count({ where }),
    ]);

    const rows: VentaRow[] = data.map(toVentaRow);

    return reply.send({ data: rows, total });
  });

  /** GET /api/comprobantes — comprobantes agrupados por nroDoc */
  app.get<{ Querystring: VentasQuery }>("/api/comprobantes", async (req, reply) => {
    const requestedPage = Number.parseInt(req.query.page ?? "1", 10);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const requestedPageSize = Number.parseInt(req.query.pageSize ?? "20", 10);
    const pageSize = Math.min(
      Math.max(Number.isSafeInteger(requestedPageSize) && requestedPageSize > 0 ? requestedPageSize : 20, 1),
      100,
    );
    const where = await construirWhereSql(req.query);
    const [data, totalRows] = await Promise.all([
      prisma.$queryRaw<Array<{
        nroDoc: string;
        nroComprobante: number | bigint;
        tipoDoc: string | null;
        fecha: string;
        razonSocial: string | null;
        ruc: string | null;
        vendedor: string | null;
        canal: string | null;
        ciudad: string | null;
        cantidadLineas: number | bigint;
        unidades: number | bigint;
        ventaBruta: number | bigint;
        ventaNeta: number | bigint;
      }>>(Prisma.sql`
        SELECT
          v."nroDoc" AS "nroDoc",
          MIN(v."nroComprobante") AS "nroComprobante",
          MIN(v."tipoDoc") AS "tipoDoc",
          MIN(v."fecha") AS "fecha",
          MIN(v."razonSocial") AS "razonSocial",
          MIN(v."ruc") AS "ruc",
          MIN(v."vendedor") AS "vendedor",
          MIN(v."canal") AS "canal",
          MIN(v."ciudad") AS "ciudad",
          CAST(COUNT(*) AS INTEGER) AS "cantidadLineas",
          CAST(COALESCE(SUM(v."vtaUnit"), 0) AS REAL) AS "unidades",
          CAST(COALESCE(SUM(v."montoIvaBrutaGua"), 0) AS REAL) AS "ventaBruta",
          CAST(COALESCE(SUM(v."montoVtaNetaGua"), 0) AS REAL) AS "ventaNeta"
        FROM "Venta" v
        ${where}
        GROUP BY v."nroDoc"
        ORDER BY "fecha" DESC, "nroDoc" ASC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `),
      prisma.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`
        SELECT CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER) AS "total"
        FROM "Venta" v
        ${where}
      `),
    ]);

    const resumenes: ComprobanteResumen[] = data.map((row) => ({
      nroDoc: row.nroDoc,
      nroComprobante: Number(row.nroComprobante),
      tipoDoc: row.tipoDoc,
      fecha: row.fecha,
      razonSocial: row.razonSocial,
      ruc: row.ruc,
      vendedor: row.vendedor,
      canal: row.canal,
      ciudad: row.ciudad,
      cantidadLineas: Number(row.cantidadLineas),
      unidades: Number(row.unidades),
      ventaBruta: Number(row.ventaBruta),
      ventaNeta: Number(row.ventaNeta),
      esNotaCredito: /CREDITO/i.test(row.tipoDoc ?? ""),
    }));
    return reply.send({ data: resumenes, total: Number(totalRows[0]?.total ?? 0) });
  });

  /** GET /api/comprobantes/:nroDoc — líneas completas de un comprobante */
  app.get<{ Params: { nroDoc: string } }>("/api/comprobantes/:nroDoc", async (req, reply) => {
    const rows = await prisma.venta.findMany({
      where: { nroDoc: req.params.nroDoc },
      orderBy: [{ fecha: "asc" }, { codProducto: "asc" }],
    });
    if (!rows.length) return reply.status(404).send({ error: "Comprobante no encontrado" });
    const detalle: ComprobanteDetalle = {
      resumen: resumenFilas(rows),
      lineas: rows.map(toVentaRow),
    };
    return reply.send(detalle);
  });
}
