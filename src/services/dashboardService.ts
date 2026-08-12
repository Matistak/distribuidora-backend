import { Prisma, PrismaClient } from "@prisma/client";
import type { DashboardData, Filtros } from "../lib/types.js";

const toNumber = (value: number | bigint | null | undefined) =>
  Number(value ?? 0);
const toIsoDate = (value: string | number | bigint | null | undefined) => {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
};

type NumericValue = number | bigint | null | undefined;
type SerieRaw = { label: string | number | bigint; valor: NumericValue };
type RankingRaw = {
  nombre: string;
  valor: NumericValue;
  participacion: NumericValue;
};

/** Construye la clausula WHERE compartida (fechas + filtros) para consultas de ventas. */
export function whereClausula(
  desde: string,
  hasta: string,
  f: Filtros,
  alias = "v",
): Prisma.Sql {
  const conds: Prisma.Sql[] = [];

  if (desde) {
    conds.push(
      Prisma.sql`${Prisma.raw(alias)}."fecha" >= ${desde}`,
    );
  }
  if (hasta) {
    conds.push(
      Prisma.sql`${Prisma.raw(alias)}."fecha" < date(${hasta}, '+1 day')`,
    );
  }
  if (f.cliente)
    conds.push(Prisma.sql`${Prisma.raw(alias)}."razonSocial" LIKE ${`%${f.cliente}%`}`);
  if (f.vendedor)
    conds.push(Prisma.sql`${Prisma.raw(alias)}."vendedor" = ${f.vendedor}`);
  if (f.canal)
    conds.push(Prisma.sql`${Prisma.raw(alias)}."canal" = ${f.canal}`);
  if (f.ciudad)
    conds.push(Prisma.sql`${Prisma.raw(alias)}."ciudad" = ${f.ciudad}`);
  if (f.zona) conds.push(Prisma.sql`${Prisma.raw(alias)}."zona" = ${f.zona}`);

  if (conds.length === 0) return Prisma.sql`TRUE`;
  return Prisma.join(conds, " AND ");
}

