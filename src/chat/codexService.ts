import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createCodexProcess,
  type CodexProcessHandle,
  type JsonRpcNotification,
} from "./jsonrpc.js";

const execFileAsync = promisify(execFile);

export interface CodexAccount {
  type: "chatgpt" | "apiKey" | "amazonBedrock" | "unknown";
  email?: string | null;
  planType?: string | null;
}

export interface CodexStatus {
  installed: boolean;
  version?: string;
  running: boolean;
  account: CodexAccount | null;
  authenticated: boolean;
  error?: string;
}

export interface CodexServiceOptions {
  /** Comando codex (por defecto "codex" en PATH). */
  command?: string;
  /** Argumentos extra para `codex app-server`. */
  extraArgs?: string[];
  /** Directorio de trabajo para el proceso app-server. */
  cwd?: string;
  /** Variables de entorno extra. */
  env?: NodeJS.ProcessEnv;
  /** Logger opcional para eventos del proceso. */
  logger?: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
}

const log = (level: "info" | "warn" | "error", message: string, extra?: unknown) => {
  // eslint-disable-next-line no-console
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    `[codex] ${message}`,
    extra === undefined ? "" : JSON.stringify(extra),
  );
};

export class CodexNotInstalledError extends Error {
  constructor(command: string) {
    super(
      `Codex CLI no encontrado. Instalalo con \`npm install -g @openai/codex\` o \`brew install codex\` y vuelve a intentarlo.`,
    );
    this.name = "CodexNotInstalledError";
  }
}

export class CodexNotAuthenticatedError extends Error {
  constructor() {
    super(
      `Codex no esta autenticado. Ejecuta \`codex login\` (abre el navegador para iniciar sesion con ChatGPT) y luego \`codex login status\` para verificar.`,
    );
    this.name = "CodexNotAuthenticatedError";
  }
}

interface InitializeResult {
  userAgent?: string;
  platformFamily?: string;
  platformOs?: string;
}

interface AccountReadResult {
  account?: {
    type?: string;
    email?: string | null;
    planType?: string | null;
  } | null;
  requiresOpenaiAuth?: boolean;
}

export class CodexService {
  private process: CodexProcessHandle | null = null;
  private initializePromise: Promise<InitializeResult> | null = null;
  private startPromise: Promise<CodexProcessHandle> | null = null;
  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly logger: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;

  constructor(options: CodexServiceOptions = {}) {
    this.command = options.command ?? "codex";
    this.extraArgs = options.extraArgs ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.logger = options.logger ?? log;
  }

  /** Detecta si el binario de codex existe y devuelve su version. */
  async detect(): Promise<{ installed: boolean; version?: string }> {
    try {
      const { stdout } = await execFileAsync(this.command, ["--version"], {
        timeout: 10_000,
        env: { ...process.env, ...this.env },
      });
      return { installed: true, version: stdout.trim() };
    } catch {
      return { installed: false };
    }
  }

  /** Devuelve el proceso app-server, iniciandolo si es necesario. */
  async ensureProcess(): Promise<CodexProcessHandle> {
    if (this.process && this.process.running) return this.process;

    if (!this.startPromise) {
      this.startPromise = this.startProcess().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async startProcess(): Promise<CodexProcessHandle> {
    const { installed, version } = await this.detect();
    if (!installed) throw new CodexNotInstalledError(this.command);

    const proc = createCodexProcess({
      command: this.command,
      extraArgs: this.extraArgs,
      cwd: this.cwd,
      env: this.env,
    });

    proc.onExit((code, signal) => {
      this.logger("warn", `app-server termino (exit=${code}, signal=${signal})`);
    });
    proc.onNotification((notification) => this.handleNotification(notification));

    await proc.start();
    this.logger("info", `app-server iniciado (pid=${proc.pid}, version=${version})`);
    this.process = proc;
    return proc;
  }

  private handleNotification(notification: JsonRpcNotification) {
    this.logger("info", `notificacion ${notification.method}`);
  }

  /**
   * Realiza el handshake `initialize` + `initialized`.
   * Puede llamarse varias veces: solo se ejecuta una vez por proceso.
   */
  async initialize(): Promise<InitializeResult> {
    if (!this.initializePromise) {
      this.initializePromise = this.doInitialize().catch((error) => {
        this.initializePromise = null;
        throw error;
      });
    }
    return this.initializePromise;
  }

  private async doInitialize(): Promise<InitializeResult> {
    const proc = await this.ensureProcess();
    const result = await proc.request<InitializeResult>("initialize", {
      clientInfo: {
        name: "distribuidora-chat",
        title: "Chat de Ventas - Distribuidora",
        version: "0.1.0",
      },
    });
    // `initialized` es una notificacion: sin id, sin respuesta.
    await proc.notify("initialized", {});
    this.logger("info", "handshake initialize/initialized completado", {
      platform: `${result.platformOs}/${result.platformFamily}`,
    });
    return result;
  }

  /** Lee la cuenta conectada via `account/read`. */
  async readAccount(): Promise<CodexAccount> {
    const proc = await this.ensureProcess();
    await this.initialize();
    const result = await proc.request<AccountReadResult>("account/read", {});
    const raw = result.account;
    if (!raw || typeof raw !== "object") {
      throw new CodexNotAuthenticatedError();
    }
    const type =
      raw.type === "chatgpt" || raw.type === "apiKey" || raw.type === "amazonBedrock"
        ? raw.type
        : "unknown";
    return {
      type,
      email: raw.email ?? null,
      planType: raw.planType ?? null,
    };
  }

  /** Estado completo: instalacion, proceso y cuenta (sin credenciales). */
  async status(): Promise<CodexStatus> {
    const base: CodexStatus = {
      installed: false,
      running: false,
      account: null,
      authenticated: false,
    };

    const detected = await this.detect();
    if (!detected.installed) {
      return { ...base, error: new CodexNotInstalledError(this.command).message };
    }
    base.installed = true;
    base.version = detected.version;

    try {
      const account = await this.readAccount();
      base.running = this.process?.running ?? false;
      base.account = account;
      base.authenticated = true;
    } catch (error) {
      base.running = this.process?.running ?? false;
      if (error instanceof CodexNotAuthenticatedError) {
        base.error = error.message;
      } else {
        base.error =
          error instanceof Error
            ? error.message
            : "No se pudo conectar con el proceso de Codex.";
      }
    }
    return base;
  }

  /** Cierra el proceso app-server de forma controlada. */
  async close(): Promise<void> {
    if (this.process) {
      await this.process.close();
      this.process = null;
    }
    this.initializePromise = null;
    this.startPromise = null;
    this.logger("info", "app-server cerrado");
  }

  /** Reinicia el proceso app-server (cierra y vuelve a iniciar en el siguiente uso). */
  async restart(): Promise<void> {
    await this.close();
    await this.status();
  }
}
