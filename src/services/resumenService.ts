import { Prisma, PrismaClient } from "@prisma/client";
import { whereClausula } from "./dashboardService.js";
import type {
  Comparativo,
  Filtros,
  ResumenData,
  ResumenKpi,
} from "../lib/types.js";

type Cliente = PrismaClient | Prisma.TransactionClient;

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

const partes = (iso: string) => {
  const [anho, mes, dia] = iso.split("-").map(Number);
  return { anho: anho ?? 0, mes: mes ?? 0, dia: dia ?? 0 };
};

const pad = (n: number) => String(n).padStart(2, "0");
const armar = (anho: number, mes: number, dia: number) =>
  `${anho}-${pad(mes)}-${pad(dia)}`;

const ultimoDia = (anho: number, mes: number) => new Date(anho, mes, 0).getDate();

const etiquetaDia = (iso: string) => {
  const { anho, mes, dia } = partes(iso);
  return `${pad(dia)}/${pad(mes)}/${anho}`;
};

const etiquetaMes = (anho: number, mes: number) => `${MESES[mes - 1]} ${anho}`;

type Agregado = {
  ventaNeta: number;
  costo: number;
  facturas: number;
  unidades: number;
  clientes: number;
  filas: number;
};

const VACIO: Agregado = {
  ventaNeta: 0,
  costo: 0,
  facturas: 0,
  unidades: 0,
  clientes: 0,
  filas: 0,
};

async function agregar(
  prisma: Cliente,
  desde: string,
  hasta: string,
  filtros: Filtros,
): Promise<Agregado> {
  const where = whereClausula(desde, hasta, filtros);

  const rows = await prisma.$queryRaw<
    Array<{
      ventaNeta: number | bigint;
      costo: number | bigint;
      facturas: number | bigint;
      unidades: number | bigint;
      clientes: number | bigint;
      filas: number | bigint;
    }>
  >(Prisma.sql`
    SELECT
      CAST(COALESCE(SUM(v."montoVtaNetaGua"), 0) AS REAL) AS "ventaNeta",
      CAST(COALESCE(SUM(v."costoVtaGua"), 0) AS REAL)     AS "costo",
      CAST(COUNT(DISTINCT v."nroDoc") AS INTEGER)          AS "facturas",
      CAST(COALESCE(SUM(v."vtaUnit"), 0) AS REAL)          AS "unidades",
      CAST(COUNT(DISTINCT v."codCliente") AS INTEGER)      AS "clientes",
      CAST(COUNT(*) AS INTEGER)                            AS "filas"
    FROM "Venta" v
    WHERE ${where}
  `);

  const row = rows[0];
  if (!row) return VACIO;

  return {
    ventaNeta: toNumber(row.ventaNeta),
    costo: toNumber(row.costo),
    facturas: toNumber(row.facturas),
    unidades: toNumber(row.unidades),
    clientes: toNumber(row.clientes),
    filas: toNumber(row.filas),
  };
}

async function clientesNuevos(
  prisma: Cliente,
  desde: string,
  hasta: string,
  filtros: Filtros,
): Promise<number> {
  const whereGlobal = whereClausula("", "", filtros);

  const rows = await prisma.$queryRaw<Array<{ nuevos: number | bigint }>>(Prisma.sql`
    SELECT CAST(COUNT(*) AS INTEGER) AS "nuevos"
    FROM (
      SELECT v."codCliente" AS cod, MIN(v."fecha") AS primera
      FROM "Venta" v
      WHERE ${whereGlobal} AND v."codCliente" IS NOT NULL
      GROUP BY v."codCliente"
    )
    WHERE primera >= ${desde} AND primera < date(${hasta}, '+1 day')
  `);

  return toNumber(rows[0]?.nuevos);
}

const noDisponible = (motivo: string): Comparativo => ({
  tipo: "no-disponible",
  motivo,
});

function delta(
  actual: number,
  base: number,
  hayDatosBase: boolean,
  etiquetaBase: string,
): Comparativo {
  if (!hayDatosBase) return noDisponible(`sin datos de ${etiquetaBase}`);
  if (base === 0) return noDisponible(`${etiquetaBase} sin ventas`);

  return {
    tipo: "delta",
    unidad: "pct",
    pct: (actual - base) / base,
    valorBase: base,
    base: etiquetaBase,
  };
}

