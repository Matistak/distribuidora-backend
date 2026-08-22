import { Client } from "pg";
import {
  type ParsedRows,
  RowValidationError,
  normalizeHeader,
  parseVentaRows,
  validateHeaders,
} from "./ventaRowParser.js";
import type { UploadRowError, VentaRow } from "../lib/types.js";

/**
 * Origen alternativo de datos: una base PostgreSQL externa con las mismas
 * columnas que el Excel. Hoy sólo se consulta la vista de ventas; el nombre es
 * configurable para poder sumar otras tablas más adelante.
 *
 * Sobre los tipos de la vista: los `cod *` son varchar y los importes numeric,
 * que node-postgres entrega como string (igual que int8). No hace falta
 * convertirlos acá: el parser compartido con el Excel ya resuelve texto a
 * número, y numeric siempre sale con "." como separador decimal. Las columnas
 * que la vista trae de más (selectivo, masivo, nro timbrado, lista precios,
 * cod atributo, descripcion producto, codigobarra) se ignoran porque el parser
 * toma los campos por nombre.
 */

const DEFAULT_TABLE = "datacenter_aj.dbo.vw_ventaneta";
const PAGE_SIZE = 25_000;
const DEFAULT_MAX_ROWS = 500_000;
const CONNECT_TIMEOUT_MS = 15_000;
const STATEMENT_TIMEOUT_MS = 300_000;
const DIAGNOSTICO_TIMEOUT_MS = 20_000;

export class SourceConfigError extends Error {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = "SourceConfigError";
  }
}

export type SourceConfig = {
  connectionString: string;
  tabla: string;
  maxFilas: number;
};

/** Cita un identificador `db.schema.tabla` validando cada parte. */
function quoteTable(tabla: string): string {
  const partes = tabla.split(".").map((parte) => parte.trim());
  if (partes.length === 0 || partes.length > 3 || partes.some((parte) => !parte)) {
    throw new SourceConfigError(`Nombre de tabla inválido: ${tabla}`);
  }
  for (const parte of partes) {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(parte)) {
      throw new SourceConfigError(`Nombre de tabla inválido: ${tabla}`);
    }
  }
  return partes.map((parte) => `"${parte}"`).join(".");
}

export function sourceConfig(): SourceConfig | null {
  const connectionString = process.env["VENTAS_SOURCE_URL"]?.trim();
  if (!connectionString) return null;
  const maxFilas = Number(process.env["VENTAS_SOURCE_MAX_FILAS"] ?? DEFAULT_MAX_ROWS);
  return {
    connectionString,
    tabla: process.env["VENTAS_SOURCE_TABLA"]?.trim() || DEFAULT_TABLE,
    maxFilas: Number.isFinite(maxFilas) && maxFilas > 0 ? Math.floor(maxFilas) : DEFAULT_MAX_ROWS,
  };
}

function requireConfig(): SourceConfig {
  const config = sourceConfig();
  if (!config) {
    throw new SourceConfigError(
      "La carga por base de datos no está configurada. Definí VENTAS_SOURCE_URL en el servidor.",
    );
  }
  return config;
}

/**
 * Abre una conexión de un solo uso contra el origen. La sesión se marca de sólo
 * lectura, así el motor rechaza cualquier escritura incluso por error de código:
 * esta base se consulta y nunca se modifica ni migra (Prisma no la conoce).
 */
