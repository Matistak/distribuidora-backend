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

export type SeriePunto = { label: string; valor: number };
export type RankingItem = { nombre: string; valor: number; participacion: number };

export type DashboardData = {
  kpis: Kpis;
  ventasPorDia: SeriePunto[];
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