export async function obtenerDashboard(
  prisma: PrismaClient | Prisma.TransactionClient,
  desde: string,
  hasta: string,
  filtros: Filtros,
): Promise<DashboardData> {
  const where = whereClausula(desde, hasta, filtros);

  const kpiRaw = await prisma.$queryRaw<
    Array<{
      ventaBruta: number | bigint;
      ventaNeta: number | bigint;
      cantidadFacturas: number | bigint;
      unidadesVendidas: number | bigint;
      clientesActivos: number | bigint;
      productosDistintos: number | bigint;
      costoTotal: number | bigint;
      notasCredito: number | bigint;
      periodoDesde: string | number | bigint | null;
      periodoHasta: string | number | bigint | null;
    }>
  >(Prisma.sql`
    SELECT
      CAST(COALESCE(SUM(v."montoIvaBrutaGua"), 0) AS REAL)          AS "ventaBruta",
      CAST(COALESCE(SUM(v."montoVtaNetaGua"), 0) AS REAL)           AS "ventaNeta",
      CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER)                    AS "cantidadFacturas",
      CAST(COALESCE(SUM(v."vtaUnit"), 0) AS REAL)                    AS "unidadesVendidas",
      CAST(COUNT(DISTINCT v."codCliente") AS INTEGER)                AS "clientesActivos",
      CAST(COUNT(DISTINCT v."codProducto") AS INTEGER)               AS "productosDistintos",
      CAST(COALESCE(SUM(v."costoVtaGua"), 0) AS REAL)                AS "costoTotal",
      CAST(COUNT(DISTINCT CASE WHEN LOWER(v."tipoDoc") LIKE LOWER('%CREDITO%') THEN v."nroDoc" END) AS INTEGER) AS "notasCredito",
      MIN(v."fecha") AS "periodoDesde",
      MAX(v."fecha") AS "periodoHasta"
    FROM "Venta" v
    WHERE ${where}
  `);

  const kpiRow = kpiRaw[0];
  const kpi = {
    ventaBruta: toNumber(kpiRow?.ventaBruta),
    ventaNeta: toNumber(kpiRow?.ventaNeta),
    cantidadFacturas: toNumber(kpiRow?.cantidadFacturas),
    unidadesVendidas: toNumber(kpiRow?.unidadesVendidas),
    clientesActivos: toNumber(kpiRow?.clientesActivos),
    productosDistintos: toNumber(kpiRow?.productosDistintos),
    costoTotal: toNumber(kpiRow?.costoTotal),
    notasCredito: toNumber(kpiRow?.notasCredito),
  };
  const ticketPromedio = kpi.cantidadFacturas
    ? kpi.ventaNeta / kpi.cantidadFacturas
    : 0;
  const margenPorc = kpi.ventaNeta
    ? (kpi.ventaNeta - kpi.costoTotal) / kpi.ventaNeta
    : 0;
  const totalVentaNeta = kpi.ventaNeta;

  const queryRaw = <T>(sql: Prisma.Sql) => prisma.$queryRaw<T>(sql);

  const [
    ventasPorDia,
    ventasPorVendedor,
    ventasPorCiudad,
    ventasPorCanal,
    ventasPorMarca,
    topClientes,
    topProductos,
  ] = await Promise.all([
    queryRaw<SerieRaw[]>(Prisma.sql`
      SELECT CAST(v."dia" AS TEXT) AS label, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor
      FROM "Venta" v WHERE ${where}
      GROUP BY v."dia" ORDER BY v."dia" ASC
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT v."vendedor" AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF(${totalVentaNeta}, 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."vendedor" ORDER BY valor DESC LIMIT 10
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT v."ciudad" AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF(${totalVentaNeta}, 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."ciudad" ORDER BY valor DESC LIMIT 7
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT v."canal" AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF(${totalVentaNeta}, 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."canal" ORDER BY valor DESC LIMIT 8
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT COALESCE(v."marca", 'SIN MARCA') AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF(${totalVentaNeta}, 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY COALESCE(v."marca", 'SIN MARCA') ORDER BY valor DESC LIMIT 10
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT COALESCE(v."razonSocial", 'SIN CLIENTE') AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF(${totalVentaNeta}, 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY COALESCE(v."razonSocial", 'SIN CLIENTE') ORDER BY valor DESC LIMIT 5
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT COALESCE(v."producto", 'SIN PRODUCTO') AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF(${totalVentaNeta}, 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY COALESCE(v."producto", 'SIN PRODUCTO') ORDER BY valor DESC LIMIT 8
    `),
  ]);

  const serie = (rows: SerieRaw[]) =>
    rows.map((row) => ({
      label: String(row.label),
      valor: toNumber(row.valor),
    }));
  const ranking = (rows: RankingRaw[]) =>
    rows.map((row) => ({
      nombre: row.nombre,
      valor: toNumber(row.valor),
      participacion: toNumber(row.participacion),
    }));

  return {
    kpis: {
      ventaBruta: kpi.ventaBruta,
      ventaNeta: kpi.ventaNeta,
      ticketPromedio,
      cantidadFacturas: kpi.cantidadFacturas,
      unidadesVendidas: kpi.unidadesVendidas,
      clientesActivos: kpi.clientesActivos,
      productosDistintos: kpi.productosDistintos,
      notasCredito: kpi.notasCredito,
      margenPorc,
    },
    ventasPorDia: serie(ventasPorDia),
    ventasPorVendedor: ranking(ventasPorVendedor),
    ventasPorCiudad: ranking(ventasPorCiudad),
    ventasPorCanal: ranking(ventasPorCanal),
    ventasPorMarca: ranking(ventasPorMarca),
    topClientes: ranking(topClientes),
    topProductos: ranking(topProductos),
    periodo: {
      desde: toIsoDate(kpiRow?.periodoDesde),
      hasta: toIsoDate(kpiRow?.periodoHasta),
    },
  };
}
