/**
 * Verificacion de la Etapa 7 (interfaz del chat): contrato de tool calls.
 *
 * 1. Inicia app-server con el MCP de ventas.
 * 2. Hace un turno real y captura los eventos SSE: comprueba que llega
 *    `message.tool_call` y que termina con `message.completed`.
 * 3. Lee la conversacion via ConversationService: comprueba que los mensajes
 *    del asistente incluyen `toolCalls` resumidas.
 *
 * Uso: npx tsx scripts/test-tool-calls.ts
 *
 * Nota: no importar `src/server.js` (levanta Fastify y el proceso nunca
 * termina); el PrismaClient se crea local como en `src/chat/conversationService.ts`.
 */
import { PrismaClient } from "@prisma/client";
import { ChatStreamService } from "../src/chat/chatStreamService.js";
import { ConversationService } from "../src/chat/conversationService.js";
import { CodexService } from "../src/chat/codexService.js";
import { ventasMcpLaunchArgs } from "../src/mcp/ventasMcpConfig.js";

const MODELO = process.env["CODEX_TEST_MODEL"] ?? "gpt-5.4-mini";
const PREGUNTA =
  process.env["CODEX_TEST_PREGUNTA"] ??
  "Usando las herramientas de ventas disponibles: ¿cuántas facturas hubo en julio de 2026? Responde en una frase.";

const codex = new CodexService({ extraArgs: ventasMcpLaunchArgs() });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env["DATABASE_URL"] ?? "file:./distribuidora.db" } },
});
const conversations = new ConversationService(codex, prisma);

let rowId: number | null = null;

try {
  console.log("Paso 1: crear conversacion (thread/start)...");
  const conversation = await conversations.create({ model: MODELO });
  rowId = conversation.id;
  console.log("  conversacion:", conversation.id, "thread:", conversation.codexThreadId);

  const sseEvents: string[] = [];
  console.log("Paso 2: turno con stream (ChatStreamService)...");
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout esperando message.completed")), 240_000);
    const stream = new ChatStreamService(codex);
    stream
      .streamMessage({
        threadId: conversation.codexThreadId,
        model: MODELO,
        message: PREGUNTA,
        send: (event) => {
          sseEvents.push(event.event);
          if (event.event === "message.tool_call") {
            const data = event.data as { server: string; tool: string };
            console.log("  tool_call SSE:", data.server, "/", data.tool);
          }
        },
        onDone: () => {
          clearTimeout(timer);
          resolve();
        },
      })
      .catch(reject);
  });
  await done;

  const toolCallCount = sseEvents.filter((e) => e === "message.tool_call").length;
  const hasStart = sseEvents[0] === "message.start";
  const hasCompleted = sseEvents.at(-1) === "message.completed";
  console.log(
    "eventos SSE:",
    sseEvents.join(" -> "),
    `(${toolCallCount} tool_call, start=${hasStart}, completed=${hasCompleted})`,
  );

  console.log("Paso 3: leer historial (thread/read con toolCalls)...");
  const detalle = await conversations.read(conversation.id);
  const conToolCalls = (detalle?.messages ?? []).filter(
    (m) => (m.toolCalls?.length ?? 0) > 0,
  );
  console.log(`mensajes con toolCalls en el historial: ${conToolCalls.length}`);
  for (const m of conToolCalls) {
    console.log(
      "  asistente:",
      JSON.stringify(m.toolCalls),
      "| texto:",
      (m.text.slice(0, 80) || "(vacío)"),
    );
  }
} finally {
  if (rowId !== null) {
    await conversations
      .read(rowId)
      .then(() => {})
      .catch(() => {});
  }
  await codex.close();
  await prisma.$disconnect();
}
