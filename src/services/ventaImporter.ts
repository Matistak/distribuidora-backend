import { Prisma } from "@prisma/client";
import type { VentaRow } from "../lib/types.js";

const INSERT_BATCH_SIZE = 100;

const VENTA_COLUMNS = [
  "codCompania", "compania", "codDistribuidora", "distribuidora", "codCliente", "razonSocial",
  "codProducto", "producto", "codMarca", "marca", "fecha", "anhoMes", "anho", "mes", "dia",
  "vtaUnit", "montoIvaBrutaGua", "costoVtaGua", "montoVtaNetaGua", "codCanal", "canal", "codRamo",
  "ramo", "codVendedor", "vendedor", "tipoDoc", "nroDoc", "nroComprobante", "codZona", "zona",
  "codTipoProducto", "tipoProducto", "precioConIva", "precioSinIva", "porcDescuento", "precioLista",
  "iva", "ciudad", "ruc", "latitud", "longitud", "cargaId",
] as const;

const sqlColumns = Prisma.sql`
  ${Prisma.join(VENTA_COLUMNS.map((column) => Prisma.raw(`"${column}"`)), ", ")}
`;

function sqlValues(row: VentaRow, cargaId: number) {
  return Prisma.sql`(
    ${row.codCompania}, ${row.compania}, ${row.codDistribuidora}, ${row.distribuidora},
    ${row.codCliente}, ${row.razonSocial}, ${row.codProducto}, ${row.producto},
    ${row.codMarca}, ${row.marca}, ${row.fecha},
    ${row.anhoMes}, ${row.anho}, ${row.mes}, ${row.dia}, ${row.vtaUnit},
    ${row.montoIvaBrutaGua}, ${row.costoVtaGua}, ${row.montoVtaNetaGua},
    ${row.codCanal}, ${row.canal}, ${row.codRamo}, ${row.ramo}, ${row.codVendedor},
    ${row.vendedor}, ${row.tipoDoc}, ${row.nroDoc}, ${BigInt(row.nroComprobante)},
    ${row.codZona}, ${row.zona}, ${row.codTipoProducto}, ${row.tipoProducto},
    ${row.precioConIva}, ${row.precioSinIva}, ${row.porcDescuento}, ${row.precioLista},
    ${row.iva}, ${row.ciudad}, ${row.ruc}, ${row.latitud}, ${row.longitud}, ${cargaId}
  )`;
}

/**
 * Rango de fechas que reemplaza una carga: `desde` inclusive, `hasta`
 * exclusivo, ambos como marca ISO-8601 UTC (el mismo formato de `Venta.fecha`,
 * que ordena igual byte a byte, así el índice de `fecha` sigue sirviendo).
 */
export type RangoFechas = {
  desde: string;
  hasta: string;
};

