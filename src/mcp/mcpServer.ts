import readline from "node:readline";

/**
 * Servidor MCP minimo sobre stdio (JSON-RPC 2.0, una linea por mensaje).
 *
 * Implementa solo el subconjunto que `codex app-server` necesita para
 * exponer herramientas a un thread:
 *
 * - `initialize` + `notifications/initialized` (handshake).
 * - `ping` (health check del cliente).
 * - `tools/list` (catalogo de herramientas con su inputSchema).
 * - `tools/call` (ejecuta una herramienta y devuelve contenido de texto).
 *
 * No declara resources ni prompts; los requests desconocidos devuelven
 * `-32601 Method not found` y las notificaciones se ignoran. Todo corre en
 * esta misma computadora: sin OAuth, sin bearer tokens, sin red.
 *
 * Decision (Etapa 6): se implementa a mano, como el cliente JSON-RPC de
 * `src/chat/jsonrpc.ts`, en lugar de arrastrar `@modelcontextprotocol/sdk`:
 * la superficie usada es pequena y el transporte ya esta probado en el repo.
 */

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface McpToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft-07) de los argumentos. Se mantiene alineado con el
   * schema zod que valida en el handler. */
  inputSchema: Record<string, unknown>;
  /** Ejecuta la herramienta. El resultado siempre es contenido de texto. */
  handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  /** Instrucciones que Codex lee como guia del servidor completo. */
  instructions: string;
  tools: McpToolDefinition[];
  /** Logger opcional (stderr). */
  logger?: (message: string) => void;
}

interface McpRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Traduce un error de validacion/consulta a un mensaje legible. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Inicia el servidor MCP sobre stdio y devuelve un controlador para cerrarlo.
 * Los handlers de herramientas se ejecutan de a uno (serializados): el
 * protocolo no exige concurrencia para este subconjunto.
 */
export function startMcpServer(options: McpServerOptions): { close(): void } {
  const { name, version, instructions, tools, logger } = options;
  const log = (message: string) => logger?.(message);

  let closed = false;

  const send = (message: unknown) => {
    if (closed) return;
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const sendResult = (id: number | string, result: unknown) => {
    send({ jsonrpc: "2.0", id, result });
  };

  const sendError = (id: number | string, code: number, message: string) => {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const handleRequest = async (request: McpRequest): Promise<void> => {
    const { id, method, params } = request;

    switch (method) {
      case "initialize":
        sendResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name, version },
          instructions,
        });
        return;

      case "ping":
        sendResult(id, {});
        return;

      case "tools/list":
        sendResult(id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
        return;

      case "tools/call": {
        const toolName = typeof params?.name === "string" ? params.name : "";
        const tool = tools.find((candidate) => candidate.name === toolName);
        if (!tool) {
          sendError(id, -32602, `La herramienta "${toolName}" no existe.`);
          return;
        }
        const args = isRecord(params?.arguments) ? params.arguments : {};
        const inicio = Date.now();
        log(`tools/call "${toolName}" recibida`);
        try {
          const result = await tool.handler(args);
          log(`tools/call "${toolName}" respondida en ${Date.now() - inicio}ms`);
          sendResult(id, {
            content: [{ type: "text", text: result.text }],
            isError: result.isError === true,
          });
        } catch (error) {
          log(`tools/call "${toolName}" fallo: ${messageOf(error)}`);
          sendResult(id, {
            content: [{ type: "text", text: `Error ejecutando "${toolName}": ${messageOf(error)}` }],
            isError: true,
          });
        }
        return;
      }

      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      log("linea no JSON ignorada");
      return;
    }
    if (!isRecord(message)) return;

    // Notificaciones (sin id) no llevan respuesta.
    if (message["id"] === undefined || message["id"] === null) {
      if (message["method"] === "notifications/initialized") log("cliente inicializado");
      return;
    }
    if (typeof message["method"] !== "string") return;

    const request = message as unknown as McpRequest;
    void handleRequest(request);
  };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", handleLine);
  rl.on("close", () => {
    closed = true;
  });

  process.on("SIGINT", () => {
    closed = true;
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    closed = true;
    process.exit(0);
  });

  log(`MCP "${name}" v${version} listo sobre stdio (${tools.length} herramientas)`);

  return {
    close() {
      closed = true;
      rl.close();
    },
  };
}
