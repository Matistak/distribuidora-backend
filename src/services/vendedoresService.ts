import { Prisma, PrismaClient } from "@prisma/client";
import { whereClausula } from "./dashboardService.js";
import type { Filtros, VendedorResumen, VendedoresData, VendedoresKpis } from "../lib/types.js";

const toNumber = (value: number | bigint | null | undefined) => Number(value ?? 0);

type FilaVendedor = {
  vendedor: string;
  facturas: number | bigint;
  clientes: number | bigint;
  unidades: number | bigint;
  ventaBruta: number | bigint;
  ventaNeta: number | bigint;
  costo: number | bigint;
  ultimaVenta: string | number | bigint | null;
};

type FilaKpi = {
  vendedoresActivos: number | bigint;
  ventaNeta: number | bigint;
  facturas: number | bigint;
  unidades: number | bigint;
  costoTotal: number | bigint;
};

async function consultarKpis(
  prisma: PrismaClient,
  where: Prisma.Sql,
): Promise<FilaKpi | undefined> {
  const raw = await prisma.$queryRaw<FilaKpi[]>(Prisma.sql`
    SELECT
      CAST(COUNT(DISTINCT COALESCE(v."vendedor", 'SIN DATO')) AS INTEGER) AS "vendedoresActivos",
      CAST(COALESCE(SUM(v."montoVtaNetaGua"), 0) AS REAL)                AS "ventaNeta",
      CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER)                         AS "facturas",
      CAST(COALESCE(SUM(v."vtaUnit"), 0) AS REAL)                         AS "unidades",
      CAST(COALESCE(SUM(v."costoVtaGua"), 0) AS REAL)                     AS "costoTotal"
    FROM "Venta" v
    WHERE ${where}
  `);
  return raw[0];
}

async function consultarRanking(prisma: PrismaClient, where: Prisma.Sql): Promise<FilaVendedor[]> {
  return prisma.$queryRaw<FilaVendedor[]>(Prisma.sql`
    SELECT COALESCE(v."vendedor", 'SIN DATO') AS "vendedor",
           CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER)        AS "facturas",
           CAST(COUNT(DISTINCT v."codCliente") AS INTEGER)     AS "clientes",
           CAST(COALESCE(SUM(v."vtaUnit"), 0) AS REAL)         AS "unidades",
           CAST(COALESCE(SUM(v."montoIvaBrutaGua"), 0) AS REAL) AS "ventaBruta",
           CAST(COALESCE(SUM(v."montoVtaNetaGua"), 0) AS REAL)  AS "ventaNeta",
           CAST(COALESCE(SUM(v."costoVtaGua"), 0) AS REAL)      AS "costo",
           MAX(v."fecha") AS "ultimaVenta"
    FROM "Venta" v
    WHERE ${where}
    GROUP BY COALESCE(v."vendedor", 'SIN DATO')
    ORDER BY "ventaNeta" DESC
  `);
}

function mapearRanking(filas: FilaVendedor[], ventaNetaTotal: number): VendedorResumen[] {
  return filas.map((r) => {
    const neta = toNumber(r.ventaNeta);
    const facturasVendedor = toNumber(r.facturas);
    const costo = toNumber(r.costo);
    const ultimaVenta =
      typeof r.ultimaVenta === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.ultimaVenta)
        ? r.ultimaVenta.slice(0, 10)
        : "";
    return {
      vendedor: r.vendedor,
      facturas: facturasVendedor,
      clientes: toNumber(r.clientes),
      unidades: toNumber(r.unidades),
      ventaBruta: toNumber(r.ventaBruta),
      ventaNeta: neta,
      costo,
      margenPorc: neta ? (neta - costo) / neta : 0,
      participacion: ventaNetaTotal ? neta / ventaNetaTotal : 0,
      ultimaVenta,
    };
  });
}

/**
 * Resumen agregado por vendedor (venta neta, facturas, clientes, unidades,
 * margen y participacion) + KPIs globales del periodo.
 *
 * `filtros` se aplica al detalle (`data`), mientras que `filtrosKpis` (solo
 * fechas por defecto) alimenta los KPIs y el ranking de la cabecera, para que
 * "mejor/peor vendedor" no cambie al filtrar por un vendedor puntual.
 */
export async function obtenerVendedores(
  prisma: PrismaClient,
  desde: string,
  hasta: string,
  filtros: Filtros,
  filtrosKpis?: Filtros,
): Promise<VendedoresData> {
  const where = whereClausula(desde, hasta, filtros);
  const whereKpis = filtrosKpis ? whereClausula(desde, hasta, filtrosKpis) : where;

  const [kpiRow, ranking, rankingKpis] = await Promise.all([
    consultarKpis(prisma, whereKpis),
    consultarRanking(prisma, where),
    consultarRanking(prisma, whereKpis),
  ]);

  const ventaNeta = toNumber(kpiRow?.ventaNeta);
  const facturas = toNumber(kpiRow?.facturas);
  const costoTotal = toNumber(kpiRow?.costoTotal);

  const data = mapearRanking(ranking, ventaNeta);
  const dataKpis = mapearRanking(rankingKpis, ventaNeta);

  const concentracionTop10 = dataKpis
    .slice(0, 10)
    .reduce((acc, r) => acc + r.ventaNeta, 0);

  const kpis: VendedoresKpis = {
    vendedoresActivos: toNumber(kpiRow?.vendedoresActivos),
    ventaNeta,
    facturas,
    unidades: toNumber(kpiRow?.unidades),
    margenPorc: ventaNeta ? (ventaNeta - costoTotal) / ventaNeta : 0,
    concentracionTop10: ventaNeta ? concentracionTop10 / ventaNeta : 0,
  };

  return { kpis, data, dataKpis };
}
