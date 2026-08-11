import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Configuracion del MCP de ventas para `codex app-server` (Etapa 6).
 *
 * `app-server` lee su configuracion de `~/.codex/config.toml` y admite
 * sobrescribir valores por llave con `-c key=value` (el valor se parsea como
 * TOML). Con eso se registra el servidor MCP local sin tocar el config del
 * usuario:
 *
 *   mcp_servers.ventas.command = "<node>"
 *   mcp_servers.ventas.args = ["<entrypoint>"]
 *   mcp_servers.ventas.default_tools_approval_mode = "auto"
 *   mcp_servers.ventas.tool_timeout_sec = 45
 *
 * El MCP corre por stdio como proceso local, como definio la Fase 0: sin
 * OAuth, sin bearer tokens y sin exponer un listener en la red.
 *
 * El comando se resuelve asi:
 * 1. `VENTAS_MCP_CMD` + `VENTAS_MCP_ARGS` (JSON) si el usuario los define.
 * 2. Si existe `dist/mcp/ventasMcpServer.js` (backend compilado), se usa
 *    `node` con esa entrada.
 * 3. En desarrollo se usa el node actual con `--import tsx` sobre la entrada
 *    TypeScript (tsx esta en las dependencias del backend).
 */

export interface VentasMcpConfig {
  command: string;
  args: string[];
  cwd?: string;
}

/** Raiz del backend tanto desde `src/` como desde `dist/`. */
function raizBackend(): string {
  return dirname(dirname(import.meta.dirname));
}

/** Devuelve el comando con el que `app-server` iniciara el MCP de ventas. */
export function resolveVentasMcpConfig(): VentasMcpConfig {
  const raiz = raizBackend();

  const overrideCommand = process.env["VENTAS_MCP_CMD"]?.trim();
  if (overrideCommand) {
    const overrideArgsRaw = process.env["VENTAS_MCP_ARGS"]?.trim();
    let overrideArgs: string[] = [];
    if (overrideArgsRaw) {
      try {
        const parsed: unknown = JSON.parse(overrideArgsRaw);
        overrideArgs = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        console.warn("[mcp-ventas] VENTAS_MCP_ARGS no es un JSON valido; se ignora.");
      }
    }
    return { command: overrideCommand, args: overrideArgs };
  }

  const compilado = join(raiz, "dist", "mcp", "ventasMcpServer.js");
  if (existsSync(compilado)) {
    return { command: process.execPath, args: [compilado] };
  }

  const fuente = join(raiz, "src", "mcp", "ventasMcpServer.ts");
  return {
    command: process.execPath,
    args: ["--import", "tsx", fuente],
    cwd: raiz,
  };
}

/** Valor TOML string: compatible con JSON escaping para rutas sin saltos. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Argumentos extra para `codex app-server` que registran el MCP de ventas.
 * Se agregan a los `extraArgs` de `CodexService` en `routes/chat.ts`.
 */
export function ventasMcpLaunchArgs(): string[] {
  const config = resolveVentasMcpConfig();

  const args = [
    "-c",
    `mcp_servers.ventas.command=${tomlString(config.command)}`,
    "-c",
    `mcp_servers.ventas.args=[${config.args.map(tomlString).join(", ")}]`,
    // Herramientas de solo lectura: no requieren aprobaciones en el chat.
    "-c",
    'mcp_servers.ventas.default_tools_approval_mode="auto"',
    // Tope por llamada a herramienta (limite de tiempos de ejecucion).
    "-c",
    "mcp_servers.ventas.tool_timeout_sec=45",
  ];
  if (config.cwd) {
    args.push("-c", `mcp_servers.ventas.cwd=${tomlString(config.cwd)}`);
  }
  return args;
}

/** Informacion expuesta por `GET /api/chat/status` para depuracion. */
export function ventasMcpInfo(): {
  server: string;
  configured: boolean;
  command: string;
  args: string[];
} {
  const config = resolveVentasMcpConfig();
  return {
    server: "ventas",
    configured: true,
    command: config.command,
    args: config.args,
  };
}
