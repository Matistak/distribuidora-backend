/**
 * Prueba del MCP de ventas standalone (Etapa 6).
 *
 * Inicia el servidor MCP como proceso separado y ejecuta el handshake,
 * `tools/list` y varias llamadas reales a la base local (con datos, sin
 * datos y con argumentos invalidos).
 *
 * Uso: npx tsx scripts/test-mcp.ts
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = join(raiz, "src", "mcp", "ventasMcpServer.ts");

interface Response {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

const rl = readline.createInterface({ input: child.stdout });
const pending = new Map<number, (response: Response) => void>();
let nextId = 1;

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[mcp] ${chunk}`);
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line) as Response;
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)!(message);
    pending.delete(message.id);
  }
});

function request(method: string, params?: unknown): Promise<Response> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const payload = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

const mostrar = (titulo: string, response: Response, extra = ""): void => {
  if (response.error) {
    console.log(`\n== ${titulo} ==\nERROR: ${response.error.code} ${response.error.message}${extra}`);
    return;
  }
  const result = response.result as { content?: Array<{ text: string }>; tools?: unknown } | undefined;
  if (result && "content" in result) {
    const text = (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
    console.log(`\n== ${titulo} ==\n${text}${extra}`);
    return;
  }
  console.log(`\n== ${titulo} ==\n${JSON.stringify(response.result, null, 2)}${extra}`);
};

try {
  mostrar("initialize", await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-mcp", version: "0.0.1" },
  }));

  await request("notifications/initialized");

  mostrar("tools/list", await request("tools/list"));

  mostrar(
    "resumen_ventas 2026-07 (datos reales)",
    await request("tools/call", {
      name: "resumen_ventas",
      arguments: { desde: "2026-07-01", hasta: "2026-07-15" },
    }),
  );

  mostrar(
    "ventas_por_vendedor 2026-07 limite 3",
    await request("tools/call", {
      name: "ventas_por_vendedor",
      arguments: { desde: "2026-07-01", hasta: "2026-07-15", limite: 3 },
    }),
  );

  mostrar(
    "ventas_por_periodo por mes",
    await request("tools/call", {
      name: "ventas_por_periodo",
      arguments: { desde: "2026-06-01", hasta: "2026-07-31", granularidad: "mes" },
    }),
  );

  mostrar(
    "resumen_ventas sin datos (2025-01)",
    await request("tools/call", {
      name: "resumen_ventas",
      arguments: { desde: "2025-01-01", hasta: "2025-01-31" },
    }),
  );

  mostrar(
    "resumen_ventas fecha invalida",
    await request("tools/call", {
      name: "resumen_ventas",
      arguments: { desde: "01/07/2026" },
    }),
  );

  mostrar(
    "ventas_por_periodo granularidad invalida",
    await request("tools/call", {
      name: "ventas_por_periodo",
      arguments: { granularidad: "semana" },
    }),
  );

  mostrar(
    "herramienta inexistente",
    await request("tools/call", {
      name: "borrar_todo",
      arguments: {},
    }),
  );
} finally {
  child.kill("SIGTERM");
}
