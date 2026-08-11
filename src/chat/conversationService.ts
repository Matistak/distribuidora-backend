import type { PrismaClient } from "@prisma/client";
import { JsonRpcRequestError } from "./jsonrpc.js";
import type { CodexService } from "./codexService.js";
import type { CodexThread, CodexTurn } from "./codexProtocol.js";

/**
 * Conversaciones del chat (Etapa 4).
 *
 * La aplicacion guarda metadatos propios en SQLite (id local, codexThreadId,
 * titulo, modelo y fechas) y usa el historial de Codex via `thread/read` para
 * los mensajes, segun la decision de Fase 0. Este servicio traduce entre la
 * base local y el protocolo de `app-server` sin exponer detalles internos.
 */

/** Titulo aplicado a una conversacion nueva cuando el usuario no indica uno. */
export const TITULO_POR_DEFECTO = "Nueva conversación";

/** Alcance del asistente aplicado a cada conversación nueva. */
export const INSTRUCCIONES_BASE_CHAT = [
  "Sos un asistente de análisis de ventas de una distribuidora.",
  "Solo respondé preguntas que puedan resolverse utilizando las herramientas de ventas y los datos de la base local.",
  "Si la consulta no está relacionada con ventas, productos, vendedores, clientes, períodos, ciudades, canales o métricas comerciales, indicá amablemente que solo podés responder consultas sobre los datos de ventas.",
  "No realices búsquedas en internet ni utilices fuentes externas.",
  "No inventes información ni cifras.",
].join(" ");

/** Longitud maxima del titulo derivado del primer mensaje del thread. */
const TITULO_MAX_LENGTH = 80;

export class ModeloChatInvalidoError extends Error {
  constructor(model: string) {
    super(`El modelo "${model}" no está disponible para la cuenta.`);
    this.name = "ModeloChatInvalidoError";
  }
}

export interface ChatConversacionResumen {
  id: number;
  codexThreadId: string;
  title: string;
  selectedModel: string;
  createdAt: string;
  updatedAt: string;
}

/** Consulta a una herramienta (MCP de ventas) resumida para mostrar en la UI. */
export interface ChatToolCall {
  /** Nombre del servidor MCP (p. ej. `ventas`). */
  server: string;
  /** Nombre de la herramienta (p. ej. `resumen_ventas`). */
  tool: string;
  status: "inProgress" | "completed" | "failed";
  /** Mensaje de error de la herramienta, si fallo. */
  error?: string | null;
}

export interface ChatMensaje {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Timestamp en ms del turno al que pertenece el item, si se conoce. */
  createdAt?: number;
  /** Consultas a herramientas del turno, en orden de ejecucion (Etapa 7). */
  toolCalls?: ChatToolCall[];
}

export interface ChatConversacionDetalle {
  conversation: ChatConversacionResumen;
  messages: ChatMensaje[];
  /** Preview que Codex conserva del thread (primer mensaje), si existe. */
  preview: string;
}

