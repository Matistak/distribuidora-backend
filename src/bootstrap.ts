import { copyFileSync, existsSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  appDataDir,
  ensureDataDirs,
  findResource,
  isPackaged,
  resolvePrismaEnv,
} from "./lib/appPaths.js";

/**
 * Etapa 8: verifica que una DB existente sea utilizable. Una base corrupta
 * (p. ej. un archivo creado a mano, sin las tablas core, o un backup mal
 * restaurado) hace que la aplicacion arranque sin schema. Se mueve a un lado
 * y se re-siembra desde la semilla incluida en el instalador. Una DB con el
 * schema pero sin datos es VALIDA (la app del cliente arranca vacia).
 */
function dbTieneTablasCore(dbPath: string): boolean {
  const sqlite = (globalThis as { Bun?: { sqlite?: unknown } }).Bun?.sqlite as
    | ((path: string, opts?: { readonly?: boolean }) => {
        query: (sql: string) => { get: () => Record<string, unknown> | null };
        close: () => void;
      })
    | undefined;
  if (sqlite) {
    try {
      const db = sqlite(dbPath, { readonly: true });
      const row = db
        .query(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('Venta','Carga')",
        )
        .get();
      db.close();
      return row?.n === 2;
    } catch {
      // se continua con el fallback por tamano
    }
  }
  // Fallback heuristico sin driver: la semilla empaquetada es una DB con
  // schema pero SIN datos (pequena), asi que solo se considera invalido un
  // archivo vacio (0 bytes) o ilegible.
  try {
    return statSync(dbPath).size > 0;
  } catch {
    return true;
  }
}

export function bootstrap() {
  if (!isPackaged()) {
    // Prisma no carga .env en tiempo de ejecucion; usa la DB local como fallback.
    // En desarrollo (tsx) el modulo vive en src/; compilado, en dist/.
    const projectDir = dirname(import.meta.dirname);
    process.env["DATABASE_URL"] ||= `file:${join(projectDir, "prisma", "distribuidora.db")}`;
    return;
  }

  ensureDataDirs();

  const dbPath = join(appDataDir(), "distribuidora.db");
  const seed = findResource((f) => f === "distribuidora.db");

  if (existsSync(dbPath) && !dbTieneTablasCore(dbPath)) {
    const corrupt = `${dbPath}.corrupt-${Date.now()}`;
    try {
      renameSync(dbPath, corrupt);
      console.warn(`DB local sin tablas core; movida a ${corrupt} y se re-sembrara.`);
    } catch (error) {
      console.warn("No se pudo mover la DB local invalida:", error);
    }
  }

  if (!existsSync(dbPath)) {
    if (seed) {
      copyFileSync(seed, dbPath);
      console.log(`DB inicializada desde la semilla en ${dbPath}`);
    } else {
      console.warn("No se encontro la DB semilla; Prisma creara una vacia sin tablas.");
    }
  }

  resolvePrismaEnv();
}