function deltaPuntos(
  actual: number,
  base: number,
  hayDatosBase: boolean,
  etiquetaBase: string,
): Comparativo {
  if (!hayDatosBase) return noDisponible(`sin datos de ${etiquetaBase}`);

  return {
    tipo: "delta",
    unidad: "pp",
    pct: actual - base,
    valorBase: base,
    base: etiquetaBase,
  };
}

const margen = (a: Agregado) => (a.ventaNeta ? (a.ventaNeta - a.costo) / a.ventaNeta : 0);
const ticket = (a: Agregado) => (a.facturas ? a.ventaNeta / a.facturas : 0);

export async function obtenerResumen(
  prisma: Cliente,
  filtros: Filtros,
): Promise<ResumenData> {
  const whereGlobal = whereClausula("", "", filtros);

  const limites = await prisma.$queryRaw<
    Array<{ minFecha: string | null; maxFecha: string | null }>
  >(Prisma.sql`
    SELECT MIN(v."fecha") AS "minFecha", MAX(v."fecha") AS "maxFecha"
    FROM "Venta" v WHERE ${whereGlobal}
  `);

  const minFecha = limites[0]?.minFecha?.slice(0, 10) ?? null;
  const maxFecha = limites[0]?.maxFecha?.slice(0, 10) ?? null;

  if (!minFecha || !maxFecha) {
    return {
      referencia: null,
      primerDato: null,
      kpis: CLAVES.map((clave) => ({
        ...BASE[clave],
        clave,
        valor: null,
        estado: "sin-datos" as const,
        periodo: "",
        comparativo: noDisponible("sin ventas cargadas"),
      })),
    };
  }

  const hoy = maxFecha;
  const { anho, mes, dia } = partes(hoy);

  const mesDesde = armar(anho, mes, 1);
  const mesHasta = hoy;
  const mesParcial = dia < ultimoDia(anho, mes);

  const anhoPrevio = mes === 1 ? anho - 1 : anho;
  const mesPrevio = mes === 1 ? 12 : mes - 1;
  const previoDesde = armar(anhoPrevio, mesPrevio, 1);
  const previoHasta = armar(
    anhoPrevio,
    mesPrevio,
    Math.min(dia, ultimoDia(anhoPrevio, mesPrevio)),
  );

  const etiquetaTramo = mesParcial
    ? `${etiquetaMes(anhoPrevio, mesPrevio)} (1-${dia})`
    : etiquetaMes(anhoPrevio, mesPrevio);

  const previoDiaRows = await prisma.$queryRaw<Array<{ fecha: string | null }>>(Prisma.sql`
    SELECT MAX(v."fecha") AS "fecha"
    FROM "Venta" v WHERE ${whereGlobal} AND v."fecha" < ${hoy}
  `);
  const diaPrevio = previoDiaRows[0]?.fecha?.slice(0, 10) ?? null;

  const [actualDia, previoDiaAgg, actualMes, previoMes] = await Promise.all([
    agregar(prisma, hoy, hoy, filtros),
    diaPrevio
      ? agregar(prisma, diaPrevio, diaPrevio, filtros)
      : Promise.resolve(VACIO),
    agregar(prisma, mesDesde, mesHasta, filtros),
    agregar(prisma, previoDesde, previoHasta, filtros),
  ]);

  const hayDia = Boolean(diaPrevio) && previoDiaAgg.filas > 0;
  const hayMes = previoMes.filas > 0;
  const etiquetaDiaPrevio = diaPrevio ? etiquetaDia(diaPrevio) : "dias anteriores";

  const primerMes = partes(minFecha);
  const mesEsElPrimero = primerMes.anho === anho && primerMes.mes === mes;
  const previoEsElPrimero =
    primerMes.anho === anhoPrevio && primerMes.mes === mesPrevio;

  const [nuevosActual, nuevosPrevio] = mesEsElPrimero
    ? [null, 0]
    : await Promise.all([
        clientesNuevos(prisma, mesDesde, mesHasta, filtros),
        previoEsElPrimero || !hayMes
          ? Promise.resolve(0)
          : clientesNuevos(prisma, previoDesde, previoHasta, filtros),
      ]);

  const hayNuevosPrevio = hayMes && !previoEsElPrimero;

  const periodoMes = mesParcial
    ? `${etiquetaMes(anho, mes)} · al ${pad(dia)}/${pad(mes)}`
    : etiquetaMes(anho, mes);
  const estadoMes = mesParcial ? ("parcial" as const) : ("ok" as const);

  const delMes = (valor: number, base: number): Pick<ResumenKpi, "estado" | "periodo" | "comparativo"> => ({
    estado: estadoMes,
    periodo: periodoMes,
    comparativo: delta(valor, base, hayMes, etiquetaTramo),
  });

  const kpis: ResumenKpi[] = [
    {
      ...BASE.ventasDia,
      clave: "ventasDia",
      valor: actualDia.ventaNeta,
      estado: "ok",
      periodo: etiquetaDia(hoy),
      comparativo: delta(
        actualDia.ventaNeta,
        previoDiaAgg.ventaNeta,
        hayDia,
        etiquetaDiaPrevio,
      ),
    },
    {
      ...BASE.ventasMes,
      clave: "ventasMes",
      valor: actualMes.ventaNeta,
      ...delMes(actualMes.ventaNeta, previoMes.ventaNeta),
    },
    {
      ...BASE.margen,
      clave: "margen",
      valor: actualMes.ventaNeta ? margen(actualMes) : null,
      estado: actualMes.ventaNeta ? estadoMes : "sin-datos",
      periodo: periodoMes,
      comparativo: deltaPuntos(margen(actualMes), margen(previoMes), hayMes, etiquetaTramo),
    },
    {
      ...BASE.clientesActivos,
      clave: "clientesActivos",
      valor: actualMes.clientes,
      ...delMes(actualMes.clientes, previoMes.clientes),
    },
    {
      ...BASE.clientesNuevos,
      clave: "clientesNuevos",
      valor: nuevosActual,
      estado: mesEsElPrimero ? "sin-datos" : estadoMes,
      periodo: periodoMes,
      comparativo: mesEsElPrimero
        ? noDisponible("primer mes con datos: no hay historial previo")
        : delta(nuevosActual ?? 0, nuevosPrevio, hayNuevosPrevio, etiquetaTramo),
    },
    {
      ...BASE.facturas,
      clave: "facturas",
      valor: actualMes.facturas,
      ...delMes(actualMes.facturas, previoMes.facturas),
    },
    {
      ...BASE.ticketPromedio,
      clave: "ticketPromedio",
      valor: actualMes.facturas ? ticket(actualMes) : null,
      estado: actualMes.facturas ? estadoMes : "sin-datos",
      periodo: periodoMes,
      comparativo: delta(ticket(actualMes), ticket(previoMes), hayMes, etiquetaTramo),
    },
    {
      ...BASE.unidades,
      clave: "unidades",
      valor: actualMes.unidades,
      ...delMes(actualMes.unidades, previoMes.unidades),
    },
    {
      ...BASE.cumplimientoObjetivo,
      clave: "cumplimientoObjetivo",
      valor: null,
      estado: "sin-configurar",
      periodo: periodoMes,
      comparativo: noDisponible("sin objetivos cargados"),
      accion: { texto: "Configurar objetivos", href: "/configuracion/objetivos" },
    },
  ];

  return { referencia: hoy, primerDato: minFecha, kpis };
}

const BASE = {
  ventasDia: { titulo: "Ventas del día", formato: "moneda" },
  ventasMes: { titulo: "Ventas del mes", formato: "moneda" },
  margen: { titulo: "Margen bruto", formato: "porcentaje" },
  clientesActivos: { titulo: "Clientes activos", formato: "numero" },
  clientesNuevos: { titulo: "Clientes nuevos", formato: "numero" },
  facturas: { titulo: "Facturas", formato: "numero" },
  ticketPromedio: { titulo: "Ticket promedio", formato: "moneda" },
  unidades: { titulo: "Unidades", formato: "numero" },
  cumplimientoObjetivo: { titulo: "Cumpl. objetivo", formato: "porcentaje" },
} as const satisfies Record<string, { titulo: string; formato: ResumenKpi["formato"] }>;

const CLAVES = Object.keys(BASE) as Array<keyof typeof BASE>;
