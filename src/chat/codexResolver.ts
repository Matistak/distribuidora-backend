import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

/**
 * Resolucion de la instalacion de Codex CLI (Etapa 8).
 *
 * En la app empaquetada (Tauri) el proceso no hereda el PATH de una terminal:
 * en macOS un app lanzado desde Finder tiene un PATH minimo, y en Windows el
 * PATH heredado suele incluir al usuario pero conviene no depender de el.
 *
 * El orden de resolucion es:
 * 1. `CODEX_CLI_COMMAND` si el usuario lo define (ruta o nombre).
 * 2. El binario `codex` en PATH.
 * 3. Rutas conocidas por plataforma (Homebrew, npm global, scoop, winget).
 *
 * En Windows, la instalacion via npm deja `codex.cmd` (un shim que llama a
 * `node <cli.js>`). Node no puede ejecutar `.cmd` directamente, asi que el
 * shim se traduce a `node <cli.js>` y el proceso se lanza sin shell.
 */

export interface ResolvedCodex {
  /** Ruta absoluta al ejecutable (codex, node o codex.exe). */
  command: string;
  /** Argumentos fijos que preceden a `app-server` (p. ej. el cli.js de npm). */
  prefixArgs: string[];
  /** De donde salio la resolucion (para el status). */
  source: "env" | "path" | "known" | "shim";
  /** Ruta legible para mostrar en logs/status. */
  display: string;
}

/** Extensiones ejecutables de Windows (PATHEXT tipico). */
const WINDOWS_EXTS = [".exe", ".cmd", ".bat"];

/** Directorios conocidos por plataforma donde suele vivir `codex`. */
function knownCandidates(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
    const localAppData = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    return [
      join(appData, "npm", "codex.cmd"),
      join(home, "scoop", "shims", "codex.exe"),
      join(localAppData, "Microsoft", "WinGet", "Links", "codex.exe"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      join(home, ".local", "bin", "codex"),
      join(home, "bin", "codex"),
    ];
  }
  return [
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    join(home, ".local", "bin", "codex"),
    join(home, "bin", "codex"),
  ];
}

/** Busca un ejecutable por nombre en PATH (sin shell). */
function which(name: string): string | null {
  const pathVar = process.env["PATH"] ?? "";
  const dirs = pathVar.split(process.platform === "win32" ? ";" : ":");
  for (const dir of dirs) {
    if (!dir) continue;
    const base = join(dir, name);
    if (existsSync(base)) return base;
    if (process.platform === "win32") {
      for (const ext of WINDOWS_EXTS) {
        const withExt = `${base}${ext}`;
        if (existsSync(withExt)) return withExt;
      }
    }
  }
  return null;
}

