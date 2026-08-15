import { Prisma, PrismaClient } from "@prisma/client";
import { whereClausula } from "./dashboardService.js";
import type { ClienteResumen, ClientesData, ClientesKpis, Filtros } from "../lib/types.js";

const toNumber = (value: number | bigint | null | undefined) => Number(value ?? 0);

/** Etiqueta del cliente en SQL: "RUC - Razon Social" (o solo la razon social). */
const ETIQUETA_CLIENTE = Prisma.sql`COALESCE(
  CASE WHEN v."ruc" IS NOT NULL AND v."razonSocial" IS NOT NULL
       THEN v."ruc" || ' - ' || v."razonSocial"
       ELSE v."razonSocial" END,
  'SIN DATO'
)`;

type FilaCliente = {
  cliente: string;
  vendedor: string | null;
  ciudad: string | null;
  canal: string | null;
  facturas: number | bigint;
  productos: number | bigint;
  unidades: number | bigint;
  ventaBruta: number | bigint;
  ventaNeta: number | bigint;
  costo: number | bigint;
  ultimaCompra: string | number | bigint | null;
};

type FilaKpi = {
  clientesActivos: number | bigint;
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
      CAST(COUNT(DISTINCT ${ETIQUETA_CLIENTE}) AS INTEGER)          AS "clientesActivos",
      CAST(COALESCE(SUM(v."montoVtaNetaGua"), 0) AS REAL)           AS "ventaNeta",
      CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER)                    AS "facturas",
      CAST(COALESCE(SUM(v."vtaUnit"), 0) AS REAL)                    AS "unidades",
      CAST(COALESCE(SUM(v."costoVtaGua"), 0) AS REAL)                AS "costoTotal"
    FROM "Venta" v
    WHERE ${where}
  `);
  return raw[0];
}

async function consultarRanking(prisma: PrismaClient, where: Prisma.Sql): Promise<FilaCliente[]> {
  return prisma.$queryRaw<FilaCliente[]>(Prisma.sql`
    SELECT ${ETIQUETA_CLIENTE} AS "cliente",
           MAX(v."vendedor")                                    AS "vendedor",
           MAX(v."ciudad")                                      AS "ciudad",
           MAX(v."canal")                                       AS "canal",
           CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER)          AS "facturas",
           CAST(COUNT(DISTINCT v."codProducto") AS INTEGER)     AS "productos",
           CAST(COALESCE(SUM(v."vtaUnit"), 0) AS REAL)          AS "unidades",
           CAST(COALESCE(SUM(v."montoIvaBrutaGua"), 0) AS REAL) AS "ventaBruta",
           CAST(COALESCE(SUM(v."montoVtaNetaGua"), 0) AS REAL)  AS "ventaNeta",
           CAST(COALESCE(SUM(v."costoVtaGua"), 0) AS REAL)      AS "costo",
           MAX(v."fecha") AS "ultimaCompra"
    FROM "Venta" v
    WHERE ${where}
    GROUP BY ${ETIQUETA_CLIENTE}
    ORDER BY "ventaNeta" DESC
  `);
}

function mapearRanking(filas: FilaCliente[], ventaNetaTotal: number): ClienteResumen[] {
  return filas.map((r) => {
    const neta = toNumber(r.ventaNeta);
    const facturasCliente = toNumber(r.facturas);
    const costo = toNumber(r.costo);
    const ultimaCompra =
      typeof r.ultimaCompra === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.ultimaCompra)
        ? r.ultimaCompra.slice(0, 10)
        : "";
    return {
      cliente: r.cliente,
      vendedor: r.vendedor ?? "SIN DATO",
      ciudad: r.ciudad ?? "SIN DATO",
      canal: r.canal ?? "SIN DATO",
      facturas: facturasCliente,
      productos: toNumber(r.productos),
      unidades: toNumber(r.unidades),
      ventaBruta: toNumber(r.ventaBruta),
      ventaNeta: neta,
      costo,
      margenPorc: neta ? (neta - costo) / neta : 0,
      participacion: ventaNetaTotal ? neta / ventaNetaTotal : 0,
      ultimaCompra,
    };
  });
}

/**
 * Resumen agregado por cliente (venta neta, facturas, productos, unidades,
 * margen y participacion) + KPIs globales del periodo.
 *
 * `filtros` se aplica al detalle (`data`), mientras que `filtrosKpis` (solo
 * fechas por defecto) alimenta los KPIs y el ranking de la cabecera, para que
 * "mejor/peor cliente" no cambie al filtrar por un cliente puntual.
 */
export async function obtenerClientes(
  prisma: PrismaClient,
  desde: string,
  hasta: string,
  filtros: Filtros,
  filtrosKpis?: Filtros,
): Promise<ClientesData> {
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

  const concentracionTop10 = dataKpis.slice(0, 10).reduce((acc, r) => acc + r.ventaNeta, 0);

  const kpis: ClientesKpis = {
    clientesActivos: toNumber(kpiRow?.clientesActivos),
    ventaNeta,
    facturas,
    unidades: toNumber(kpiRow?.unidades),
    margenPorc: ventaNeta ? (ventaNeta - costoTotal) / ventaNeta : 0,
    concentracionTop10: ventaNeta ? concentracionTop10 / ventaNeta : 0,
  };

  return { kpis, data, dataKpis };
}
