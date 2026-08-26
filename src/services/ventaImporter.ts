import { Prisma } from "@prisma/client";
import type { UploadFilaOmitida, VentaRow } from "../lib/types.js";
import { claveVentaHash } from "./claveVenta.js";

const INSERT_BATCH_SIZE = 100;
/** Cantidad máxima de filas omitidas que viajan con detalle completo en la respuesta. */
export const LIMITE_DETALLE_OMITIDAS = 200;

const VENTA_COLUMNS = [
  "codCompania", "compania", "codDistribuidora", "distribuidora", "codCliente", "razonSocial",
  "codProducto", "producto", "codMarca", "marca", "fecha", "anhoMes", "anho", "mes", "dia",
  "vtaUnit", "montoIvaBrutaGua", "costoVtaGua", "montoVtaNetaGua", "codCanal", "canal", "codRamo",
  "ramo", "codVendedor", "vendedor", "tipoDoc", "nroDoc", "nroComprobante", "codZona", "zona",
  "codTipoProducto", "tipoProducto", "precioConIva", "precioSinIva", "porcDescuento", "precioLista",
  "iva", "ciudad", "ruc", "latitud", "longitud", "claveHash", "cargaId",
] as const;

const sqlColumns = Prisma.sql`
  ${Prisma.join(VENTA_COLUMNS.map((column) => Prisma.raw(`"${column}"`)), ", ")}
`;

function sqlValues(row: VentaRow, cargaId: number, hash: string) {
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
    ${row.iva}, ${row.ciudad}, ${row.ruc}, ${row.latitud}, ${row.longitud}, ${hash}, ${cargaId}
  )`;
}

/** Convierte un registro crudo de Venta a VentaRow (sin id/cargaId y sin BigInt). */
function aVentaRow(registro: Record<string, unknown>): VentaRow {
  const fila: Record<string, unknown> = { ...registro };
  delete fila["id"];
  delete fila["cargaId"];
  delete fila["claveHash"];
  for (const [clave, valor] of Object.entries(fila)) {
    if (typeof valor === "bigint") fila[clave] = Number(valor);
  }
  return fila as unknown as VentaRow;
}

export type InsertResultado = {
  filasNuevas: number;
  /** Filas omitidas con su detalle; como máximo LIMITE_DETALLE_OMITIDAS entradas. */
  omitidas: UploadFilaOmitida[];
  /** true si hubo más omisiones que las que entran en `omitidas`. */
  omitidasTruncadas: boolean;
};

/**
 * Inserta por lotes descartando filas repetidas por el índice único de
 * `claveHash` (SHA-256 de todas las columnas). Antes de cada lote busca en la
 * tabla los hashes que ya existen (cargas previas y lotes anteriores de esta
 * misma transacción) para poder reportar, por cada fila omitida, cuál fue la
 * fila idéntica que la ocasionó.
 */
export async function insertRows(
  tx: Prisma.TransactionClient,
  rows: VentaRow[],
  numerosDeFila: number[],
  cargaId: number,
): Promise<InsertResultado> {
  let inserted = 0;
  let totalOmitidas = 0;
  const omitidas: UploadFilaOmitida[] = [];
  // Primera aparición de cada clave dentro de esta misma carga, con su nro de fila.
  const vistas = new Map<string, { row: VentaRow; fila: number }>();

  for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + INSERT_BATCH_SIZE);

    const existentes = new Map<string, VentaRow>();
    const hashes = batch.map((row) => claveVentaHash(row));
    const encontradas = await tx.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`SELECT * FROM "Venta" WHERE "claveHash" IN (${Prisma.join(
        hashes.map((h) => Prisma.sql`${h}`),
        ", ",
      )})`,
    );
    for (const registro of encontradas) {
      const existente = aVentaRow(registro);
      existentes.set(claveVentaHash(existente), existente);
    }

    const nuevas: VentaRow[] = [];
    const nuevosHashes: string[] = [];
    for (let offset = 0; offset < batch.length; offset += 1) {
      const row = batch[offset];
      const hash = hashes[offset];
      const fila = numerosDeFila[index + offset] ?? index + offset + 1;
      const repetidaEnCarga = vistas.get(hash);
      const registrada = existentes.get(hash);
      if (!repetidaEnCarga && !registrada) {
        nuevas.push(row);
        nuevosHashes.push(hash);
        vistas.set(hash, { row, fila });
        continue;
      }
      totalOmitidas += 1;
      if (omitidas.length >= LIMITE_DETALLE_OMITIDAS) continue;
      omitidas.push({
        fila,
        motivo: repetidaEnCarga
          ? "Fila idéntica repetida dentro de la misma carga"
          : "Ya existe una fila idéntica",
        nueva: row,
        existente: repetidaEnCarga?.row ?? registrada ?? null,
        filaExistente: repetidaEnCarga?.fila ?? null,
      });
    }

    if (nuevas.length > 0) {
      const values = Prisma.join(
        nuevas.map((row, i) => sqlValues(row, cargaId, nuevosHashes[i])),
        ", ",
      );
      inserted += await tx.$executeRaw<number>(
        Prisma.sql`INSERT OR IGNORE INTO "Venta" (${sqlColumns}) VALUES ${values}`,
      );
    }
  }
  await insertClientes(tx, rows);
  await insertVendedores(tx, rows);
  return {
    filasNuevas: inserted,
    omitidas,
    omitidasTruncadas: totalOmitidas > omitidas.length,
  };
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
