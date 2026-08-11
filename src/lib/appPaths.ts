import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Rutas de la aplicacion compartidas entre el backend y el MCP de ventas
 * (Etapa 8). En desarrollo todo vive dentro del repo; en la app empaquetada
 * (Tauri) la base de datos y los backups viven en el directorio de datos de
 * la aplicacion y el engine de Prisma se busca junto al ejecutable.
 *
 * La regla de Fase 0 se mantiene: `src-tauri/resources` es solo la semilla;
 * nunca es la base activa.
 */

export const APP_ID = "com.distribuidora.app";

/** Directorio de datos de la aplicacion (por plataforma). */
export function appDataDir(): string {
  if (process.platform === "win32") {
    const base = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    return join(base, APP_ID);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_ID);
  }
  const base = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
  return join(base, APP_ID);
}

/** Directorio de backups dentro del directorio de datos. */
export function backupDir(): string {
  return join(appDataDir(), "backups");
}

export function ensureDataDirs(): { dataDir: string; backupsDir: string } {
  const dataDir = appDataDir();
  const backups = backupDir();
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backups, { recursive: true });
  return { dataDir, backupsDir: backups };
}

/**
 * `true` cuando el codigo corre dentro de un binario compilado con
 * `bun build --compile` (los modulos viven en un filesystem embebido).
 */
export function isPackaged(): boolean {
  const dir = import.meta.dirname ?? "";
  return dir.includes("$bunfs") || dir.includes("~BUN");
}

/** Directorios donde Tauri coloca los resources junto al ejecutable. */
export function resourceDirs(): string[] {
  const execDir = dirname(process.execPath);
  return [
    execDir,
    join(execDir, "resources"),
    join(execDir, "..", "Resources"),
    join(execDir, "..", "Resources", "resources"),
  ].filter((d) => existsSync(d));
}

/** Busca un recurso (engine de Prisma, DB semilla) junto al ejecutable. */
export function findResource(predicate: (name: string) => boolean): string {
  for (const d of resourceDirs()) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    const match = entries.find(predicate);
    if (match) return join(d, match);
  }
  return "";
}

/** Ruta al engine nativo de Prisma si esta disponible junto al ejecutable. */
export function prismaEnginePath(): string {
  return findResource(
    (f) => f.startsWith("libquery_engine-") || f.startsWith("query_engine-"),
  );
}

/**
 * Configura el entorno para Prisma (DATABASE_URL y engine) cuando el codigo
 * corre empaquetado. Devuelve la ruta a la DB local.
 */
export function resolvePrismaEnv(): string {
  const dataDir = appDataDir();
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "distribuidora.db");

  if (process.env["PRISMA_QUERY_ENGINE_LIBRARY"] === undefined) {
    const enginePath = prismaEnginePath();
    if (enginePath) {
      process.env["PRISMA_QUERY_ENGINE_LIBRARY"] = enginePath;
    } else {
      console.warn("No se encontro el engine de Prisma junto al ejecutable.");
    }
  }

  process.env["DATABASE_URL"] = `file:${dbPath}`;
  return dbPath;
}
