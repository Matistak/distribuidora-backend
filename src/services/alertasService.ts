import { Prisma, PrismaClient } from "@prisma/client";
import { whereClausula } from "./dashboardService.js";
import type {
  Alerta,
  AlertasData,
  ColumnaDetalle,
  DetalleAlerta,
  FilaDetalle,
  Filtros,
} from "../lib/types.js";

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

/** Ultimo dia con ventas dentro de los filtros; null si no hay datos. */
async function fechaReferencia(prisma: Cliente, filtros: Filtros): Promise<string | null> {
  const whereGlobal = whereClausula("", "", filtros);
  const limites = await prisma.$queryRaw<Array<{ maxFecha: string | null }>>(Prisma.sql`
    SELECT MAX(v."fecha") AS "maxFecha" FROM "Venta" v WHERE ${whereGlobal}
  `);
  return limites[0]?.maxFecha?.slice(0, 10) ?? null;
}

type Ventana = {
  actual: Tramo;
  previo: Tramo;
  mesParcial: boolean;
  /** Texto al pie: "vs. jul 2026 (1-11)". */
  detalleMes: string;
};

/** Mes vigente de la referencia y el mismo tramo de dias del mes anterior. */
function ventana(referencia: string): Ventana {
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

  return { actual, previo, mesParcial, detalleMes: `vs. ${baseComparacion}` };
}

