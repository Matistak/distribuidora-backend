export type VentaRow = {
  codCompania: number | null;
  compania: string | null;
  codDistribuidora: number | null;
  distribuidora: string | null;
  codCliente: number | null;
  razonSocial: string | null;
  codProducto: number;
  producto: string | null;
  codMarca: number | null;
  marca: string | null;
  fecha: string;
  anhoMes: number | null;
  anho: number;
  mes: number;
  dia: number;
  vtaUnit: number | null;
  montoIvaBrutaGua: number | null;
  costoVtaGua: number | null;
  montoVtaNetaGua: number | null;
  codCanal: number | null;
  canal: string | null;
  codRamo: number | null;
  ramo: string | null;
  codVendedor: number | null;
  vendedor: string | null;
  tipoDoc: string | null;
  nroDoc: string;
  nroComprobante: number;
  codZona: number | null;
  zona: string | null;
  codTipoProducto: number | null;
  tipoProducto: string | null;
  precioConIva: number | null;
  precioSinIva: number | null;
  porcDescuento: number | null;
  precioLista: number | null;
  iva: number | null;
  ciudad: string | null;
  ruc: string | null;
  latitud: number | null;
  longitud: number | null;
};

export type Kpis = {
  ventaBruta: number;
  ventaNeta: number;
  ticketPromedio: number;
  cantidadFacturas: number;
  unidadesVendidas: number;
  clientesActivos: number;
  productosDistintos: number;
  notasCredito: number;
  margenPorc: number;
};

export type EstadoKpi = "ok" | "parcial" | "sin-datos" | "sin-configurar";

export type Comparativo =
  | {
      tipo: "delta";
      unidad: "pct" | "pp";
      pct: number;
      valorBase: number;
      base: string;
    }
  | { tipo: "no-disponible"; motivo: string };

export type ResumenKpi = {
  clave: string;
  titulo: string;
  formato: "moneda" | "numero" | "porcentaje";
  valor: number | null;
  estado: EstadoKpi;
  periodo: string;
  comparativo: Comparativo;
  accion?: { texto: string; href: string };
};

export type ResumenData = {
  referencia: string | null;
  primerDato: string | null;
  kpis: ResumenKpi[];
};

export type AlertaTono = "critico" | "advertencia" | "positivo";

export type Alerta = {
  clave: string;
  titulo: string;
  /** Sustantivo de lo que se cuenta: "vendedores", "clientes", "productos". */
  unidad: string;
  valor: number | null;
  estado: EstadoKpi;
  /** Contexto al pie de la tarjeta: base de comparacion o umbral aplicado. */
  detalle: string;
  tono: AlertaTono;
};

export type AlertasData = {
  referencia: string | null;
  alertas: Alerta[];
};

/** Tipo de dato de una columna del detalle, para formatear en el front. */
export type ColumnaTipo = "texto" | "numero" | "moneda" | "porcentaje" | "fecha";

export type ColumnaDetalle = {
  clave: string;
  titulo: string;
  tipo: ColumnaTipo;
};

export type FilaDetalle = Record<string, string | number | null>;

/** Filas que explican una alerta: el "cuales son" detras del numero. */
export type DetalleAlerta = {
  clave: string;
  titulo: string;
  /** Contexto de la comparacion o del umbral aplicado. */
  detalle: string;
  columnas: ColumnaDetalle[];
  filas: FilaDetalle[];
  /** Filas que cumplen la condicion; puede superar a filas.length si se trunco. */
  total: number;
};

export type SeriePunto = { label: string; valor: number };
export type RankingItem = { nombre: string; valor: number; participacion: number };

/** Un dia del mes con el valor del mes vigente y el del mes anterior (0 si no hubo ventas). */
export type PuntoComparativo = { dia: number; label: string; actual: number; anterior: number };

export type ComparativoMensual = {
  /** yyyy-mm del mes vigente y del anterior; "" si no hay datos. */
  mesActual: string;
  mesAnterior: string;
  puntos: PuntoComparativo[];
};

/** Los 12 meses del anho de referencia; 0 en los meses sin ventas. */
export type SerieAnual = {
  /** anho de la serie; 0 si no hay datos. */
  anho: number;
  puntos: SeriePunto[];
};

export type DashboardData = {
  kpis: Kpis;
  ventasPorDia: SeriePunto[];
  ventasComparativoMensual: ComparativoMensual;
  ventasPorMes: SerieAnual;
  ventasPorVendedor: RankingItem[];
  ventasPorCiudad: RankingItem[];
  ventasPorCanal: RankingItem[];
  ventasPorMarca: RankingItem[];
  topClientes: RankingItem[];
  topProductos: RankingItem[];
  periodo: { desde: string; hasta: string };
};

export type Filtros = {
  cliente?: string;
  vendedor?: string;
  canal?: string;
  ciudad?: string;
  zona?: string;
};

export type OpcionesFiltro = {
  clientes: string[];
  vendedores: string[];
  canales: string[];
  ciudades: string[];
  zonas: string[];
};

export type VendedorResumen = {
  vendedor: string;
  facturas: number;
  clientes: number;
  unidades: number;
  ventaBruta: number;
  ventaNeta: number;
  costo: number;
  margenPorc: number;
  ticketPromedio: number;
  participacion: number;
  ultimaVenta: string;
};

export type VendedoresKpis = {
  vendedoresActivos: number;
  ventaNeta: number;
  facturas: number;
  unidades: number;
  ticketPromedio: number;
  margenPorc: number;
  concentracionTop10: number;
};

export type VendedoresData = {
  kpis: VendedoresKpis;
  /** Ranking con todos los filtros aplicados (tabla y top 10). */
  data: VendedorResumen[];
  /** Ranking solo por fechas, para los KPIs de cabecera. */
  dataKpis: VendedorResumen[];
};

export type ClienteResumen = {
  cliente: string;
  vendedor: string;
  ciudad: string;
  canal: string;
  facturas: number;
  productos: number;
  unidades: number;
  ventaBruta: number;
  ventaNeta: number;
  costo: number;
  margenPorc: number;
  ticketPromedio: number;
  participacion: number;
  ultimaCompra: string;
};

export type ClientesKpis = {
  clientesActivos: number;
  ventaNeta: number;
  facturas: number;
  unidades: number;
  ticketPromedio: number;
  margenPorc: number;
  concentracionTop10: number;
};

export type ClientesData = {
  kpis: ClientesKpis;
  /** Ranking con todos los filtros aplicados (tabla y top 10). */
  data: ClienteResumen[];
  /** Ranking solo por fechas, para los KPIs de cabecera. */
  dataKpis: ClienteResumen[];
};

export type UploadResponse = {
  id: number;
  archivo: string;
  filasTotales: number;
  filasNuevas: number;
  filasOmitidas: number;
  filasErrores: number;
  errores: UploadRowError[];
  estado: string;
};

export type UploadRowError = {
  fila: number;
  motivo: string;
};

export type UploadHistorial = {
  id: number;
  archivo: string;
  filasTotales: number;
  filasNuevas: number;
  filasOmitidas: number;
  filasErrores: number;
  creadoEn: string;
  estado: string;
};
