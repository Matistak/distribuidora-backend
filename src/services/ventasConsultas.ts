import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { whereClausula } from "./dashboardService.js";
import type { Filtros } from "../lib/types.js";

/**
 * Consultas de ventas de solo lectura para el MCP del chat (Etapa 6).
 *
 * Cada herramienta valida sus argumentos con un schema (zod), ejecuta
 * consultas parametrizadas con Prisma y devuelve texto listo para que el
 * modelo lo explique. Nunca se usa SQL arbitrario: las columnas de ranking
 * estan en una lista fija y los valores vienen parametrizados.
 *
 * Limites aplicados:
 * - Fechas en formato YYYY-MM-DD (regex + fecha valida).
 * - Rango maximo de 10 anios entre `desde` y `hasta`.
 * - Ranking limitado por `limite` (default 10, maximo 50).
 * - Montos redondeados a 2 decimales.
 */

export const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Rango maximo (en dias) entre `desde` y `hasta`. */
const MAX_RANGO_DIAS = 10 * 366;

export function fechaValida(value: string): boolean {
  if (!FECHA_RE.test(value)) return false;
  const [anho, mes, dia] = value.split("-").map(Number);
  const date = new Date(Date.UTC(anho, mes - 1, dia));
  return (
    date.getUTCFullYear() === anho &&
    date.getUTCMonth() === mes - 1 &&
    date.getUTCDate() === dia
  );
}

/** Filtros comunes de todas las herramientas del MCP. */
export const filtrosSchema = z.object({
  /** Fecha de inicio inclusive (YYYY-MM-DD). */
  desde: z.string().optional(),
  /** Fecha de fin inclusive (YYYY-MM-DD). */
  hasta: z.string().optional(),
  vendedor: z.string().optional(),
  canal: z.string().optional(),
  ciudad: z.string().optional(),
  zona: z.string().optional(),
});

export type FiltrosVentas = z.infer<typeof filtrosSchema>;

export class ConsultaVentasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsultaVentasError";
  }
}

/** Valida las fechas y el rango de una consulta; normaliza a "" cuando faltan. */
export function validarRango(filtros: FiltrosVentas): { desde: string; hasta: string } {
  const desde = filtros.desde?.trim() ?? "";
  const hasta = filtros.hasta?.trim() ?? "";

  for (const [nombre, valor] of [
    ["desde", desde],
    ["hasta", hasta],
  ] as const) {
    if (valor && !fechaValida(valor)) {
      throw new ConsultaVentasError(
        `La fecha "${nombre}" debe tener el formato YYYY-MM-DD (por ejemplo 2026-07-01).`,
      );
    }
  }

  if (desde && hasta) {
    const dias =
      (Date.parse(hasta + "T00:00:00Z") - Date.parse(desde + "T00:00:00Z")) /
      86_400_000;
    if (dias < 0) {
      throw new ConsultaVentasError("La fecha \"desde\" debe ser anterior o igual a \"hasta\".");
    }
    if (dias > MAX_RANGO_DIAS) {
      throw new ConsultaVentasError(
        "El rango de fechas es demasiado amplio: el maximo es de 10 anios.",
      );
    }
  }

  return { desde, hasta };
}

/** Convierte los filtros validados al formato que usa `whereClausula`. */
function filtrosWhere(filtros: FiltrosVentas): Filtros {
  return {
    vendedor: filtros.vendedor?.trim() || undefined,
    canal: filtros.canal?.trim() || undefined,
    ciudad: filtros.ciudad?.trim() || undefined,
    zona: filtros.zona?.trim() || undefined,
  };
}

const redondear = (value: number) => Math.round(value * 100) / 100;
const formatear = (value: number) => redondear(value).toLocaleString("es-GT");

interface ResumenFila {
  ventaBruta: number | bigint;
  ventaNeta: number | bigint;
  cantidadFacturas: number | bigint;
  unidadesVendidas: number | bigint;
  clientesActivos: number | bigint;
  productosDistintos: number | bigint;
  costoTotal: number | bigint;
  notasCredito: number | bigint;
  periodoDesde: number | bigint | null;
  periodoHasta: number | bigint | null;
}

const toNumber = (value: number | bigint | null | undefined) => Number(value ?? 0);

