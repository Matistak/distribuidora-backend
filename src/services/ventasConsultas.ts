import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { whereClausula } from "./dashboardService.js";
import { esClaveAlerta, obtenerAlertas, obtenerDetalleAlerta } from "./alertasService.js";
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
  cliente: z.string().optional(),
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
        "El rango de fechas es demasiado amplio: el maximo es de 10 anios. " +
          "Si querias consultar toda la historia cargada, omiti \"desde\" y \"hasta\".",
      );
    }
  }

  return { desde, hasta };
}

/** Convierte los filtros validados al formato que usa `whereClausula`. */
function filtrosWhere(filtros: FiltrosVentas): Filtros {
  return {
    cliente: filtros.cliente?.trim() || undefined,
    vendedor: filtros.vendedor?.trim() || undefined,
    canal: filtros.canal?.trim() || undefined,
    ciudad: filtros.ciudad?.trim() || undefined,
    zona: filtros.zona?.trim() || undefined,
  };
}

/** Locale de salida: Paraguay (miles con punto, decimales con coma). */
const LOCALE = "es-PY";

const redondear = (value: number) => Math.round(value * 100) / 100;

/**
 * Montos: el guarani no tiene subunidad en circulacion, asi que se muestran
 * enteros. Los porcentajes si conservan dos decimales (usan `redondear`).
 */
const formatear = (value: number) =>
  Math.round(value).toLocaleString(LOCALE, { maximumFractionDigits: 0 });

interface ResumenFila {
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
}

