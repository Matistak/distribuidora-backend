import type { UploadRowError, VentaRow } from "../lib/types.js";

export const REQUIRED_COLUMNS = [
  "cod compania", "compania", "cod distribuidora", "distribuidora", "cod cliente",
  "razon social", "cod producto", "producto", "cod marca", "marca", "fecha", "anho mes", "anho",
  "mes", "dia", "vta unit", "monto iva bruta gua", "costo vta gua", "monto vta neta gua",
  "cod canal", "canal", "cod ramo", "ramo", "cod vendedor", "vendedor", "tipo doc",
  "nro doc", "nro comprobante", "cod zona", "zona", "cod tipo producto", "tipo producto",
  "precio con iva", "precio sin iva", "porc descuento", "precio lista", "iva", "ciudad", "ruc",
  "latitud", "longitud",
] as const;

const NUMERIC_COLUMNS = [
  "cod compania", "cod distribuidora", "cod cliente", "cod producto", "cod marca", "anho mes",
  "anho", "mes", "dia", "vta unit", "monto iva bruta gua", "costo vta gua", "monto vta neta gua",
  "cod canal", "cod ramo", "cod vendedor", "nro comprobante", "cod zona", "cod tipo producto",
  "precio con iva", "precio sin iva", "porc descuento", "precio lista", "iva", "latitud", "longitud",
] as const;

const INTEGER_COLUMNS = new Set([
  "cod compania", "cod distribuidora", "cod cliente", "cod producto", "cod marca", "anho mes",
  "anho", "mes", "dia", "cod canal", "cod ramo", "cod vendedor", "nro comprobante", "cod zona",
  "cod tipo producto",
]);

export type ParsedRows = {
  filas: VentaRow[];
  /** Número de fila (Excel o base) de cada elemento de `filas`, en el mismo orden. */
  numeros: number[];
  filasTotales: number;
  filasErrores: number;
  errores: UploadRowError[];
};

export class RowValidationError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "RowValidationError";
  }
}

export function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function nullableText(value: unknown): string | null {
  const source = text(value);
  return source ? source : null;
}

function numberValue(value: unknown, column: string, rowNumber: number): number | null {
  let result: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    result = value;
  } else if (typeof value === "bigint") {
    const result = Number(value);
    if (Number.isSafeInteger(result)) return result;
  } else {
    const source = text(value);
    if (!source) return null;
    const normalized =
      source.includes(",") && source.includes(".")
        ? source.lastIndexOf(",") > source.lastIndexOf(".")
          ? source.replace(/\./g, "").replace(",", ".")
          : source.replace(/,/g, "")
        : source.replace(",", ".");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) result = parsed;
  }

  if (result !== undefined) {
    if (INTEGER_COLUMNS.has(column) && !Number.isInteger(result)) {
      throw new RowValidationError(`Fila ${rowNumber}: ${column} debe ser entero`);
    }
    if (column === "nro comprobante" && !Number.isSafeInteger(result)) {
      throw new RowValidationError(
        `Fila ${rowNumber}: nro comprobante excede el rango seguro de Excel`,
      );
    }
    return result;
  }
  throw new RowValidationError(`Fila ${rowNumber}: ${column} debe ser numérico`);
}

function dateFromParts(year: number, month: number, day: number, rowNumber: number): string {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new RowValidationError(`Fila ${rowNumber}: anho no es válido`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RowValidationError(`Fila ${rowNumber}: mes no es válido`);
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new RowValidationError(`Fila ${rowNumber}: dia no es válido`);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RowValidationError(`Fila ${rowNumber}: fecha no es válida`);
  }
  return date.toISOString().slice(0, 10);
}

function dateValue(
  value: unknown,
  year: number,
  month: number,
  day: number,
  rowNumber: number,
): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RowValidationError(`Fila ${rowNumber}: fecha no es válida`);
    }
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (Number.isNaN(date.getTime())) {
      throw new RowValidationError(`Fila ${rowNumber}: fecha no es válida`);
    }
    return dateFromParts(
      date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), rowNumber,
    );
  }

  const source = text(value);
  if (!source) return dateFromParts(year, month, day, rowNumber);
  const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(source);
  if (isoMatch) {
    return dateFromParts(
      Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]), rowNumber,
    );
  }
  const localMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(source);
  if (localMatch) {
    return dateFromParts(
      Number(localMatch[3]), Number(localMatch[2]), Number(localMatch[1]), rowNumber,
    );
  }
  throw new RowValidationError(`Fila ${rowNumber}: fecha no es válida`);
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
}

