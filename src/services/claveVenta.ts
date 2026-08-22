import { createHash } from "node:crypto";

/**
 * Clave única de Venta = SHA-256 de TODAS las columnas de datos de la fila.
 * Dos filas comparten clave sólo si son absolutamente idénticas en las 41
 * columnas de negocio; si difieren en una sola (cantidad, precio, costo, día,
 * vendedor, ciudad, etc.) se guardan ambas. Se usa el hash en lugar de una
 * lista de columnas porque las líneas legítimas pueden coincidir en casi todo
 * el comprobante y diferir en cualquier campo.
 *
 * El orden es fijo y los NULL se normalizan, así el hash es determinístico:
 * la misma fila del mismo origen siempre produce el mismo hash, y una recarga
 * del mismo período sigue descartando los duplicados exactos.
 */
export const CAMPOS_HASH = [
  "codCompania", "compania", "codDistribuidora", "distribuidora", "codCliente", "razonSocial",
  "codProducto", "producto", "codMarca", "marca", "fecha", "anhoMes", "anho", "mes", "dia",
  "vtaUnit", "montoIvaBrutaGua", "costoVtaGua", "montoVtaNetaGua", "codCanal", "canal", "codRamo",
  "ramo", "codVendedor", "vendedor", "tipoDoc", "nroDoc", "nroComprobante", "codZona", "zona",
  "codTipoProducto", "tipoProducto", "precioConIva", "precioSinIva", "porcDescuento", "precioLista",
  "iva", "ciudad", "ruc", "latitud", "longitud",
] as const;

/**
 * Representación canónica de la fila: JSON de los valores en el orden fijo de
 * CAMPOS_HASH. Acepta tanto una VentaRow parseada como un registro de la BD
 * (los BigInt de nroComprobante se convierten a number).
 */
export function contenidoCanonico(registro: Record<string, unknown>): string {
  return JSON.stringify(
    CAMPOS_HASH.map((campo) => {
      const valor = (registro as Record<string, unknown>)[campo];
      return typeof valor === "bigint" ? Number(valor) : (valor ?? null);
    }),
  );
}

/** SHA-256 (hex) del contenido canónico de la fila. */
export function claveVentaHash(registro: Record<string, unknown>): string {
  return createHash("sha256").update(contenidoCanonico(registro)).digest("hex");
}
