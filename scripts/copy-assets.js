import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const distDir = join(root, "dist");

const prismaClientDir = join(root, "node_modules", ".prisma", "client");

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

const schemaSrc = join(prismaClientDir, "schema.prisma");
const schemaDst = join(distDir, "schema.prisma");
if (existsSync(schemaSrc)) {
  copyFileSync(schemaSrc, schemaDst);
  console.log("✓ Copiado schema.prisma");
} else {
  console.warn("✗ schema.prisma no encontrado en", schemaSrc);
}

const engines = readdirSync(prismaClientDir).filter(
  (f) => f.startsWith("libquery_engine-") || f.startsWith("query_engine-"),
);
if (engines.length === 0) {
  console.warn("✗ No se encontro ningun engine de Prisma. Corriste `npx prisma generate`?");
}
for (const engine of engines) {
  copyFileSync(join(prismaClientDir, engine), join(distDir, engine));
  console.log("✓ Copiado", engine);
}

/**
 * Genera la DB semilla VACIA (solo schema) para el instalador: la app del
 * cliente debe arrancar sin datos y recibir su propio Excel por "Cargar
 * Excel". La DB de desarrollo (`prisma/distribuidora.db`) queda fuera del
 * empaquetado.
 */
function generarSeedVacia() {
  const tempSeed = join(root, "prisma", ".seed-vacia.db");
  const schemaPath = join(root, "prisma", "schema.prisma");
  rmSync(tempSeed, { force: true });

  try {
    // SQLite con ruta absoluta: en Windows se usan barras normales.
    const dbUrl = `file:${tempSeed.replace(/\\/g, "/")}`;
    execFileSync(
      "npx",
      ["prisma", "db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: "inherit",
      },
    );
    copyFileSync(tempSeed, join(distDir, "distribuidora.db"));
    console.log("✓ Generada DB semilla VACIA (solo schema) como distribuidora.db");

    // La app de Tauri empaqueta la semilla como recurso. Al regenerarla en cada
    // build nos aseguramos de que el bundle arranque siempre con tablas vacías y
    // el schema actualizado, sin depender de un archivo .db versionado en git.
    const frontResourcesDir = join(root, "..", "distribuidora-front", "src-tauri", "resources");
    if (existsSync(frontResourcesDir)) {
      copyFileSync(tempSeed, join(frontResourcesDir, "distribuidora.db"));
      console.log("✓ Copiada semilla vacía a distribuidora-front/src-tauri/resources/distribuidora.db");
    }
  } catch (error) {
    console.warn("✗ No se pudo generar la DB semilla vacia:", error);
  } finally {
    rmSync(tempSeed, { force: true });
  }
}

generarSeedVacia();

console.log("\nAssets copiados a", distDir);
