import * as XLSX from "xlsx";
import type { VentaRow } from "../lib/types.js";

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).trim();

/** Excel serial date -> ISO yyyy-mm-dd */
const serialToIso = (serial: number): string => {
  if (!serial) return "";
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
};

export function parseExcel(buffer: ArrayBuffer): VentaRow[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]!]!;
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });

  return raw.map((r) => {
    const fechaRaw = r["fecha"];
    const fecha =
      typeof fechaRaw === "number"
        ? serialToIso(fechaRaw)
        : str(fechaRaw).slice(0, 10) ||
          `${num(r["anho"])}-${String(num(r["mes"])).padStart(2, "0")}-${String(num(r["dia"])).padStart(2, "0")}`;

    return {
      codCompania: num(r["cod compania"]),
      compania: str(r["compania"]),
      codDistribuidora: num(r["cod distribuidora"]),
      distribuidora: str(r["distribuidora"]),
      codCliente: num(r["cod cliente"]),
      razonSocial: str(r["razon social"]),
      codProducto: num(r["cod producto"]),
      producto: str(r["producto"]),
      codMarca: num(r["cod marca"]),
      marca: str(r["marca"]),
      fecha,
      anhoMes: num(r["anho mes"]),
      anho: num(r["anho"]),
      mes: num(r["mes"]),
      dia: num(r["dia"]),
      vtaUnit: num(r["vta unit"]),
      montoIvaBrutaGua: num(r["monto iva bruta gua"]),
      costoVtaGua: num(r["costo vta gua"]),
      montoVtaNetaGua: num(r["monto vta neta gua"]),
      codCanal: num(r["cod canal"]),
      canal: str(r["canal"]) || "SIN CANAL",
      codRamo: num(r["cod ramo"]),
      ramo: str(r["ramo"]),
      codVendedor: num(r["cod vendedor"]),
      vendedor: str(r["vendedor"]).replace(/\s*\.\s*/g, " ").trim() || "SIN VENDEDOR",
      tipoDoc: str(r["tipo doc"]),
      nroDoc: str(r["nro doc"]),
      nroComprobante: num(r["nro comprobante"]),
      codZona: num(r["cod zona"]),
      zona: str(r["zona"]) || "SIN ZONA",
      codTipoProducto: num(r["cod tipo producto"]),
      tipoProducto: str(r["tipo producto"]),
      precioConIva: num(r["precio con iva"]),
      precioSinIva: num(r["precio sin iva"]),
      porcDescuento: num(r["Porc descuento"]),
      precioLista: num(r["precio lista"]),
      iva: num(r["iva"]),
      ciudad: str(r["ciudad"]) || "SIN CIUDAD",
      ruc: str(r["ruc"]),
      latitud: num(r["latitud"]),
      longitud: num(r["longitud"]),
    } satisfies VentaRow;
  });
}