const toSummary = (row: {
  id: number;
  codexThreadId: string;
  title: string;
  selectedModel: string;
  createdAt: Date;
  updatedAt: Date;
}): ChatConversacionResumen => ({
  id: row.id,
  codexThreadId: row.codexThreadId,
  title: row.title,
  selectedModel: row.selectedModel,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Convierte los items de un turno de Codex en mensajes de la aplicacion.
 * Las tool calls del MCP de ventas se adjuntan a la respuesta del asistente
 * del mismo turno como resumen (nombre de la herramienta y estado).
 */
function turnToMessages(turn: CodexTurn): ChatMensaje[] {
  const createdAt = typeof turn.startedAt === "number" ? turn.startedAt * 1000 : undefined;
  const messages: ChatMensaje[] = [];

  for (const item of turn.items ?? []) {
    if (item.type === "userMessage") {
      const text = item.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n")
        .trim();
      if (text) messages.push({ id: item.id, role: "user", text, createdAt });
    } else if (item.type === "agentMessage") {
      const text = item.text.trim();
      if (!text) continue;
      // Si el asistente ya abrio la burbuja con tool calls pero sin texto
      // (la consulta llego antes que la respuesta), completa esa burbuja.
      const ultimo = messages.at(-1);
      if (ultimo && ultimo.role === "assistant" && ultimo.text === "") {
        ultimo.id = item.id;
        ultimo.text = text;
      } else {
        messages.push({ id: item.id, role: "assistant", text, createdAt });
      }
    } else if (item.type === "mcpToolCall") {
      const toolCall: ChatToolCall = {
        server: item.server,
        tool: item.tool,
        status: item.status ?? "completed",
        error: item.error?.message ?? null,
      };
      let ultimo = messages.at(-1);
      if (!ultimo || ultimo.role !== "assistant") {
        ultimo = { id: `tool-${item.id}`, role: "assistant", text: "", createdAt };
        messages.push(ultimo);
      }
      (ultimo.toolCalls ??= []).push(toolCall);
    }
  }
  return messages;
}

export class ConversationService {
  constructor(
    private readonly codex: CodexService,
    private readonly db: PrismaClient,
  ) {}

  /** Lista las conversaciones locales, de la mas reciente a la mas antigua. */
  async list(): Promise<ChatConversacionResumen[]> {
    const rows = await this.db.chatConversation.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(toSummary);
  }

  /** Metadatos de una conversacion, o `null` si el id local no existe. */
  async get(id: number): Promise<ChatConversacionResumen | null> {
    const row = await this.db.chatConversation.findUnique({ where: { id } });
    return row ? toSummary(row) : null;
  }

  /**
   * Crea una conversacion nueva: valida el modelo, pide el thread a Codex
   * (`thread/start`) y guarda los metadatos locales asociados.
   */
  async create(input: { model: string; title?: string }): Promise<ChatConversacionResumen> {
    const valid = await this.codex.validateModel(input.model);
    if (!valid) throw new ModeloChatInvalidoError(input.model);

    const { thread } = await this.codex.startThread({
      model: input.model,
      sandbox: "read-only",
      baseInstructions: INSTRUCCIONES_BASE_CHAT,
    });

    const title = input.title?.trim() || thread.name?.trim() || TITULO_POR_DEFECTO;
    const row = await this.db.chatConversation.create({
      data: {
        codexThreadId: thread.id,
        title,
        selectedModel: input.model,
      },
    });
    return toSummary(row);
  }

  /**
   * Borra una conversacion: elimina el thread en Codex (`thread/delete`) y
   * despues los metadatos locales. Devuelve `null` si el id local no existe.
   */
  async remove(id: number): Promise<ChatConversacionResumen | null> {
    const row = await this.db.chatConversation.findUnique({ where: { id } });
    if (!row) return null;

    try {
      await this.codex.deleteThread({ threadId: row.codexThreadId });
    } catch (error) {
      // Si el thread ya no existe en Codex (por ejemplo, borrado desde la
      // CLI), igual se limpia el registro local.
      if (!(error instanceof JsonRpcRequestError && error.code === -32600)) throw error;
    }

    await this.db.chatConversation.delete({ where: { id } });
    return toSummary(row);
  }

  /**
   * Lee una conversacion: metadatos locales + mensajes del historial de Codex
   * (`thread/read`). Devuelve `null` si el id local no existe.
   */
  async read(id: number): Promise<ChatConversacionDetalle | null> {
    const row = await this.db.chatConversation.findUnique({ where: { id } });
    if (!row) return null;

    const thread = await this.readThreadGraceful(row.codexThreadId, row.selectedModel);

    await this.syncMetadata(row, thread);
    const messages = thread.turns.flatMap(turnToMessages);

    // Relee la fila por si syncMetadata actualizo el titulo.
    const freshRow = await this.db.chatConversation.findUnique({ where: { id } });
    if (!freshRow) return null;

    return {
      conversation: toSummary(freshRow),
      messages,
      preview: thread.preview ?? "",
    };
  }

  /**
   * Reanuda una conversacion existente (`thread/resume`): confirma que el
   * thread sigue disponible en Codex y actualiza los metadatos locales.
   * El id del thread queda listo para `turn/start` en la Etapa 5.
   * Devuelve `null` si el id local no existe.
   */
  async resume(id: number, model?: string): Promise<ChatConversacionResumen | null> {
    const row = await this.db.chatConversation.findUnique({ where: { id } });
    if (!row) return null;

    const selectedModel = model?.trim() || row.selectedModel;
    if (model && model !== row.selectedModel) {
      const valid = await this.codex.validateModel(selectedModel);
      if (!valid) throw new ModeloChatInvalidoError(selectedModel);
    }

    try {
      await this.codex.resumeThread({ threadId: row.codexThreadId, model: selectedModel });
    } catch (error) {
      // Un thread sin turnos no tiene rollout que reanudar; `turn/start`
      // (Etapa 5) lo materializa. No es un error de la conversacion.
      if (!(error instanceof JsonRpcRequestError && error.code === -32600)) throw error;
    }

    const updated = await this.db.chatConversation.update({
      where: { id },
      data: { selectedModel },
    });
    return toSummary(updated);
  }

  /**
   * `thread/read` puede fallar con -32600 en dos casos:
   *
   * 1. Thread "frio": creado en otra sesion de app-server y todavia no cargado.
   *    Se carga con `thread/resume` y se relee.
   * 2. Thread sin turnos ("not materialized yet" / "no rollout found"):
   *    no hay mensajes que leer; se devuelve el thread con metadatos minimos.
   */
  private async readThreadGraceful(threadId: string, model: string): Promise<CodexThread> {
    const tryRead = async (): Promise<CodexThread | null> => {
      try {
        const { thread } = await this.codex.readThread({ threadId, includeTurns: true });
        return thread;
      } catch (error) {
        if (error instanceof JsonRpcRequestError && error.code === -32600) return null;
        throw error;
      }
    };

    const loaded = await tryRead();
    if (loaded) return loaded;

    try {
      await this.codex.resumeThread({ threadId, model });
    } catch (error) {
      if (!(error instanceof JsonRpcRequestError && error.code === -32600)) throw error;
    }

    const afterResume = await tryRead();
    if (afterResume) return afterResume;

    return {
      id: threadId,
      preview: "",
      createdAt: 0,
      updatedAt: 0,
      status: { type: "unknown" },
      turns: [],
    };
  }

  /**
   * Mantiene los metadatos locales alineados con lo que Codex guarda del
   * thread: si el titulo sigue siendo el por defecto, lo reemplaza por el
   * preview que Codex conserva (primer mensaje del thread).
   */
  private async syncMetadata(row: { id: number; title: string }, thread: CodexThread): Promise<void> {
    const tituloAutomatico = row.title === TITULO_POR_DEFECTO;
    const preview = thread.preview?.trim();
    if (tituloAutomatico && preview) {
      await this.db.chatConversation.update({
        where: { id: row.id },
        data: { title: preview.slice(0, TITULO_MAX_LENGTH) },
      });
    }
  }
}