export function parseVentaRow(row: Record<string, unknown>, rowNumber: number): VentaRow {
  const value = normalizeRow(row);
  const numeric = (column: (typeof NUMERIC_COLUMNS)[number]) =>
    numberValue(value[column], column, rowNumber);
  const anho = numeric("anho");
  const mes = numeric("mes");
  const dia = numeric("dia");
  if (anho === null || mes === null || dia === null) {
    throw new RowValidationError(
      `Fila ${rowNumber}: anho, mes y dia son obligatorios`,
    );
  }
  const nroDoc = text(value["nro doc"]);
  if (!nroDoc) throw new RowValidationError(`Fila ${rowNumber}: nro doc es obligatorio`);
  const codProducto = numeric("cod producto");
  if (codProducto === null) {
    throw new RowValidationError(`Fila ${rowNumber}: cod producto es obligatorio`);
  }
  if (codProducto < 0) {
    throw new RowValidationError(`Fila ${rowNumber}: cod producto no es válido`);
  }
  const nroComprobante = numeric("nro comprobante");
  if (nroComprobante === null) {
    throw new RowValidationError(`Fila ${rowNumber}: nro comprobante es obligatorio`);
  }
  if (nroComprobante < 0) {
    throw new RowValidationError(`Fila ${rowNumber}: nro comprobante no es válido`);
  }

  return {
    codCompania: numeric("cod compania"),
    compania: nullableText(value.compania),
    codDistribuidora: numeric("cod distribuidora"),
    distribuidora: nullableText(value.distribuidora),
    codCliente: numeric("cod cliente"),
    razonSocial: nullableText(value["razon social"]) ?? "SIN CLIENTE",
    codProducto,
    producto: nullableText(value.producto),
    codMarca: numeric("cod marca"),
    marca: nullableText(value.marca),
    fecha: dateValue(value.fecha, anho, mes, dia, rowNumber),
    anhoMes: numeric("anho mes"),
    anho,
    mes,
    dia,
    vtaUnit: numeric("vta unit"),
    montoIvaBrutaGua: numeric("monto iva bruta gua"),
    costoVtaGua: numeric("costo vta gua"),
    montoVtaNetaGua: numeric("monto vta neta gua"),
    codCanal: numeric("cod canal"),
    canal: nullableText(value.canal) ?? "SIN CANAL",
    codRamo: numeric("cod ramo"),
    ramo: nullableText(value.ramo),
    codVendedor: numeric("cod vendedor"),
    vendedor: nullableText(value.vendedor)?.replace(/\s*\.\s*/g, " ").trim() ?? "SIN VENDEDOR",
    tipoDoc: nullableText(value["tipo doc"]),
    nroDoc,
    nroComprobante,
    codZona: numeric("cod zona"),
    zona: nullableText(value.zona) ?? "SIN ZONA",
    codTipoProducto: numeric("cod tipo producto"),
    tipoProducto: nullableText(value["tipo producto"]),
    precioConIva: numeric("precio con iva"),
    precioSinIva: numeric("precio sin iva"),
    porcDescuento: numeric("porc descuento"),
    precioLista: numeric("precio lista"),
    iva: numeric("iva"),
    ciudad: nullableText(value.ciudad) ?? "SIN CIUDAD",
    ruc: nullableText(value.ruc),
    latitud: numeric("latitud"),
    longitud: numeric("longitud"),
  };
}


/** Verifica que los encabezados normalizados cubran las columnas requeridas. */
export function validateHeaders(
  headers: string[],
  origen: string,
  derivables: readonly string[] = [],
) {
  const headerSet = new Set(headers);
  const duplicados = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicados.length) {
    throw new RowValidationError(
      `${origen} contiene columnas duplicadas: ${[...new Set(duplicados)].join(", ")}`,
    );
  }
  // `derivables` son columnas que el origen puede no traer porque se calculan
  // a partir de otras (por ejemplo `dia`, que sale de `fecha`).
  const faltantes = REQUIRED_COLUMNS.filter(
    (column) => !headerSet.has(column) && !derivables.includes(column),
  );
  if (faltantes.length) {
    throw new RowValidationError(`Faltan columnas obligatorias: ${faltantes.join(", ")}`);
  }
}

/**
 * Convierte registros crudos en filas de venta, acumulando los errores por fila
 * en lugar de abortar la carga completa. `primeraFila` es el número que se
 * reporta para el primer registro (2 en Excel por el encabezado, 1 en la base).
 */
export function parseVentaRows(
  rawRows: Record<string, unknown>[],
  primeraFila: number,
): ParsedRows {
  const filas: VentaRow[] = [];
  const numeros: number[] = [];
  const errores: UploadRowError[] = [];
  rawRows.forEach((row, index) => {
    try {
      filas.push(parseVentaRow(row, index + primeraFila));
      numeros.push(index + primeraFila);
    } catch (error) {
      if (error instanceof RowValidationError) {
        errores.push({ fila: index + primeraFila, motivo: error.message });
        return;
      }
      throw error;
    }
  });
  return {
    filas,
    numeros,
    filasTotales: rawRows.length,
    filasErrores: errores.length,
    errores,
  };
}
