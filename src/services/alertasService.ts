import { Prisma, PrismaClient } from "@prisma/client";
import { whereClausula } from "./dashboardService.js";
import type { Alerta, AlertasData, Filtros } from "../lib/types.js";

type Cliente = PrismaClient | Prisma.TransactionClient;

/** Dias sin comprar a partir de los cuales un cliente se considera inactivo. */
const DIAS_SIN_COMPRAS = 30;

const MESES = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

const toNumber = (value: number | bigint | null | undefined) => Number(value ?? 0);

const pad = (n: number) => String(n).padStart(2, "0");
const armar = (anho: number, mes: number, dia: number) => `${anho}-${pad(mes)}-${pad(dia)}`;
const ultimoDia = (anho: number, mes: number) => new Date(anho, mes, 0).getDate();
const etiquetaMes = (anho: number, mes: number) => `${MESES[mes - 1]} ${anho}`;

const partes = (iso: string) => {
  const [anho, mes, dia] = iso.split("-").map(Number);
  return { anho: anho ?? 0, mes: mes ?? 0, dia: dia ?? 0 };
};

type Tramo = { desde: string; hasta: string };

/**
 * Cuenta las entidades (vendedor, producto…) cuya venta neta del tramo actual
 * cayo o crecio respecto del tramo previo. Solo entran las que vendieron en el
 * tramo previo: sin base de comparacion no hay caida ni crecimiento.
 */
async function contarVariacion(
  prisma: Cliente,
  columna: "vendedor" | "codProducto",
  direccion: "caida" | "crecimiento",
  actual: Tramo,
  previo: Tramo,
  filtros: Filtros,
): Promise<number> {
  const whereGlobal = whereClausula("", "", filtros);
  const campo = Prisma.raw(`v."${columna}"`);
  const comparacion =
    direccion === "caida" ? Prisma.sql`act < prev` : Prisma.sql`act > prev`;

  const rows = await prisma.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`
    SELECT CAST(COUNT(*) AS INTEGER) AS "total"
    FROM (
      SELECT
        ${campo} AS clave,
        CAST(COALESCE(SUM(CASE
          WHEN v."fecha" >= ${actual.desde} AND v."fecha" < date(${actual.hasta}, '+1 day')
          THEN v."montoVtaNetaGua" END), 0) AS REAL) AS act,
        CAST(COALESCE(SUM(CASE
          WHEN v."fecha" >= ${previo.desde} AND v."fecha" < date(${previo.hasta}, '+1 day')
          THEN v."montoVtaNetaGua" END), 0) AS REAL) AS prev
      FROM "Venta" v
      WHERE ${whereGlobal} AND ${campo} IS NOT NULL
      GROUP BY ${campo}
    )
    WHERE prev > 0 AND ${comparacion}
  `);

  return toNumber(rows[0]?.total);
}

/** Clientes con al menos una compra historica y sin comprar desde hace N dias. */
async function contarClientesSinCompras(
  prisma: Cliente,
  referencia: string,
  dias: number,
  filtros: Filtros,
): Promise<number> {
  const whereGlobal = whereClausula("", "", filtros);

  const rows = await prisma.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`
    SELECT CAST(COUNT(*) AS INTEGER) AS "total"
    FROM (
      SELECT v."codCliente" AS cod, MAX(v."fecha") AS ultima
      FROM "Venta" v
      WHERE ${whereGlobal} AND v."codCliente" IS NOT NULL
      GROUP BY v."codCliente"
    )
    WHERE ultima < date(${referencia}, ${`-${dias} day`})
  `);

  return toNumber(rows[0]?.total);
}

const BASE = {
  vendedoresEnCaida: {
    titulo: "Ventas en caída",
    unidad: "vendedores",
    tono: "critico",
  },
  clientesSinCompras: {
    titulo: "Clientes sin compras",
    unidad: "clientes",
    tono: "critico",
  },
  productosEnCaida: {
    titulo: "Productos en caída",
    unidad: "productos",
    tono: "advertencia",
  },
  productosEnCrecimiento: {
    titulo: "Productos en crecimiento",
    unidad: "productos",
    tono: "positivo",
  },
} as const satisfies Record<string, Pick<Alerta, "titulo" | "unidad" | "tono">>;

const CLAVES = Object.keys(BASE) as Array<keyof typeof BASE>;

export async function obtenerAlertas(
  prisma: Cliente,
  filtros: Filtros,
): Promise<AlertasData> {
  const whereGlobal = whereClausula("", "", filtros);

  const limites = await prisma.$queryRaw<Array<{ maxFecha: string | null }>>(Prisma.sql`
    SELECT MAX(v."fecha") AS "maxFecha" FROM "Venta" v WHERE ${whereGlobal}
  `);
  const referencia = limites[0]?.maxFecha?.slice(0, 10) ?? null;

  if (!referencia) {
    return {
      referencia: null,
      alertas: CLAVES.map((clave) => ({
        ...BASE[clave],
        clave,
        valor: null,
        estado: "sin-datos" as const,
        detalle: "sin ventas cargadas",
      })),
    };
  }

  const { anho, mes, dia } = partes(referencia);
  const actual: Tramo = { desde: armar(anho, mes, 1), hasta: referencia };

  const anhoPrevio = mes === 1 ? anho - 1 : anho;
  const mesPrevio = mes === 1 ? 12 : mes - 1;
  const previo: Tramo = {
    desde: armar(anhoPrevio, mesPrevio, 1),
    // Mismo tramo de dias en ambos meses: comparar un mes parcial contra uno
    // completo marcaria caidas que solo son dias que todavia no ocurrieron.
    hasta: armar(anhoPrevio, mesPrevio, Math.min(dia, ultimoDia(anhoPrevio, mesPrevio))),
  };

  const mesParcial = dia < ultimoDia(anho, mes);
  const baseComparacion = mesParcial
    ? `${etiquetaMes(anhoPrevio, mesPrevio)} (1-${dia})`
    : etiquetaMes(anhoPrevio, mesPrevio);
  const detalleMes = `vs. ${baseComparacion}`;

  const [vendedoresEnCaida, productosEnCaida, productosEnCrecimiento, clientesSinCompras] =
    await Promise.all([
      contarVariacion(prisma, "vendedor", "caida", actual, previo, filtros),
      contarVariacion(prisma, "codProducto", "caida", actual, previo, filtros),
      contarVariacion(prisma, "codProducto", "crecimiento", actual, previo, filtros),
      contarClientesSinCompras(prisma, referencia, DIAS_SIN_COMPRAS, filtros),
    ]);

  const valores: Record<(typeof CLAVES)[number], number> = {
    vendedoresEnCaida,
    clientesSinCompras,
    productosEnCaida,
    productosEnCrecimiento,
  };

  const alertas: Alerta[] = CLAVES.map((clave) => ({
    ...BASE[clave],
    clave,
    valor: valores[clave],
    estado: clave === "clientesSinCompras" || !mesParcial ? "ok" : "parcial",
    detalle:
      clave === "clientesSinCompras"
        ? `más de ${DIAS_SIN_COMPRAS} días sin compras`
        : detalleMes,
  }));

  return { referencia, alertas };
}
