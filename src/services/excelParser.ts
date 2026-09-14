import * as XLSX from "xlsx";
import {
  type ParsedRows,
  RowValidationError,
  normalizeHeader,
  parseVentaRows,
  validateHeaders,
} from "./ventaRowParser.js";

export type ParsedExcel = ParsedRows;

export function parseExcel(buffer: ArrayBuffer | Uint8Array): ParsedExcel {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "array" });
  } catch {
    throw new RowValidationError("El archivo no es un Excel válido");
  }
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new RowValidationError("El archivo no contiene hojas");
  const sheet = workbook.Sheets[firstSheet];
  if (!sheet) throw new RowValidationError("No se pudo leer la primera hoja");

  const headerRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1, defval: null, blankrows: false,
  });
  const headers = (headerRows[0] ?? []).map(normalizeHeader).filter(Boolean);
  validateHeaders(headers, "El Excel");

  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null, blankrows: false,
  });
  if (rawRows.length === 0) throw new RowValidationError("El archivo no contiene registros");

  return parseVentaRows(rawRows, 2);
}