/** `where codex` en Windows (busca con PATHEXT). */
function whereOnWindows(name: string): string | null {
  try {
    const out = execFileSync("where", [name], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

/** Node.exe en rutas conocidas de Windows (npm instala codex como shim de node). */
function findNodeOnWindows(): string | null {
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  const candidates = [
    join(programFiles, "nodejs", "node.exe"),
    join(programFilesX86, "nodejs", "node.exe"),
    join(localAppData, "Programs", "nodejs", "node.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const fromPath = which("node.exe");
  return fromPath ?? null;
}

/** Ruta al `cli.js` que ejecuta un shim `.cmd`/`.bat` de npm, o `null`. */
function npmShimJsPath(shimPath: string): string | null {
  let content: string;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const match =
    content.match(/"%~?dp0\\([^"]*\.js)"/i) ??
    content.match(/"(?:%dp0%|%~dp0)\\([^"]*\.js)"/i);
  if (!match) return null;
  const jsPath = join(dirname(shimPath), match[1].replace(/\//g, sep));
  return existsSync(jsPath) ? jsPath : null;
}

/**
 * Traduce un shim `.cmd`/`.bat` de npm (p. ej. `codex.cmd`) a
 * `node <cli.js>` para poder lanzarlo sin shell.
 */
function shimToNodeJs(shimPath: string): ResolvedCodex | null {
  const jsPath = npmShimJsPath(shimPath);
  if (!jsPath) return null;
  const node = findNodeOnWindows();
  if (!node) return null;
  return {
    command: node,
    prefixArgs: [jsPath],
    source: "shim",
    display: `${node} ${jsPath}`,
  };
}

/**
 * Paquetes de plataforma y triples de la instalacion npm de Codex. El CLI
 * npm (`codex.js`) es un wrapper de node que lanza un binario nativo en
 * `vendor/<triple>/bin/codex`; aca se replica esa logica para ejecutar el
 * binario nativo directamente y no depender de node en el PATH (Etapa 8:
 * la app empaquetada se lanza desde Finder y no hereda el PATH de la terminal).
 */
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function codexTargetTriple(): string | null {
  const arch = process.arch;
  switch (process.platform) {
    case "darwin":
      return arch === "arm64"
        ? "aarch64-apple-darwin"
        : arch === "x64"
          ? "x86_64-apple-darwin"
          : null;
    case "win32":
      return arch === "arm64"
        ? "aarch64-pc-windows-msvc"
        : arch === "x64"
          ? "x86_64-pc-windows-msvc"
          : null;
    case "linux":
      return arch === "arm64"
        ? "aarch64-unknown-linux-musl"
        : arch === "x64"
          ? "x86_64-unknown-linux-musl"
          : null;
    default:
      return null;
  }
}

/**
 * Dado el `codex.js` de la instalacion npm, busca el binario nativo que el
 * paquete de plataforma incluye. Devuelve su ruta o `null`.
 */
function nativeCodexFromJs(jsPath: string): string | null {
  const triple = codexTargetTriple();
  if (!triple) return null;
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[triple];
  const exeName = process.platform === "win32" ? "codex.exe" : "codex";
  const pkgRoot = dirname(dirname(jsPath));

  const candidateRoots = [
    join(pkgRoot, "node_modules", platformPackage),
    join(dirname(pkgRoot), platformPackage),
    join(pkgRoot, "..", platformPackage),
  ];
  for (const root of candidateRoots) {
    const candidate = join(root, "vendor", triple, "bin", exeName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Normaliza un comando ya resuelto (ruta absoluta o nombre en PATH). */
function normalize(command: string): ResolvedCodex | null {
  const isPath = command.includes("/") || command.includes("\\") || existsSync(command);

  const resolveName = (): string | null => {
    if (process.platform !== "win32") return which(command);
    return whereOnWindows(command) ?? which(command);
  };

  let resolved: string | null = isPath ? command : resolveName();
  if (!resolved) return null;

  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    // Shim de npm: primero se busca el binario nativo (codex.exe); si no,
    // se traduce a `node <cli.js>`.
    const shimJs = npmShimJsPath(resolved);
    if (shimJs) {
      const native = nativeCodexFromJs(shimJs);
      if (native) {
        return { command: native, prefixArgs: [], source: "shim", display: native };
      }
    }
    const shim = shimToNodeJs(resolved);
    if (shim) return shim;
    return {
      command: resolved,
      prefixArgs: [],
      source: "known",
      display: resolved,
    };
  }

  // En macOS/Linux el npm global instala un symlink a `bin/codex.js` (un
  // wrapper de node). Se resuelve al binario nativo para no depender de
  // node en el PATH de la app empaquetada.
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    // la ruta puede no existir aun; se continua con la original
  }
  if (!real.endsWith(".js") && basename(real) !== "codex.js") {
    return {
      command: resolved,
      prefixArgs: [],
      source: isPath ? "env" : "path",
      display: resolved,
    };
  }
  const native = nativeCodexFromJs(real);
  if (native) {
    return { command: native, prefixArgs: [], source: "shim", display: native };
  }
  return {
    command: resolved,
    prefixArgs: [],
    source: isPath ? "env" : "path",
    display: resolved,
  };
}

/**
 * Resuelve el comando de Codex para este equipo. Devuelve `null` si no hay
 * ninguna instalacion detectable. `override` (si viene) tiene prioridad
 * sobre `CODEX_CLI_COMMAND` y es estricto: si no se encuentra, no se cae a
 * las rutas conocidas (asi se puede simular "no instalado" y el usuario
 * puede forzar un comando especifico).
 */
export function resolveCodexCommand(override?: string): ResolvedCodex | null {
  const explicit = (override ?? process.env["CODEX_CLI_COMMAND"])?.trim();
  if (explicit) {
    // Override estricto: si no se resuelve, no se prueban rutas conocidas
    // (permite simular "no instalado" y forzar un comando especifico).
    return normalize(explicit);
  }

  const inPath = normalize("codex");
  if (inPath) return inPath;

  for (const candidate of knownCandidates()) {
    if (!existsSync(candidate)) continue;
    // Se normaliza cada candidato: resuelve symlinks y el binario nativo
    // de la instalacion npm (que es un wrapper de node).
    const normalized = normalize(candidate);
    if (normalized) return normalized;
  }

  return null;
}

/** Directorio de configuracion de Codex (`CODEX_HOME` o `~/.codex`). */
export function resolveCodexHome(): string {
  const explicit = process.env["CODEX_HOME"]?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".codex");
}

/** Ruta al archivo de autenticacion de Codex (no se lee su contenido). */
export function codexAuthPath(): string {
  return join(resolveCodexHome(), "auth.json");
}

/** Informacion sobre la configuracion de Codex para `/api/chat/status`. */
export function codexHomeInfo(): {
  path: string;
  fromEnv: boolean;
  authExists: boolean;
} {
  return {
    path: resolveCodexHome(),
    fromEnv: Boolean(process.env["CODEX_HOME"]?.trim()),
    authExists: existsSync(codexAuthPath()),
  };
}
