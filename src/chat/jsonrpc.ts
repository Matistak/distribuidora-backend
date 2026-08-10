import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { EventEmitter } from "node:events";

/**
 * Cliente JSON-RPC minimo para `codex app-server` sobre stdio (JSONL).
 *
 * Encapsula el transporte: escribe requests en stdin, correlaciona
 * respuestas por `id` y publica las notificaciones de la app-server.
 * No conoce el protocolo de Codex: solo el shape JSON-RPC.
 */

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorShape, readonly method: string) {
    super(`JSON-RPC ${method} fallo (${error.code}): ${error.message}`);
    this.name = "JsonRpcRequestError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class CodexTransportError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "CodexTransportError";
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexProcessOptions {
  /** Comando para localizar el binario (por defecto `codex` en PATH). */
  command?: string;
  /** Argumentos extra pasados a `codex app-server` (por ejemplo `--config`). */
  extraArgs?: string[];
  /** Variables de entorno para el proceso (se fusionan con process.env). */
  env?: NodeJS.ProcessEnv;
  /** Directorio de trabajo del proceso. */
  cwd?: string;
  /** Timeout por request JSON-RPC en ms. */
  requestTimeoutMs?: number;
  /** Grace period antes de SIGKILL al cerrar. */
  killTimeoutMs?: number;
}

export interface CodexProcessHandle {
  readonly pid: number | undefined;
  readonly running: boolean;
  /** Inicia el proceso y espera la primera lectura de stdout. */
  start(): Promise<void>;
  /** Envia un request JSON-RPC y resuelve con `result`. */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Envia una notificacion JSON-RPC (sin id, sin respuesta esperada). */
  notify(method: string, params?: unknown): Promise<void>;
  /** Cierra el proceso (SIGTERM, luego SIGKILL) y espera la salida. */
  close(): Promise<void>;
  /** `true` si el proceso termino de forma inesperada desde la ultima comprobacion. */
  checkHealth(): boolean;
  /** Suscribirse a notificaciones JSON-RPC. */
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  /** Suscribirse a la terminacion del proceso. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
}

export function createCodexProcess(options: CodexProcessOptions = {}): CodexProcessHandle {
  const {
    command = "codex",
    extraArgs = [],
    env = {},
    cwd,
    requestTimeoutMs = 30_000,
    killTimeoutMs = 3_000,
  } = options;

  const emitter = new EventEmitter();
  let child: ChildProcessWithoutNullStreams | null = null;
  let pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let buffer = "";
  let startPromise: Promise<void> | null = null;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let manuallyClosed = false;

  const emitNotification = (notification: JsonRpcNotification) =>
    emitter.emit("notification", notification);

  const emitExit = (code: number | null, signal: NodeJS.Signals | null) =>
    emitter.emit("exit", code, signal);

  const failAllPending = (error: Error) => {
    const current = pending;
    pending = new Map();
    for (const { reject, timer } of current.values()) {
      clearTimeout(timer);
      reject(error);
    }
  };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Lineas no JSON (logs del proceso) se ignoran para no romper la correlacion.
      return;
    }
    if (typeof message !== "object" || message === null) return;

    const msg = message as Record<string, unknown>;
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id)!;
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) {
        reject(new JsonRpcRequestError(msg.error as JsonRpcErrorShape, String(msg.id)));
      } else {
        resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string" && msg.id === undefined) {
      emitNotification({ method: msg.method, params: msg.params });
    }
  };

  const start = () => {
    if (startPromise) return startPromise;
    startPromise = new Promise<void>((resolve, reject) => {
      try {
        child = spawn(command, ["app-server", ...extraArgs], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...env },
          cwd,
        });
      } catch (error) {
        reject(
          new CodexTransportError(`No se pudo iniciar \`${command} app-server\`: ${String(error)}`),
        );
        return;
      }

      exitCode = null;
      exitSignal = null;
      manuallyClosed = false;

      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", handleLine);

      child.stderr.on("data", (chunk) => {
        emitter.emit("stderr", chunk.toString());
      });

      child.once("error", (error) => {
        const err = new CodexTransportError(
          `Fallo al iniciar \`${command}\` (¿esta instalado?): ${error.message}`,
          error,
        );
        failAllPending(err);
        reject(err);
      });

      child.once("spawn", () => resolve());

      child.once("exit", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        rl.close();
        const error = new CodexTransportError(
          `El proceso \`${command} app-server\` termino${manuallyClosed ? "" : " inesperadamente"} (exit=${code ?? "?"}, signal=${signal ?? "?"})`,
        );
        failAllPending(error);
        emitExit(code, signal);
      });
    });
    return startPromise;
  };

  const request = async <T = unknown>(method: string, params?: unknown): Promise<T> => {
    await start();
    const id = nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CodexTransportError(`Timeout esperando respuesta de \`${method}\``));
      }, requestTimeoutMs);
      pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timer,
      });

      if (!child) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new CodexTransportError("El proceso no esta inicializado"));
        return;
      }
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error && pending.has(id)) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new CodexTransportError(`No se pudo escribir a \`${method}\`: ${error.message}`, error));
        }
      });
    });
  };

  const notify = async (method: string, params?: unknown) => {
    await start();
    if (!child) {
      throw new CodexTransportError("El proceso no esta inicializado");
    }
    const payload = params === undefined ? { method } : { method, params };
    await new Promise<void>((resolve, reject) => {
      child!.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) reject(new CodexTransportError(`No se pudo escribir a \`${method}\`: ${error.message}`, error));
        else resolve();
      });
    });
  };

  const close = () => {
    if (!child) return Promise.resolve();
    manuallyClosed = true;
    return new Promise<void>((resolve) => {
      const proc = child!;
      const finish = () => resolve();
      proc.once("exit", finish);
      proc.kill("SIGTERM");
      const force = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // el proceso ya no existe
        }
      }, killTimeoutMs);
      // Si el proceso nunca dispara "exit" (p. ej. ya estaba muerto), no colgar.
      const safety = setTimeout(finish, killTimeoutMs + 1_000);
      // Limpieza del timeout al salir
      proc.once("exit", () => {
        clearTimeout(force);
        clearTimeout(safety);
      });
    }).finally(() => {
      child = null;
      startPromise = null;
    });
  };

  const checkHealth = () => {
    if (!child || child.exitCode !== null) return false;
    return !exitCode && !exitSignal;
  };

  return {
    get pid() {
      return child?.pid;
    },
    get running() {
      return child !== null && child.exitCode === null;
    },
    start,
    request,
    notify,
    close,
    checkHealth,
    onNotification: (listener) => {
      emitter.on("notification", listener);
      return () => emitter.off("notification", listener);
    },
    onExit: (listener) => {
      emitter.on("exit", listener);
      return () => emitter.off("exit", listener);
    },
  };
}
