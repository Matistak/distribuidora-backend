import { Prisma } from "@prisma/client";
import type { VentaRow } from "../lib/types.js";

const INSERT_BATCH_SIZE = 20;

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

/** Inserta por lotes y deja que el índice único descarte filas repetidas. */
export async function insertRows(tx: Prisma.TransactionClient, rows: VentaRow[], cargaId: number) {
  let inserted = 0;
  for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + INSERT_BATCH_SIZE);
    const values = Prisma.join(batch.map((row) => sqlValues(row, cargaId)), ", ");
    inserted += await tx.$executeRaw<number>(
      Prisma.sql`INSERT OR IGNORE INTO "Venta" (${sqlColumns}) VALUES ${values}`,
    );
  }
  await insertClientes(tx, rows);
  await insertVendedores(tx, rows);
  return inserted;
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