const toNumber = (value: number | bigint | null | undefined) => Number(value ?? 0);
const toIsoDate = (value: string | number | bigint) => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  return new Date(Number(value)).toISOString().slice(0, 10);
};

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
    `- Facturas: ${cantidadFacturas.toLocaleString(LOCALE)}`,
    `- Unidades vendidas: ${toNumber(row.unidadesVendidas).toLocaleString(LOCALE)}`,
    `- Clientes activos: ${toNumber(row.clientesActivos).toLocaleString(LOCALE)}`,
    `- Productos distintos: ${toNumber(row.productosDistintos).toLocaleString(LOCALE)}`,
    `- Notas de credito: ${toNumber(row.notasCredito).toLocaleString(LOCALE)}`,
    `- Ticket promedio: ${formatear(ventaNeta / cantidadFacturas)}`,
    `- Margen: ${redondear(margenPorc * 100).toLocaleString(LOCALE)}%`,
  ];
  if (row.periodoDesde && row.periodoHasta) {
    lineas.push(
      `- Periodo con datos: ${toIsoDate(row.periodoDesde)} al ${toIsoDate(row.periodoHasta)}`,
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
  const sinMes = granularidad === "mes" ? Prisma.sql` AND v."anhoMes" IS NOT NULL` : Prisma.sql``;
  const exp = (column: string, cast: string, orden: string) => Prisma.sql`
    SELECT CAST(${Prisma.raw(column)} AS TEXT) AS "label",
           CAST(SUM(v."montoVtaNetaGua") AS ${Prisma.raw(cast)}) AS "valor",
           CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER) AS "facturas"
    FROM "Venta" v WHERE ${where}${sinMes}
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
    lineas.push(`- ${label}: ${formatear(toNumber(fila.valor))} (${toNumber(fila.facturas).toLocaleString(LOCALE)} facturas)`);
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

/** Dimensiones validas para `ranking_ventas`; alimenta el enum del inputSchema. */
export const RANKING_DIMENSIONES = Object.keys(COLUMNAS_RANKING) as RankingPor[];

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
    SELECT COALESCE(v.${Prisma.raw(columna)}, 'SIN DATO') AS "nombre",
           CAST(SUM(v."montoVtaNetaGua") AS REAL) AS "valor",
           CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER) AS "facturas"
    FROM "Venta" v WHERE ${where}
    GROUP BY COALESCE(v.${Prisma.raw(columna)}, 'SIN DATO')
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
      `${index + 1}. ${fila.nombre}: ${formatear(toNumber(fila.valor))} (${redondear(participacion).toLocaleString(LOCALE)}%, ${toNumber(fila.facturas).toLocaleString(LOCALE)} facturas)`,
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
        : `Variacion de venta neta del periodo 1 al 2: ${redondear(variacion).toLocaleString(LOCALE)}%`,
    );
  }
  return lineas.join("\n");
}

/**
 * Expresiones SQL de los catalogos consultables: lista fija, nunca SQL
 * arbitrario. `cliente` usa la misma etiqueta "RUC - Razon social" que el
 * front, para que el valor devuelto sirva tal cual como filtro.
 */
const CATALOGOS = {
  cliente: `CASE WHEN v."ruc" IS NOT NULL THEN v."ruc" || ' - ' || v."razonSocial" ELSE v."razonSocial" END`,
  vendedor: `v."vendedor"`,
  canal: `v."canal"`,
  ciudad: `v."ciudad"`,
  zona: `v."zona"`,
  marca: `v."marca"`,
  producto: `v."producto"`,
} as const;

export type CatalogoFiltro = keyof typeof CATALOGOS;

export const CATALOGOS_FILTRO = Object.keys(CATALOGOS) as CatalogoFiltro[];

export function validarCatalogo(tipo: string): CatalogoFiltro {
  const key = tipo?.trim() as CatalogoFiltro;
  if (!(key in CATALOGOS)) {
    throw new ConsultaVentasError(
      `El catalogo "${tipo}" no existe: use ${CATALOGOS_FILTRO.join(", ")}.`,
    );
  }
  return key;
}

/**
 * Valores reales que puede tomar un filtro, para que el modelo no adivine
 * nombres: `vendedor`, `canal`, `ciudad` y `zona` se comparan por igualdad
 * exacta, asi que un nombre aproximado devuelve "sin resultados".
 */
export async function valoresFiltro(
  prisma: PrismaClient,
  input: { tipo: string; q?: string; limite?: number },
): Promise<string> {
  const tipo = validarCatalogo(input.tipo);
  const limite = Math.min(Math.max(Math.trunc(input.limite ?? 25), 1), 200);
  const q = input.q?.trim() ?? "";
  const expresion = Prisma.raw(CATALOGOS[tipo]);
  const filtroTexto = q
    ? Prisma.sql` AND ${expresion} LIKE ${`%${q}%`}`
    : Prisma.sql``;

  // Se pide una fila extra para saber si la lista quedo truncada.
  const filas = await prisma.$queryRaw<Array<{ valor: string }>>(Prisma.sql`
    SELECT DISTINCT ${expresion} AS "valor"
    FROM "Venta" v
    WHERE ${expresion} IS NOT NULL${filtroTexto}
    ORDER BY "valor" ASC
    LIMIT ${limite + 1}
  `);

  if (filas.length === 0) {
    return q
      ? `Sin resultados: ningun valor de "${tipo}" contiene "${q}".`
      : `Sin resultados: no hay valores cargados para "${tipo}".`;
  }

  const truncado = filas.length > limite;
  const visibles = truncado ? filas.slice(0, limite) : filas;
  const lineas = [
    `Valores de "${tipo}"${q ? ` que contienen "${q}"` : ""} (${visibles.length}${truncado ? "+" : ""}):`,
    ...visibles.map((fila) => `- ${fila.valor}`),
  ];
  if (truncado) {
    lineas.push(`(hay mas de ${limite}; acota con "q" o subi "limite" hasta 200)`);
  }
  return lineas.join("\n");
}

/** Tablero de alertas del mes vigente (mismos numeros que el dashboard). */
export async function alertasVentas(
  prisma: PrismaClient,
  filtros: FiltrosVentas,
): Promise<string> {
  const { referencia, alertas } = await obtenerAlertas(prisma, filtrosWhere(filtros));

  if (!referencia) {
    return "Sin resultados: no hay ventas cargadas para calcular alertas.";
  }

  const lineas = [`Alertas al ${referencia} (ultimo dia con ventas):`];
  for (const alerta of alertas) {
    const valor = alerta.valor === null ? "sin datos" : alerta.valor.toLocaleString(LOCALE);
    lineas.push(
      `- ${alerta.titulo} [${alerta.clave}]: ${valor} ${alerta.unidad} (${alerta.detalle})`,
    );
  }
  lineas.push(
    "",
    'Para ver "cuales son", use detalle_alerta con la clave entre corchetes.',
  );
  return lineas.join("\n");
}

/** Formatea un valor de `FilaDetalle` segun el tipo declarado por la columna. */
function valorDetalle(valor: string | number | null, tipo: string): string {
  if (valor === null) return "-";
  if (typeof valor === "number") {
    // `alertasService` ya entrega los porcentajes en unidades de 0-100.
    return tipo === "porcentaje" ? `${redondear(valor).toLocaleString(LOCALE)}%` : formatear(valor);
  }
  return valor;
}

/** Filas que explican una alerta (el "cuales son" detras del numero). */
export async function detalleAlertaVentas(
  prisma: PrismaClient,
  input: FiltrosVentas & { alerta: string; limite?: number },
): Promise<string> {
  const clave = input.alerta?.trim() ?? "";
  if (!esClaveAlerta(clave)) {
    throw new ConsultaVentasError(
      `La alerta "${clave}" no existe: use vendedoresEnCaida, clientesSinCompras, productosEnCaida o productosEnCrecimiento.`,
    );
  }

  const limite = Math.min(Math.max(Math.trunc(input.limite ?? 10), 1), 50);
  const detalle = await obtenerDetalleAlerta(prisma, clave, filtrosWhere(input));

  if (detalle.filas.length === 0) {
    return `Sin resultados: no hay filas para la alerta "${clave}".`;
  }

  const visibles = detalle.filas.slice(0, limite);
  const lineas = [
    `${detalle.titulo} — ${detalle.detalle}`,
    `Mostrando ${visibles.length} de ${detalle.total.toLocaleString(LOCALE)}:`,
  ];
  visibles.forEach((fila, index) => {
    const campos = detalle.columnas
      .map((columna) => `${columna.titulo}: ${valorDetalle(fila[columna.clave] ?? null, columna.tipo)}`)
      .join(" | ");
    lineas.push(`${index + 1}. ${campos}`);
  });
  return lineas.join("\n");
}

/** Extrae la venta neta del texto generado por `resumenVentas` (formato es-PY: miles con punto, decimales con coma). */
function extraerNeta(resumen: string): number | null {
  const match = resumen.match(/^\- Venta neta: (.+)$/m);
  if (!match) return null;
  // En es-PY el punto separa miles y la coma los decimales: hay que sacar los
  // puntos antes de parsear, o "3.735.843.530,27" quedaria en NaN.
  const normalizado = String(match[1]).replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalizado.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
