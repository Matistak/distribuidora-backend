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
  return inserted;
}
