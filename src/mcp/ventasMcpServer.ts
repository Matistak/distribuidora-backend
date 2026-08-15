import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  alertasVentas,
  CATALOGOS_FILTRO,
  compararPeriodos,
  ConsultaVentasError,
  detalleAlertaVentas,
  filtrosSchema,
  RANKING_DIMENSIONES,
  rankingVentas,
  resumenVentas,
  validarRanking,
  valoresFiltro,
  ventasPorPeriodo,
} from "../services/ventasConsultas.js";
import { isPackaged, resolvePrismaEnv } from "../lib/appPaths.js";
import { startMcpServer, type McpToolDefinition } from "./mcpServer.js";

/**
 * Servidor MCP de ventas (Etapa 6). Es un proceso separado que `app-server`
 * inicia por stdio con la configuracion de `src/mcp/ventasMcpConfig.ts`.
 *
 * Solamente consulta la base local en modo lectura; no escribe, no expone
 * datos mas alla de los agregados pedidos y no toca credenciales de Codex.
 */

if (isPackaged()) {
  // App empaquetada: la DB vive en el directorio de datos de la aplicacion y
  // el engine de Prisma se busca junto al ejecutable (Etapa 8).
  resolvePrismaEnv();
} else if (!process.env["DATABASE_URL"]) {
  // En desarrollo (tsx) el directorio es src/mcp; compilado, dist/mcp. En
  // ambos casos la DB local vive en <raiz>/prisma/distribuidora.db.
  const raiz = dirname(dirname(import.meta.dirname));
  const dbPath = join(raiz, "prisma", "distribuidora.db");
  process.env["DATABASE_URL"] = `file:${dbPath}`;
  if (!existsSync(dbPath)) {
    console.warn(`[mcp-ventas] No se encontro la DB en ${dbPath}; Prisma creara una vacia.`);
  }
}

const prisma = new PrismaClient();

/** JSON Schema (draft-07) del filtro comun; se mantiene alineado con zod. */
const filtrosJsonSchema: {
  type: string;
  properties: Record<string, unknown>;
} = {
  type: "object",
  properties: {
    desde: { type: "string", description: "Fecha de inicio inclusive (YYYY-MM-DD)." },
    hasta: { type: "string", description: "Fecha de fin inclusive (YYYY-MM-DD)." },
    cliente: { type: "string", description: "Razon social del cliente (coincidencia parcial)." },
    vendedor: { type: "string", description: "Nombre exacto del vendedor." },
    canal: { type: "string", description: "Nombre exacto del canal." },
    ciudad: { type: "string", description: "Nombre exacto de la ciudad." },
    zona: { type: "string", description: "Nombre exacto de la zona." },
  },
};

