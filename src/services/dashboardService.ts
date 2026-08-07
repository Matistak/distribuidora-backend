import { Prisma, PrismaClient } from "@prisma/client";
import type { DashboardData, Filtros } from "../lib/types.js";

function whereClausula(
  desde: string,
  hasta: string,
  f: Filtros,
): Prisma.Sql {
  const conds: Prisma.Sql[] = [];

  if (desde) conds.push(Prisma.sql`v."fecha" >= ${desde}::date`);
  if (hasta) conds.push(Prisma.sql`v."fecha" <= ${hasta}::date`);
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
      ventaBruta: number;
      ventaNeta: number;
      cantidadFacturas: number;
      unidadesVendidas: number;
      clientesActivos: number;
      productosDistintos: number;
      costoTotal: number;
      notasCredito: number;
    }>
  >(Prisma.sql`
    SELECT
      COALESCE(SUM(v."montoIvaBrutaGua"), 0)::float          AS "ventaBruta",
      COALESCE(SUM(v."montoVtaNetaGua"), 0)::float           AS "ventaNeta",
      COUNT(DISTINCT v."nroDoc")::int                         AS "cantidadFacturas",
      COALESCE(SUM(v."vtaUnit"), 0)::float                    AS "unidadesVendidas",
      COUNT(DISTINCT v."codCliente")::int                     AS "clientesActivos",
      COUNT(DISTINCT v."codProducto")::int                    AS "productosDistintos",
      COALESCE(SUM(v."costoVtaGua"), 0)::float                AS "costoTotal",
      COUNT(DISTINCT CASE WHEN v."tipoDoc" ILIKE '%CREDITO%' THEN v."nroDoc" END)::int AS "notasCredito"
    FROM "Venta" v
    WHERE ${where}
  `);

  const kpi = kpiRaw[0] ?? { ventaBruta: 0, ventaNeta: 0, cantidadFacturas: 0, unidadesVendidas: 0, clientesActivos: 0, productosDistintos: 0, costoTotal: 0, notasCredito: 0 };
  const ticketPromedio = kpi.cantidadFacturas ? kpi.ventaNeta / kpi.cantidadFacturas : 0;
  const margenPorc = kpi.ventaNeta ? (kpi.ventaNeta - kpi.costoTotal) / kpi.ventaNeta : 0;

  const queryRaw = prisma.$queryRaw as <T>(sql: Prisma.Sql) => Promise<T>;

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
    queryRaw<Array<{ label: string; valor: number }>>(Prisma.sql`
      SELECT v."dia"::text AS label, SUM(v."montoVtaNetaGua")::float AS valor
      FROM "Venta" v WHERE ${where}
      GROUP BY v."dia" ORDER BY v."dia" ASC
    `),

    queryRaw<Array<{ nombre: string; valor: number; participacion: number }>>(Prisma.sql`
      SELECT v."vendedor" AS nombre, SUM(v."montoVtaNetaGua")::float AS valor,
             SUM(v."montoVtaNetaGua")::float / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."vendedor" ORDER BY valor DESC LIMIT 10
    `),

    queryRaw<Array<{ nombre: string; valor: number; participacion: number }>>(Prisma.sql`
      SELECT v."ciudad" AS nombre, SUM(v."montoVtaNetaGua")::float AS valor,
             SUM(v."montoVtaNetaGua")::float / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."ciudad" ORDER BY valor DESC LIMIT 7
    `),

    queryRaw<Array<{ nombre: string; valor: number; participacion: number }>>(Prisma.sql`
      SELECT v."canal" AS nombre, SUM(v."montoVtaNetaGua")::float AS valor,
             SUM(v."montoVtaNetaGua")::float / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."canal" ORDER BY valor DESC LIMIT 8
    `),

    queryRaw<Array<{ nombre: string; valor: number; participacion: number }>>(Prisma.sql`
      SELECT v."marca" AS nombre, SUM(v."montoVtaNetaGua")::float AS valor,
             SUM(v."montoVtaNetaGua")::float / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."marca" ORDER BY valor DESC LIMIT 10
    `),

    queryRaw<Array<{ nombre: string; valor: number; participacion: number }>>(Prisma.sql`
      SELECT v."razonSocial" AS nombre, SUM(v."montoVtaNetaGua")::float AS valor,
             SUM(v."montoVtaNetaGua")::float / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."razonSocial" ORDER BY valor DESC LIMIT 5
    `),

    queryRaw<Array<{ nombre: string; valor: number; participacion: number }>>(Prisma.sql`
      SELECT v."producto" AS nombre, SUM(v."montoVtaNetaGua")::float AS valor,
             SUM(v."montoVtaNetaGua")::float / NULLIF((SELECT SUM(v2."montoVtaNetaGua") FROM "Venta" v2 WHERE ${where}), 0) AS participacion
      FROM "Venta" v WHERE ${where}
      GROUP BY v."producto" ORDER BY valor DESC LIMIT 8
    `),

    queryRaw<Array<{ desde: string; hasta: string }>>(Prisma.sql`
      SELECT MIN(v."fecha")::text AS desde, MAX(v."fecha")::text AS hasta
      FROM "Venta" v WHERE ${where}
    `),
  ]);

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
    ventasPorDia,
    ventasPorVendedor,
    ventasPorCiudad,
    ventasPorCanal,
    ventasPorMarca,
    topClientes,
    topProductos,
    periodo: { desde: periodoRaw[0]?.desde ?? "", hasta: periodoRaw[0]?.hasta ?? "" },
  };
}