/** Comienzo del día UTC (`YYYY-MM-DDT00:00:00.000Z`) de una fecha ISO. */
function inicioDelDia(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00.000Z`;
}

/** Comienzo del día UTC siguiente al de la fecha ISO recibida. */
function inicioDelDiaSiguiente(iso: string): string {
  const dia = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  return new Date(dia.getTime() + 86_400_000).toISOString();
}

/**
 * Rango cubierto por las filas de una carga: del primer día con datos hasta el
 * final del último. Se usa cuando el origen no declara el rango (el Excel).
 * Devuelve null si no hay filas.
 */
export function rangoDeFilas(rows: VentaRow[]): RangoFechas | null {
  if (rows.length === 0) return null;
  let min = rows[0].fecha;
  let max = rows[0].fecha;
  for (const row of rows) {
    if (row.fecha < min) min = row.fecha;
    if (row.fecha > max) max = row.fecha;
  }
  return { desde: inicioDelDia(min), hasta: inicioDelDiaSiguiente(max) };
}

/** Rango de meses YYYY-MM (ambos inclusive) como rango de fechas. */
export function rangoDeMeses(desde: string, hasta: string): RangoFechas {
  const [anhoDesde, mesDesde] = desde.split("-").map(Number);
  const [anhoHasta, mesHasta] = hasta.split("-").map(Number);
  return {
    desde: new Date(Date.UTC(anhoDesde, mesDesde - 1, 1)).toISOString(),
    hasta: new Date(Date.UTC(anhoHasta, mesHasta, 1)).toISOString(),
  };
}

export type InsertResultado = {
  filasNuevas: number;
  /** Filas que había en el rango y fueron reemplazadas por las de esta carga. */
  filasReemplazadas: number;
};

/**
 * Reemplaza todo lo que haya en el rango por las filas de la carga: primero
 * borra las ventas cuya `fecha` cae dentro del rango y después inserta las
 * nuevas por lotes. No se descarta ninguna fila del origen —ni siquiera las
 * idénticas entre sí—, así lo que queda en la base es exactamente lo que trajo
 * el Excel o la base externa para ese período.
 */
export async function insertRows(
  tx: Prisma.TransactionClient,
  rows: VentaRow[],
  cargaId: number,
  rango: RangoFechas | null,
): Promise<InsertResultado> {
  const filasReemplazadas = rango
    ? await tx.$executeRaw(
        Prisma.sql`DELETE FROM "Venta" WHERE "fecha" >= ${rango.desde} AND "fecha" < ${rango.hasta}`,
      )
    : 0;

  let inserted = 0;
  for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + INSERT_BATCH_SIZE);
    const values = Prisma.join(
      batch.map((row) => sqlValues(row, cargaId)),
      ", ",
    );
    inserted += await tx.$executeRaw(
      Prisma.sql`INSERT INTO "Venta" (${sqlColumns}) VALUES ${values}`,
    );
  }

  await insertClientes(tx, rows);
  await insertVendedores(tx, rows);
  return { filasNuevas: inserted, filasReemplazadas };
}

/** Deduplica y persiste los clientes presentes en la carga (tabla Cliente). */
async function insertClientes(tx: Prisma.TransactionClient, rows: VentaRow[]) {
  const unicos = new Map<
    string,
    { codCliente: number | null; razonSocial: string | null; ruc: string | null }
  >();
  for (const row of rows) {
    if (row.codCliente === null && row.razonSocial === null) continue;
    const clave = row.codCliente !== null ? `c:${row.codCliente}` : `r:${row.razonSocial ?? ""}`;
    if (!unicos.has(clave)) {
      unicos.set(clave, {
        codCliente: row.codCliente,
        razonSocial: row.razonSocial,
        ruc: row.ruc,
      });
    }
  }
  if (unicos.size === 0) return;

  const valores = Prisma.join(
    [...unicos.values()].map(
      (c) => Prisma.sql`(${c.codCliente}, ${c.razonSocial}, ${c.ruc})`,
    ),
    ", ",
  );
  await tx.$executeRaw(
    Prisma.sql`INSERT OR IGNORE INTO "Cliente" ("codCliente", "razonSocial", "ruc") VALUES ${valores}`,
  );
}

/** Deduplica y persiste los vendedores presentes en la carga (tabla Vendedor). */
async function insertVendedores(tx: Prisma.TransactionClient, rows: VentaRow[]) {
  const unicos = new Map<string, { codVendedor: number | null; vendedor: string | null }>();
  for (const row of rows) {
    if (row.codVendedor === null && row.vendedor === null) continue;
    const clave = row.codVendedor !== null ? `v:${row.codVendedor}` : `n:${row.vendedor ?? ""}`;
    if (!unicos.has(clave)) {
      unicos.set(clave, { codVendedor: row.codVendedor, vendedor: row.vendedor });
    }
  }
  if (unicos.size === 0) return;

  const valores = Prisma.join(
    [...unicos.values()].map((v) => Prisma.sql`(${v.codVendedor}, ${v.vendedor})`),
    ", ",
  );
  await tx.$executeRaw(
    Prisma.sql`INSERT OR IGNORE INTO "Vendedor" ("codVendedor", "vendedor") VALUES ${valores}`,
  );
}
