import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

/**
 * `bun build --compile` deja artefactos temporales `<hash>.bun-build` en el
 * directorio de trabajo; se borran antes y despues de compilar para no
 * ensuciar el proyecto.
 */
function cleanBunBuildArtifacts() {
  for (const entry of readdirSync(root)) {
    if (entry.endsWith(".bun-build")) {
      try {
        rmSync(join(root, entry), { force: true, recursive: true });
      } catch {
        // el archivo pudo desaparecer entre la lista y el borrado
      }
    }
  }
}

const TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "win32-x64": "bun-windows-x64",
};

const key = `${process.platform}-${process.arch}`;
const target = TARGETS[key];

if (!target) {
  console.error(`Plataforma no soportada: ${key}`);
  process.exit(1);
}

const ext = process.platform === "win32" ? ".exe" : "";

// Binario principal (sidecar de Tauri) + binario del MCP de ventas (Etapa 8).
// El MCP se compila aparte para que la app empaquetada no dependa de Node:
// `codex app-server` lo inicia como proceso stdio propio.
const BUILDS = [
  { entry: "dist/server.js", out: join(root, "dist", `distribuidora-backend${ext}`) },
  { entry: "dist/mcp/ventasMcpServer.js", out: join(root, "dist", `distribuidora-ventas-mcp${ext}`) },
];

for (const { entry, out } of BUILDS) {
  cleanBunBuildArtifacts();
  console.log(`Compilando ${entry} para ${target}...`);
  try {
    execFileSync("bun", ["build", "--compile", `--target=${target}`, entry, "--outfile", out], {
      cwd: root,
      stdio: "inherit",
    });
  } catch (err) {
    cleanBunBuildArtifacts();
    if (err.code === "ENOENT") {
      console.error("\nNo se encontro `bun`. Instalalo con: curl -fsSL https://bun.sh/install | bash");
      process.exit(1);
    }
    throw err;
  }
  cleanBunBuildArtifacts();
  console.log(`Binario generado: ${out}`);
}

console.log("\nListo: sidecar principal y MCP de ventas compilados.");