/** Resumen agregado de ventas del periodo + filtros (la herramienta principal). */
export async function resumenVentas(
  prisma: PrismaClient,
  filtros: FiltrosVentas,
): Promise<string> {
  const { desde, hasta } = validarRango(filtros);
  const where = whereClausula(desde, hasta, filtrosWhere(filtros));

  const raw = await prisma.$queryRaw<ResumenFila[]>(Prisma.sql`
    SELECT
      CAST(COALESCE(SUM(v."montoIvaBrutaGua"), 0) AS REAL)  AS "ventaBruta",
      CAST(COALESCE(SUM(v."montoVtaNetaGua"), 0) AS REAL)   AS "ventaNeta",
      CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER)           AS "cantidadFacturas",
      CAST(COALESCE(SUM(v."vtaUnit"), 0) AS REAL)           AS "unidadesVendidas",
      CAST(COUNT(DISTINCT v."codCliente") AS INTEGER)       AS "clientesActivos",
      CAST(COUNT(DISTINCT v."codProducto") AS INTEGER)      AS "productosDistintos",
      CAST(COALESCE(SUM(v."costoVtaGua"), 0) AS REAL)       AS "costoTotal",
      CAST(COUNT(DISTINCT CASE WHEN LOWER(v."tipoDoc") LIKE LOWER('%CREDITO%') THEN v."nroDoc" END) AS INTEGER) AS "notasCredito",
      MIN(v."fecha") AS "periodoDesde",
      MAX(v."fecha") AS "periodoHasta"
    FROM "Venta" v
    WHERE ${where}
  `);

  const row = raw[0];
  if (!row || toNumber(row.cantidadFacturas) === 0) {
    return "Sin resultados: no hay ventas que coincidan con el periodo o los filtros indicados.";
  }

  const ventaBruta = toNumber(row.ventaBruta);
  const ventaNeta = toNumber(row.ventaNeta);
  const cantidadFacturas = toNumber(row.cantidadFacturas);
  const costoTotal = toNumber(row.costoTotal);
  const margenPorc = ventaNeta ? (ventaNeta - costoTotal) / ventaNeta : 0;

  const lineas = [
    "Resumen de ventas",
    `- Venta bruta: ${formatear(ventaBruta)}`,
    `- Venta neta: ${formatear(ventaNeta)}`,
    `- Facturas: ${cantidadFacturas.toLocaleString("es-GT")}`,
    `- Unidades vendidas: ${toNumber(row.unidadesVendidas).toLocaleString("es-GT")}`,
    `- Clientes activos: ${toNumber(row.clientesActivos).toLocaleString("es-GT")}`,
    `- Productos distintos: ${toNumber(row.productosDistintos).toLocaleString("es-GT")}`,
    `- Notas de credito: ${toNumber(row.notasCredito).toLocaleString("es-GT")}`,
    `- Ticket promedio: ${formatear(ventaNeta / cantidadFacturas)}`,
    `- Margen: ${redondear(margenPorc * 100).toLocaleString("es-GT")}%`,
  ];
  if (row.periodoDesde && row.periodoHasta) {
    lineas.push(
      `- Periodo con datos: ${new Date(toNumber(row.periodoDesde)).toISOString().slice(0, 10)} al ${new Date(toNumber(row.periodoHasta)).toISOString().slice(0, 10)}`,
    );
  }
  return lineas.join("\n");
}

const GRANULARIDAD = ["dia", "mes", "anho"] as const;

/** Serie de venta neta por dia (1-31), mes (YYYY-MM) o anio (YYYY). */
export async function ventasPorPeriodo(
  prisma: PrismaClient,
  filtros: FiltrosVentas & { granularidad?: string },
): Promise<string> {
  const { desde, hasta } = validarRango(filtros);
  const granularidad = (filtros.granularidad ?? "mes").trim();
  if (!GRANULARIDAD.includes(granularidad as (typeof GRANULARIDAD)[number])) {
    throw new ConsultaVentasError(
      `La granularidad "${granularidad}" no es valida: use "dia", "mes" o "anho".`,
    );
  }

  const where = whereClausula(desde, hasta, filtrosWhere(filtros));
  const exp = (column: string, cast: string, orden: string) => Prisma.sql`
    SELECT CAST(${Prisma.raw(column)} AS TEXT) AS "label",
           CAST(SUM(v."montoVtaNetaGua") AS ${Prisma.raw(cast)}) AS "valor",
           CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER) AS "facturas"
    FROM "Venta" v WHERE ${where}
    GROUP BY ${Prisma.raw(column)} ORDER BY ${Prisma.raw(orden)} ASC
  `;

  const filas = await (granularidad === "dia"
    ? prisma.$queryRaw<Array<{ label: string; valor: number | bigint; facturas: number | bigint }>>(exp(`v."dia"`, "REAL", `v."dia"`))
    : granularidad === "anho"
      ? prisma.$queryRaw<Array<{ label: string; valor: number | bigint; facturas: number | bigint }>>(exp(`v."anho"`, "REAL", `v."anho"`))
      : prisma.$queryRaw<Array<{ label: string; valor: number | bigint; facturas: number | bigint }>>(exp(`v."anhoMes"`, "REAL", `v."anhoMes"`)));

  if (filas.length === 0) {
    return "Sin resultados: no hay ventas que coincidan con el periodo o los filtros indicados.";
  }

  const lineas = ["Ventas por periodo (venta neta):"];
  for (const fila of filas) {
    const label =
      granularidad === "mes" && /^\d{6}$/.test(fila.label)
        ? `${fila.label.slice(0, 4)}-${fila.label.slice(4)}`
        : fila.label;
    lineas.push(`- ${label}: ${formatear(toNumber(fila.valor))} (${toNumber(fila.facturas).toLocaleString("es-GT")} facturas)`);
  }
  return lineas.join("\n");
}