/** Los errores de validacion/consulta se devuelven como texto (no como error JSON-RPC). */
function alTexto(error: unknown): string {
  if (error instanceof z.ZodError) {
    const detalles = error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    return `Argumentos invalidos: ${detalles}`;
  }
  if (error instanceof ConsultaVentasError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

const tools: McpToolDefinition[] = [
  {
    name: "resumen_ventas",
    description:
      "Resumen agregado de ventas (venta bruta, neta, facturas, unidades, clientes, margen) de un periodo con filtros opcionales.",
    inputSchema: filtrosJsonSchema,
    handler: async (args) => {
      try {
        const filtros = filtrosSchema.parse(args);
        return { text: await resumenVentas(prisma, filtros) };
      } catch (error) {
        return { text: alTexto(error), isError: true };
      }
    },
  },
  {
    name: "ventas_por_periodo",
    description:
      "Serie de venta neta por periodo: por dia del mes, por mes (YYYY-MM) o por anio. Usa 'granularidad' para elegir.",
    inputSchema: {
      ...filtrosJsonSchema,
      properties: {
        ...filtrosJsonSchema.properties,
        granularidad: {
          type: "string",
          enum: ["dia", "mes", "anho"],
          description: "Agrupacion: 'dia' (1-31), 'mes' (YYYY-MM, por defecto) o 'anho'.",
        },
      },
    },
    handler: async (args) => {
      try {
        const schema = filtrosSchema.extend({
          granularidad: z.enum(["dia", "mes", "anho"]).optional(),
        });
        const input = schema.parse(args);
        return { text: await ventasPorPeriodo(prisma, input) };
      } catch (error) {
        return { text: alTexto(error), isError: true };
      }
    },
  },
  {
    name: "ranking_ventas",
    description:
      "Ranking de venta neta con participacion por la dimension indicada en 'por': vendedor, producto, ciudad, canal, marca o cliente. Para un periodo y filtros opcionales.",
    inputSchema: {
      ...filtrosJsonSchema,
      properties: {
        ...filtrosJsonSchema.properties,
        por: {
          type: "string",
          enum: RANKING_DIMENSIONES,
          description: "Dimension por la que se agrupa el ranking.",
        },
        limite: { type: "number", description: "Maximo de filas (default 10, maximo 50)." },
      },
      required: ["por"],
    },
    handler: async (args) => {
      try {
        const schema = filtrosSchema.extend({ por: z.string(), limite: z.number().optional() });
        const input = schema.parse(args);
        return { text: await rankingVentas(prisma, validarRanking(input.por), input) };
      } catch (error) {
        return { text: alTexto(error), isError: true };
      }
    },
  },
  {
    name: "valores_filtro",
    description:
      "Lista los valores reales que puede tomar un filtro (cliente, vendedor, canal, ciudad, zona, marca, producto). Usalo antes de filtrar: vendedor, canal, ciudad y zona se comparan de forma exacta.",
    inputSchema: {
      type: "object",
      properties: {
        tipo: {
          type: "string",
          enum: CATALOGOS_FILTRO,
          description: "Catalogo que se quiere listar.",
        },
        q: { type: "string", description: "Texto que debe contener el valor (busqueda parcial)." },
        limite: { type: "number", description: "Maximo de valores (default 25, maximo 200)." },
      },
      required: ["tipo"],
    },
    handler: async (args) => {
      try {
        const schema = z.object({
          tipo: z.string(),
          q: z.string().optional(),
          limite: z.number().optional(),
        });
        return { text: await valoresFiltro(prisma, schema.parse(args)) };
      } catch (error) {
        return { text: alTexto(error), isError: true };
      }
    },
  },
  {
    name: "alertas_ventas",
    description:
      "Alertas del mes vigente: vendedores en caida, clientes sin compras, productos en caida y en crecimiento. Ignora el rango de fechas (siempre usa el ultimo mes con datos).",
    inputSchema: {
      type: "object",
      properties: {
        cliente: filtrosJsonSchema.properties["cliente"],
        vendedor: filtrosJsonSchema.properties["vendedor"],
        canal: filtrosJsonSchema.properties["canal"],
        ciudad: filtrosJsonSchema.properties["ciudad"],
        zona: filtrosJsonSchema.properties["zona"],
      },
    },
    handler: async (args) => {
      try {
        return { text: await alertasVentas(prisma, filtrosSchema.parse(args)) };
      } catch (error) {
        return { text: alTexto(error), isError: true };
      }
    },
  },
  {
    name: "detalle_alerta",
    description:
      "Filas que explican una alerta de alertas_ventas: cuales son los vendedores, productos o clientes detras del numero.",
    inputSchema: {
      type: "object",
      properties: {
        alerta: {
          type: "string",
          enum: ["vendedoresEnCaida", "clientesSinCompras", "productosEnCaida", "productosEnCrecimiento"],
          description: "Clave de la alerta a detallar.",
        },
        cliente: filtrosJsonSchema.properties["cliente"],
        vendedor: filtrosJsonSchema.properties["vendedor"],
        canal: filtrosJsonSchema.properties["canal"],
        ciudad: filtrosJsonSchema.properties["ciudad"],
        zona: filtrosJsonSchema.properties["zona"],
        limite: { type: "number", description: "Maximo de filas (default 10, maximo 50)." },
      },
      required: ["alerta"],
    },
    handler: async (args) => {
      try {
        const schema = filtrosSchema.extend({
          alerta: z.string(),
          limite: z.number().optional(),
        });
        return { text: await detalleAlertaVentas(prisma, schema.parse(args)) };
      } catch (error) {
        return { text: alTexto(error), isError: true };
      }
    },
  },
  {
    name: "comparar_periodos",
    description:
      "Compara dos periodos de fechas (venta neta, facturas) e indica la variacion. Requiere periodo1_desde/hasta y periodo2_desde/hasta.",
    inputSchema: {
      ...filtrosJsonSchema,
      properties: {
        ...filtrosJsonSchema.properties,
        periodo1_desde: { type: "string", description: "Inicio del primer periodo (YYYY-MM-DD)." },
        periodo1_hasta: { type: "string", description: "Fin del primer periodo (YYYY-MM-DD)." },
        periodo2_desde: { type: "string", description: "Inicio del segundo periodo (YYYY-MM-DD)." },
        periodo2_hasta: { type: "string", description: "Fin del segundo periodo (YYYY-MM-DD)." },
      },
      required: ["periodo1_desde", "periodo1_hasta", "periodo2_desde", "periodo2_hasta"],
    },
    handler: async (args) => {
      try {
        const schema = filtrosSchema.extend({
          periodo1_desde: z.string(),
          periodo1_hasta: z.string(),
          periodo2_desde: z.string(),
          periodo2_hasta: z.string(),
        });
        const input = schema.parse(args);
        return {
          text: await compararPeriodos(prisma, {
            ...input,
            periodo1Desde: input.periodo1_desde,
            periodo1Hasta: input.periodo1_hasta,
            periodo2Desde: input.periodo2_desde,
            periodo2Hasta: input.periodo2_hasta,
          }),
        };
      } catch (error) {
        return { text: alTexto(error), isError: true };
      }
    },
  },
];

const INSTRUCCIONES = [
  "Servidor de consultas de ventas (solo lectura) de una distribuidora.",
  "Fechas en formato YYYY-MM-DD; los rangos son inclusive y como maximo 10 anios.",
  `Herramientas: ${tools.map((tool) => tool.name).join(", ")}.`,
  "Sin \"desde\"/\"hasta\" la consulta cubre toda la historia cargada:",
  "no inventes un rango amplio para eso, omiti las fechas.",
  "Los montos estan en guaranies (PYG) y con formato es-PY (miles con punto).",
  "El guarani no usa decimales: no les agregues centavos ni el simbolo Q.",
  "Los filtros vendedor, canal, ciudad y zona se comparan de forma exacta:",
  "si no estas seguro del nombre, usa valores_filtro antes de consultar.",
  "El filtro cliente admite coincidencia parcial.",
  "alertas_ventas y detalle_alerta siempre miran el ultimo mes con datos,",
  "sin importar el rango de fechas de la conversacion.",
  "Cuando una consulta no devuelva resultados, decilo con claridad;",
  "no inventes cifras ni supongas datos fuera del rango consultado.",
].join("\n");

const server = startMcpServer({
  name: "ventas-mcp",
  version: "0.1.0",
  instructions: INSTRUCCIONES,
  tools,
  logger: (message) => console.error(`[mcp-ventas] ${message}`),
});

async function shutdown(): Promise<void> {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
