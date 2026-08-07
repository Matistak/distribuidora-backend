import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const APP_ID = "com.distribuidora.app";

export function bootstrap() {
  const dir = import.meta.dirname ?? "";
  const isCompiled = dir.includes("$bunfs") || dir.includes("~BUN");

  if (!isCompiled) return;

  const execDir = dirname(process.execPath);

  const resourceDirs = [
    execDir,
    join(execDir, "resources"),
    join(execDir, "..", "Resources"),
    join(execDir, "..", "Resources", "resources"),
  ].filter((d) => existsSync(d));

  const findResource = (predicate: (name: string) => boolean): string => {
    for (const d of resourceDirs) {
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
  };

  const dataDir = appDataDir();
  mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, "distribuidora.db");
  if (!existsSync(dbPath)) {
    const seed = findResource((f) => f === "distribuidora.db");
    if (seed) {
      copyFileSync(seed, dbPath);
      console.log(`DB inicializada desde la semilla en ${dbPath}`);
    } else {
      console.warn("No se encontro la DB semilla; Prisma creara una vacia sin tablas.");
    }
  }
  process.env["DATABASE_URL"] = `file:${dbPath}`;

  const enginePath = findResource(
    (f) => f.startsWith("libquery_engine-") || f.startsWith("query_engine-"),
  );
  if (enginePath && process.env["PRISMA_QUERY_ENGINE_LIBRARY"] === undefined) {
    process.env["PRISMA_QUERY_ENGINE_LIBRARY"] = enginePath;
  } else if (!enginePath) {
    console.warn("No se encontro el engine de Prisma junto al ejecutable.");
  }
}

function appDataDir(): string {
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
