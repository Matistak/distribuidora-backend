import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { appDataDir, backupDir, ensureDataDirs, isPackaged } from "./lib/appPaths.js";

/**
 * Backups semanales de la base local (Etapa 8).
 *
 * La DB guarda el historial de conversaciones del chat y los datos de ventas;
 * una vez por semana se hace una copia consistente con `VACUUM INTO`
 * (funciona aunque SQLite este en modo WAL). Se conserva una sola copia: al
 * crear el backup de la semana nueva se elimina el anterior.
 *
 * En desarrollo el backup cae en `prisma/backups/`; en la app empaquetada en
 * `<datos>/backups/`. El backup no toca `src-tauri/resources`.
 */

const MAX_BACKUPS = 1;

/** Clave de la semana ISO actual (p. ej. `2026-W33`). */
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** DB actual y directorio de backups segun el modo de ejecucion. */
export function backupPaths(): { dbPath: string; backupsDir: string } {
  if (isPackaged()) {
    ensureDataDirs();
    return { dbPath: join(appDataDir(), "distribuidora.db"), backupsDir: backupDir() };
  }
  // En desarrollo (tsx) el modulo vive en src/; compilado, en dist/.
  const projectDir = dirname(import.meta.dirname);
  const prismaDir = join(projectDir, "prisma");
  return { dbPath: join(prismaDir, "distribuidora.db"), backupsDir: join(prismaDir, "backups") };
}

/**
 * Crea el backup de la semana si todavia no existe y poda los viejos
 * (se conserva una sola copia). Devuelve la ruta del backup creado, o
 * `null` si no aplico.
 */
export async function runWeeklyBackup(prisma: PrismaClient): Promise<string | null> {
  try {
    const { dbPath, backupsDir } = backupPaths();
    if (!existsSync(dbPath)) return null;

    const target = join(backupsDir, `distribuidora-${isoWeekKey(new Date())}.db`);
    if (existsSync(target)) {
      pruneBackups(backupsDir);
      return null;
    }

    mkdirSync(backupsDir, { recursive: true });
    // VACUUM INTO produce una copia consistente aun con WAL activo.
    const escaped = target.replace(/'/g, "''");
    await prisma.$executeRawUnsafe(`VACUUM INTO '${escaped}'`);
    console.log(`Backup semanal creado: ${target}`);
    pruneBackups(backupsDir);
    return target;
  } catch (error) {
    console.warn("No se pudo crear el backup semanal:", error);
    return null;
  }
}

/** Elimina los backups mas viejos que `MAX_BACKUPS`. */
function pruneBackups(backupsDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(backupsDir);
  } catch {
    return;
  }
  const backups = entries
    .filter((f) => f.startsWith("distribuidora-") && f.endsWith(".db"))
    .map((f) => ({ name: f, path: join(backupsDir, f), mtime: statSync(join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of backups.slice(MAX_BACKUPS)) {
    try {
      rmSync(old.path);
      console.log(`Backup antiguo eliminado: ${old.name}`);
    } catch {
      // el archivo pudo desaparecer entre la lista y el borrado
    }
  }
}