/** Columnas permitidas para rankings: lista fija, nunca SQL arbitrario. */
const COLUMNAS_RANKING = {
  vendedor: "vendedor",
  ciudad: "ciudad",
  producto: "producto",
  canal: "canal",
  marca: "marca",
  cliente: "razonSocial",
} as const;

export type RankingPor = keyof typeof COLUMNAS_RANKING;

export function validarRanking(por: string): RankingPor {
  const key = por?.trim() as RankingPor;
  if (!(key in COLUMNAS_RANKING)) {
    throw new ConsultaVentasError(
      `El campo "${por}" no se puede usar para agrupar: use ${Object.keys(COLUMNAS_RANKING).join(", ")}.`,
    );
  }
  return key;
}

/** Ranking de venta neta por una dimension fija (vendedor, ciudad, producto, ...). */
export async function rankingVentas(
  prisma: PrismaClient,
  por: RankingPor,
  filtros: FiltrosVentas & { limite?: number },
): Promise<string> {
  const { desde, hasta } = validarRango(filtros);
  const limite = Math.min(Math.max(Math.trunc(filtros.limite ?? 10), 1), 50);
  const columna = COLUMNAS_RANKING[por];
  const where = whereClausula(desde, hasta, filtrosWhere(filtros));

  const totalRaw = await prisma.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`
    SELECT CAST(COALESCE(SUM(v."montoVtaNetaGua"), 0) AS REAL) AS "total"
    FROM "Venta" v WHERE ${where}
  `);
  const total = toNumber(totalRaw[0]?.total);

  const filas = await prisma.$queryRaw<
    Array<{ nombre: string; valor: number | bigint; facturas: number | bigint }>
  >(Prisma.sql`
    SELECT v.${Prisma.raw(columna)} AS "nombre",
           CAST(SUM(v."montoVtaNetaGua") AS REAL) AS "valor",
           CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER) AS "facturas"
    FROM "Venta" v WHERE ${where}
    GROUP BY v.${Prisma.raw(columna)}
    ORDER BY "valor" DESC
    LIMIT ${limite}
  `);

  if (filas.length === 0) {
    return "Sin resultados: no hay ventas que coincidan con el periodo o los filtros indicados.";
  }

  const lineas = [`Ranking por ${por} (venta neta):`];
  filas.forEach((fila, index) => {
    const participacion = total ? (toNumber(fila.valor) / total) * 100 : 0;
    lineas.push(
      `${index + 1}. ${fila.nombre}: ${formatear(toNumber(fila.valor))} (${redondear(participacion).toLocaleString("es-GT")}%, ${toNumber(fila.facturas).toLocaleString("es-GT")} facturas)`,
    );
  });
  return lineas.join("\n");
}

export interface PeriodosComparacion {
  periodo1Desde: string;
  periodo1Hasta: string;
  periodo2Desde: string;
  periodo2Hasta: string;
}

/** Compara la venta neta y las facturas de dos periodos. */
export async function compararPeriodos(
  prisma: PrismaClient,
  input: FiltrosVentas & PeriodosComparacion,
): Promise<string> {
  const resumen1 = await resumenVentas(prisma, {
    ...input,
    desde: input.periodo1Desde,
    hasta: input.periodo1Hasta,
  });
  const resumen2 = await resumenVentas(prisma, {
    ...input,
    desde: input.periodo2Desde,
    hasta: input.periodo2Hasta,
  });

  const lineas = [
    `Periodo 1 (${input.periodo1Desde} al ${input.periodo1Hasta}):`,
    ...resumen1.split("\n").map((linea) => `  ${linea}`),
    "",
    `Periodo 2 (${input.periodo2Desde} al ${input.periodo2Hasta}):`,
    ...resumen2.split("\n").map((linea) => `  ${linea}`),
  ];

  const neta1 = extraerNeta(resumen1);
  const neta2 = extraerNeta(resumen2);
  if (neta1 !== null && neta2 !== null) {
    const variacion = neta1 !== 0 ? ((neta2 - neta1) / Math.abs(neta1)) * 100 : null;
    lineas.push(
      "",
      variacion === null
        ? "Variacion: no se puede calcular (periodo 1 sin ventas)."
        : `Variacion de venta neta del periodo 1 al 2: ${redondear(variacion).toLocaleString("es-GT")}%`,
    );
  }
  return lineas.join("\n");
}

/** Extrae la venta neta del texto generado por `resumenVentas` (formato "es-GT"). */
function extraerNeta(resumen: string): number | null {
  const match = resumen.match(/^\- Venta neta: (.+)$/m);
  if (!match) return null;
  const parsed = Number(String(match[1]).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
