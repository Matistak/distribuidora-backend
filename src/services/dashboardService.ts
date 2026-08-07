import { Prisma, PrismaClient } from "@prisma/client";
import type { DashboardData, Filtros } from "../lib/types.js";

const toNumber = (value: number | bigint | null | undefined) =>
  Number(value ?? 0);
const toIsoDate = (value: string | number | bigint | null | undefined) => {
  if (value === null || value === undefined || value === "") return "";
  const numeric =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const date = new Date(
    typeof numeric === "string" ? numeric : Number(numeric),
  );
  return Number.isNaN(date.getTime())
    ? String(value).slice(0, 10)
    : date.toISOString().slice(0, 10);
};

type NumericValue = number | bigint | null | undefined;
type SerieRaw = { label: string | number | bigint; valor: NumericValue };
type RankingRaw = {
  nombre: string;
  valor: NumericValue;
  participacion: NumericValue;
};

function whereClausula(desde: string, hasta: string, f: Filtros): Prisma.Sql {
  const conds: Prisma.Sql[] = [];

  if (desde) {
    conds.push(
      Prisma.sql`v."fecha" >= CAST(strftime('%s', ${desde}) AS INTEGER) * 1000`,
    );
  }
  if (hasta) {
    conds.push(
      Prisma.sql`v."fecha" < (CAST(strftime('%s', ${hasta}) AS INTEGER) + 86400) * 1000`,
    );
  }
  if (f.vendedor) conds.push(Prisma.sql`v."vendedor" = ${f.vendedor}`);
  if (f.canal) conds.push(Prisma.sql`v."canal" = ${f.canal}`);
  if (f.ciudad) conds.push(Prisma.sql`v."ciudad" = ${f.ciudad}`);
  if (f.zona) conds.push(Prisma.sql`v."zona" = ${f.zona}`);

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
      CAST(COUNT(DISTINCT CASE WHEN LOWER(v."tipoDoc") LIKE LOWER('%CREDITO%') THEN v."nroDoc" END) AS INTEGER) AS "notasCredito"
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

  const queryRaw = <T>(sql: Prisma.Sql) => prisma.$queryRaw<T>(sql);

  const [
    ventasPorDia,
    ventasPorVendedor,
    ventasPorCiudad,
    ventasPorCanal,
    ventasPorMarca,
    topClientes,
    topProductos,
    periodoRaw,
  ] = await Promise.all([
    queryRaw<SerieRaw[]>(Prisma.sql`
      SELECT CAST(v."dia" AS TEXT) AS label, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor
      FROM "Venta" v WHERE ${where}
      GROUP BY v."dia" ORDER BY v."dia" ASC
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT v."vendedor" AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."vendedor" ORDER BY valor DESC LIMIT 10
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT v."ciudad" AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."ciudad" ORDER BY valor DESC LIMIT 7
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT v."canal" AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."canal" ORDER BY valor DESC LIMIT 8
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT v."marca" AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."marca" ORDER BY valor DESC LIMIT 10
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT v."razonSocial" AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."razonSocial" ORDER BY valor DESC LIMIT 5
    `),

    queryRaw<RankingRaw[]>(Prisma.sql`
      SELECT v."producto" AS nombre, CAST(SUM(v."montoVtaNetaGua") AS REAL) AS valor,
             CAST(SUM(v."montoVtaNetaGua") AS REAL) / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."producto" ORDER BY valor DESC LIMIT 8
    `),

    queryRaw<
      Array<{
        desde: string | number | bigint | null;
        hasta: string | number | bigint | null;
      }>
    >(Prisma.sql`
      SELECT MIN(v."fecha") AS desde, MAX(v."fecha") AS hasta
      FROM "Venta" v WHERE ${where}
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
      desde: toIsoDate(periodoRaw[0]?.desde),
      hasta: toIsoDate(periodoRaw[0]?.hasta),
    },
  };
}
