import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
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

const dbSrc = join(root, "prisma", "distribuidora.db");
if (existsSync(dbSrc)) {
  copyFileSync(dbSrc, join(distDir, "distribuidora.db"));
  console.log("✓ Copiada DB semilla distribuidora.db");
} else {
  console.warn(
    "✗ prisma/distribuidora.db no existe. Corre `npx prisma db push` antes de empaquetar.",
  );
}

console.log("\nAssets copiados a", distDir);
