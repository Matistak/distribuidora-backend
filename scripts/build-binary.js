import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

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
const output = join(root, "dist", `distribuidora-backend${ext}`);

console.log(`Compilando binario para ${target}...`);

try {
  execFileSync(
    "bun",
    ["build", "--compile", `--target=${target}`, "dist/server.js", "--outfile", output],
    { cwd: root, stdio: "inherit" },
  );
} catch (err) {
  if (err.code === "ENOENT") {
    console.error("\nNo se encontro `bun`. Instalalo con: curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  }
  throw err;
}

console.log(`Binario generado: ${output}`);
