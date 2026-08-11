import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  compararPeriodos,
  ConsultaVentasError,
  filtrosSchema,
  rankingVentas,
  resumenVentas,
  validarRanking,
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
      "Resumen agregado de ventas (venta bruta, neta, facturas, unidades, clientes, ticket, margen) de un periodo con filtros opcionales.",
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
    name: "ventas_por_vendedor",
    description: "Ranking de venta neta por vendedor con participacion, para un periodo y filtros opcionales.",
    inputSchema: {
      ...filtrosJsonSchema,
      properties: { ...filtrosJsonSchema.properties, limite: { type: "number", description: "Maximo de filas (default 10, maximo 50)." } },
    },
    handler: async (args) => {
      try {
        const schema = filtrosSchema.extend({ limite: z.number().optional() });
        const input = schema.parse(args);
        return { text: await rankingVentas(prisma, "vendedor", input) };
      } catch (error) {
        return { text: alTexto(error), isError: true };
      }
    },
  },
  {
    name: "ventas_por_producto",
    description: "Ranking de venta neta por producto con participacion, para un periodo y filtros opcionales.",
    inputSchema: {
      ...filtrosJsonSchema,
      properties: { ...filtrosJsonSchema.properties, limite: { type: "number", description: "Maximo de filas (default 10, maximo 50)." } },
    },
    handler: async (args) => {
      try {
        const schema = filtrosSchema.extend({ limite: z.number().optional() });
        const input = schema.parse(args);
        return { text: await rankingVentas(prisma, "producto", input) };
      } catch (error) {
        return { text: alTexto(error), isError: true };
      }
    },
  },
  {
    name: "ventas_por_ciudad",
    description: "Ranking de venta neta por ciudad con participacion, para un periodo y filtros opcionales.",
    inputSchema: {
      ...filtrosJsonSchema,
      properties: { ...filtrosJsonSchema.properties, limite: { type: "number", description: "Maximo de filas (default 10, maximo 50)." } },
    },
    handler: async (args) => {
      try {
        const schema = filtrosSchema.extend({ limite: z.number().optional() });
        const input = schema.parse(args);
        return { text: await rankingVentas(prisma, "ciudad", input) };
      } catch (error) {
        return { text: alTexto(error), isError: true };
      }
    },
  },
  {
    name: "comparar_periodos",
    description:
      "Compara dos periodos de fechas (venta neta, facturas, ticket) e indica la variacion. Requiere periodo1_desde/hasta y periodo2_desde/hasta.",
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
  "Herramientas: resumen_ventas, ventas_por_periodo, ventas_por_vendedor,",
  "ventas_por_producto, ventas_por_ciudad, comparar_periodos.",
  "Los montos estan en quetzales.",
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