async function withClient<T>(
  config: SourceConfig,
  fn: (client: Client) => Promise<T>,
  statementTimeoutMs = STATEMENT_TIMEOUT_MS,
): Promise<T> {
  const client = new Client({
    connectionString: config.connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: statementTimeoutMs,
    application_name: "distribuidora-backend (solo lectura)",
  });
  try {
    await client.connect();
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new SourceConfigError(
      `No se pudo conectar con la base de datos de origen: ${(error as Error).message}`,
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** YYYY-MM -> 202608, la clave que usa la columna `anho mes` de la vista. */
function toAnhoMesKey(valor: string, campo: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(valor.trim());
  if (!match) throw new RowValidationError(`${campo} debe tener formato YYYY-MM`);
  const [, anho, mes] = match;
  const mesNumero = Number(mes);
  if (mesNumero < 1 || mesNumero > 12) throw new RowValidationError(`${campo} no es un mes válido`);
  return Number(anho) * 100 + mesNumero;
}

/**
 * La vista de origen no trae `dia`, así que se calcula desde `fecha`. Para no
 * depender de la zona horaria del driver, la fecha viaja como texto resuelto en
 * el propio motor y de ahí salen anho/mes/dia.
 */
const FECHA_ISO_ALIAS = "__fecha_iso";
const FECHA_ISO_SQL = `to_char("fecha"::date, 'YYYY-MM-DD') AS "${FECHA_ISO_ALIAS}"`;
const COLUMNAS_DERIVADAS = ["dia"] as const;

function normalizeRecord(row: Record<string, unknown>): Record<string, unknown> {
  const value = Object.fromEntries(
    Object.entries(row).map(([key, valor]) => [
      normalizeHeader(key),
      valor instanceof Date ? valor.toISOString().slice(0, 10) : valor,
    ]),
  );

  const iso = value[FECHA_ISO_ALIAS];
  delete value[FECHA_ISO_ALIAS];
  if (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    value["fecha"] = iso;
    value["dia"] ??= Number(iso.slice(8, 10));
    value["anho"] ??= Number(iso.slice(0, 4));
    value["mes"] ??= Number(iso.slice(5, 7));
  }
  return value;
}

export type SourceDiagnostico =
  | { estado: "no-configurado" }
  | { estado: "ok"; tabla: string }
  | { estado: "error"; tabla: string | null; motivo: string };

/**
 * Comprueba conexión, existencia de la tabla y columnas, sin lanzar. Es sólo
 * metadata: no lee filas ni calcula rangos, porque cualquier agregado sobre la
 * vista completa cuesta ~30s. Se usa una única vez al arrancar.
 */
export async function diagnosticarOrigen(): Promise<SourceDiagnostico> {
  const config = sourceConfig();
  if (!config) return { estado: "no-configurado" };
  try {
    const tabla = quoteTable(config.tabla);
    return await withClient(
      config,
      async (client) => {
        // Sólo metadata: `LIMIT 0` valida tabla y columnas sin leer una sola fila.
        const { fields } = await client.query(`SELECT * FROM ${tabla} LIMIT 0`);
        validateHeaders(
          fields.map((field) => normalizeHeader(field.name)).filter(Boolean),
          "La tabla de origen",
          COLUMNAS_DERIVADAS,
        );
        return { estado: "ok" as const, tabla: config.tabla };
      },
      DIAGNOSTICO_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      estado: "error",
      tabla: config.tabla,
      motivo: error instanceof Error ? error.message : String(error),
    };
  }
}

export type SourceFetchResult = ParsedRows & { truncado: boolean };

/**
 * Trae las ventas del origen en el rango de meses (YYYY-MM, ambos inclusive) y
 * las convierte a VentaRow. El filtro es únicamente por `anho mes`: se traen los
 * meses completos, sin acotar por día.
 */
export async function fetchVentasSource(desde: string, hasta: string): Promise<SourceFetchResult> {
  const config = requireConfig();
  const desdeAnhoMes = toAnhoMesKey(desde, "desde");
  const hastaAnhoMes = toAnhoMesKey(hasta, "hasta");
  if (desdeAnhoMes > hastaAnhoMes) {
    throw new RowValidationError("El rango de meses es inválido: desde es posterior a hasta");
  }

  const sql = `
    SELECT *, ${FECHA_ISO_SQL} FROM ${quoteTable(config.tabla)}
     WHERE "anho mes" BETWEEN $1 AND $2
     ORDER BY "fecha", "nro doc", "cod producto", "nro comprobante"
     LIMIT $3 OFFSET $4
  `;

  return withClient(config, async (client) => {
    const filas: VentaRow[] = [];
    const numeros: number[] = [];
    const errores: UploadRowError[] = [];
    let filasTotales = 0;
    let truncado = false;
    let offset = 0;
    let headersValidados = false;

    for (;;) {
      const restante = config.maxFilas - filasTotales;
      if (restante <= 0) break;
      const limite = Math.min(PAGE_SIZE, restante);
      const { rows, fields } = await client.query<Record<string, unknown>>(sql, [
        desdeAnhoMes,
        hastaAnhoMes,
        limite,
        offset,
      ]);
      if (!headersValidados) {
        validateHeaders(
          fields.map((field) => normalizeHeader(field.name)).filter(Boolean),
          "La tabla de origen",
          COLUMNAS_DERIVADAS,
        );
        headersValidados = true;
      }
      if (rows.length === 0) break;

      const parsed = parseVentaRows(rows.map(normalizeRecord), filasTotales + 1);
      filas.push(...parsed.filas);
      numeros.push(...parsed.numeros);
      errores.push(...parsed.errores);
      filasTotales += rows.length;
      offset += rows.length;
      if (rows.length < limite) break;
      if (filasTotales >= config.maxFilas) {
        truncado = true;
        break;
      }
    }

    if (filasTotales === 0) {
      throw new RowValidationError("No se encontraron registros en el rango de meses indicado");
    }
    return {
      filas,
      numeros,
      filasTotales,
      filasErrores: errores.length,
      errores,
      truncado,
    };
  });
}