export async function obtenerAlertas(
  prisma: Cliente,
  filtros: Filtros,
): Promise<AlertasData> {
  const referencia = await fechaReferencia(prisma, filtros);

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

  const { actual, previo, mesParcial, detalleMes } = ventana(referencia);

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

/** Tope de filas devueltas al modal; `total` informa cuantas cumplen la condicion. */
const LIMITE_DETALLE = 300;

const COLUMNAS_VARIACION: ColumnaDetalle[] = [
  { clave: "nombre", titulo: "Nombre", tipo: "texto" },
  { clave: "actual", titulo: "Mes vigente", tipo: "moneda" },
  { clave: "previo", titulo: "Mes anterior", tipo: "moneda" },
  { clave: "diferencia", titulo: "Diferencia", tipo: "moneda" },
  { clave: "variacion", titulo: "Variación", tipo: "porcentaje" },
  { clave: "unidades", titulo: "Unidades", tipo: "numero" },
  { clave: "clientes", titulo: "Clientes", tipo: "numero" },
  { clave: "ultimaVenta", titulo: "Última venta", tipo: "fecha" },
];

type FilaVariacion = {
  nombre: string | null;
  actual: number | null;
  previo: number | null;
  unidades: number | null;
  clientes: number | bigint | null;
  ultimaVenta: string | null;
};

/**
 * Las entidades detras del contador: que vendieron antes y ahora, cuanto
 * cambiaron y con que actividad (unidades, clientes, ultima venta).
 */
async function detalleVariacion(
  prisma: Cliente,
  columna: "vendedor" | "codProducto",
  direccion: "caida" | "crecimiento",
  actual: Tramo,
  previo: Tramo,
  filtros: Filtros,
): Promise<{ filas: FilaDetalle[]; total: number }> {
  const whereGlobal = whereClausula("", "", filtros);
  const campo = Prisma.raw(`v."${columna}"`);
  // Los productos se agrupan por codigo, pero se muestran por nombre.
  const nombre =
    columna === "vendedor"
      ? Prisma.sql`v."vendedor"`
      : Prisma.sql`COALESCE(MAX(v."producto"), 'Cód. ' || v."codProducto")`;
  const comparacion =
    direccion === "caida" ? Prisma.sql`"actual" < "previo"` : Prisma.sql`"actual" > "previo"`;
  // Caida: primero la peor (diferencia mas negativa). Crecimiento: la mayor.
  const orden = direccion === "caida" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const enActual = Prisma.sql`v."fecha" >= ${actual.desde} AND v."fecha" < date(${actual.hasta}, '+1 day')`;
  const enPrevio = Prisma.sql`v."fecha" >= ${previo.desde} AND v."fecha" < date(${previo.hasta}, '+1 day')`;

  const rows = await prisma.$queryRaw<FilaVariacion[]>(Prisma.sql`
    SELECT * FROM (
      SELECT
        ${nombre} AS "nombre",
        CAST(COALESCE(SUM(CASE WHEN ${enActual} THEN v."montoVtaNetaGua" END), 0) AS REAL) AS "actual",
        CAST(COALESCE(SUM(CASE WHEN ${enPrevio} THEN v."montoVtaNetaGua" END), 0) AS REAL) AS "previo",
        CAST(COALESCE(SUM(CASE WHEN ${enActual} THEN v."vtaUnit" END), 0) AS REAL) AS "unidades",
        COUNT(DISTINCT CASE WHEN ${enActual} THEN v."codCliente" END) AS "clientes",
        MAX(CASE WHEN ${enActual} THEN v."fecha" END) AS "ultimaVenta"
      FROM "Venta" v
      WHERE ${whereGlobal} AND ${campo} IS NOT NULL
      GROUP BY ${campo}
    )
    WHERE "previo" > 0 AND ${comparacion}
    ORDER BY ("actual" - "previo") ${orden}
    LIMIT ${LIMITE_DETALLE + 1}
  `);

  const total = await contarVariacion(prisma, columna, direccion, actual, previo, filtros);

  const filas: FilaDetalle[] = rows.slice(0, LIMITE_DETALLE).map((r) => {
    const act = toNumber(r.actual);
    const prev = toNumber(r.previo);
    return {
      nombre: r.nombre ?? "—",
      actual: act,
      previo: prev,
      diferencia: act - prev,
      variacion: prev > 0 ? ((act - prev) / prev) * 100 : null,
      unidades: toNumber(r.unidades),
      clientes: toNumber(r.clientes),
      ultimaVenta: r.ultimaVenta?.slice(0, 10) ?? null,
    };
  });

  return { filas, total };
}

const COLUMNAS_CLIENTES: ColumnaDetalle[] = [
  { clave: "nombre", titulo: "Cliente", tipo: "texto" },
  { clave: "ruc", titulo: "RUC", tipo: "texto" },
  { clave: "diasSinComprar", titulo: "Días sin comprar", tipo: "numero" },
  { clave: "ultimaCompra", titulo: "Última compra", tipo: "fecha" },
  { clave: "montoUltimoAnho", titulo: "Comprado (últ. 12 meses)", tipo: "moneda" },
  { clave: "compras", titulo: "Facturas (histórico)", tipo: "numero" },
  { clave: "vendedor", titulo: "Vendedor", tipo: "texto" },
  { clave: "ciudad", titulo: "Ciudad", tipo: "texto" },
];

type FilaCliente = {
  nombre: string | null;
  ruc: string | null;
  diasSinComprar: number | null;
  ultimaCompra: string | null;
  montoUltimoAnho: number | null;
  compras: number | bigint | null;
  vendedor: string | null;
  ciudad: string | null;
};

/** Clientes inactivos con su ultima compra, su volumen reciente y quien los atiende. */
async function detalleClientesSinCompras(
  prisma: Cliente,
  referencia: string,
  dias: number,
  filtros: Filtros,
): Promise<{ filas: FilaDetalle[]; total: number }> {
  const whereGlobal = whereClausula("", "", filtros);
  const corte = Prisma.sql`date(${referencia}, ${`-${dias} day`})`;
  const desdeAnho = Prisma.sql`date(${referencia}, '-1 year')`;

  const rows = await prisma.$queryRaw<FilaCliente[]>(Prisma.sql`
    SELECT * FROM (
      SELECT
        COALESCE(MAX(v."razonSocial"), 'Cód. ' || v."codCliente") AS "nombre",
        MAX(v."ruc") AS "ruc",
        MAX(v."fecha") AS "ultimaCompra",
        CAST(julianday(${referencia}) - julianday(MAX(v."fecha")) AS INTEGER) AS "diasSinComprar",
        CAST(COALESCE(SUM(CASE WHEN v."fecha" >= ${desdeAnho} THEN v."montoVtaNetaGua" END), 0) AS REAL)
          AS "montoUltimoAnho",
        COUNT(DISTINCT v."nroDoc") AS "compras",
        MAX(v."vendedor") AS "vendedor",
        MAX(v."ciudad") AS "ciudad"
      FROM "Venta" v
      WHERE ${whereGlobal} AND v."codCliente" IS NOT NULL
      GROUP BY v."codCliente"
    )
    WHERE "ultimaCompra" < ${corte}
    ORDER BY "montoUltimoAnho" DESC, "diasSinComprar" DESC
    LIMIT ${LIMITE_DETALLE + 1}
  `);

  const total = await contarClientesSinCompras(prisma, referencia, dias, filtros);

  const filas: FilaDetalle[] = rows.slice(0, LIMITE_DETALLE).map((r) => ({
    nombre: r.nombre ?? "—",
    ruc: r.ruc,
    diasSinComprar: toNumber(r.diasSinComprar),
    ultimaCompra: r.ultimaCompra?.slice(0, 10) ?? null,
    montoUltimoAnho: toNumber(r.montoUltimoAnho),
    compras: toNumber(r.compras),
    vendedor: r.vendedor,
    ciudad: r.ciudad,
  }));

  return { filas, total };
}

export function esClaveAlerta(clave: string): clave is (typeof CLAVES)[number] {
  return (CLAVES as string[]).includes(clave);
}

/** Filas que explican una alerta, con las mismas ventanas y filtros del contador. */
export async function obtenerDetalleAlerta(
  prisma: Cliente,
  clave: (typeof CLAVES)[number],
  filtros: Filtros,
): Promise<DetalleAlerta> {
  const referencia = await fechaReferencia(prisma, filtros);
  const vacio: DetalleAlerta = {
    clave,
    titulo: BASE[clave].titulo,
    detalle: "sin ventas cargadas",
    columnas: clave === "clientesSinCompras" ? COLUMNAS_CLIENTES : COLUMNAS_VARIACION,
    filas: [],
    total: 0,
  };
  if (!referencia) return vacio;

  const { actual, previo, detalleMes } = ventana(referencia);

  if (clave === "clientesSinCompras") {
    const { filas, total } = await detalleClientesSinCompras(
      prisma,
      referencia,
      DIAS_SIN_COMPRAS,
      filtros,
    );
    return {
      ...vacio,
      detalle: `más de ${DIAS_SIN_COMPRAS} días sin compras · al ${referencia}`,
      filas,
      total,
    };
  }

  const columna = clave === "vendedoresEnCaida" ? "vendedor" : "codProducto";
  const direccion = clave === "productosEnCrecimiento" ? "crecimiento" : "caida";
  const { filas, total } = await detalleVariacion(
    prisma,
    columna,
    direccion,
    actual,
    previo,
    filtros,
  );

  return {
    ...vacio,
    columnas:
      clave === "vendedoresEnCaida"
        ? COLUMNAS_VARIACION.map((c) => (c.clave === "nombre" ? { ...c, titulo: "Vendedor" } : c))
        : COLUMNAS_VARIACION.map((c) => (c.clave === "nombre" ? { ...c, titulo: "Producto" } : c)),
    detalle: detalleMes,
    filas,
    total,
  };
}
