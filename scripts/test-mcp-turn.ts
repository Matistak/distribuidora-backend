/**
 * Prueba end-to-end del MCP de ventas (Etapa 6).
 *
 * Inicia `codex app-server` con el MCP de ventas configurado y hace un turno
 * real con una pregunta comercial. Captura todos los deltas y comprueba que
 * el asistente usa las herramientas de la base local.
 *
 * Uso: npx tsx scripts/test-mcp-turn.ts
 */
import { CodexService } from "../src/chat/codexService.js";
import { ventasMcpLaunchArgs } from "../src/mcp/ventasMcpConfig.js";
import { autoApproveVentasToolCalls } from "../src/chat/autoApproval.js";

const MODELO = process.env["CODEX_TEST_MODEL"] ?? "gpt-5.4-mini";
const PREGUNTA =
  process.env["CODEX_TEST_PREGUNTA"] ??
  "Usando las herramientas de ventas disponibles, responde en 2 o 3 frases: ¿cuántas facturas hubo en julio de 2026 y cuál fue el vendedor con mayor venta neta en ese mes? Menciona los montos.";

const codex = new CodexService({
  extraArgs: ventasMcpLaunchArgs(),
});

try {
  const { thread } = await codex.startThread({ model: MODELO, sandbox: "read-only" });
  console.log("thread:", thread.id, "modelo:", MODELO);
  console.log("pregunta:", PREGUNTA, "\n");

  await codex.startTurn({ threadId: thread.id, input: [{ type: "text", text: PREGUNTA }], model: MODELO });

  // Las tool calls del MCP de ventas requieren aprobacion del cliente
  // (mcpServer/elicitation/request): se aprueban automaticamente.
  const offApproval = autoApproveVentasToolCalls(codex);
  let texto = "";
  const herramientas: string[] = [];

  const terminado = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout esperando turn/completed")), 240_000);
    const off = codex.onThreadEvent(thread.id, (event) => {
      switch (event.method) {
        case "item/agentMessage/delta":
          texto += event.params.delta;
          process.stdout.write(event.params.delta);
          break;
        case "item/completed":
          if (event.params.item.type === "mcpToolCall") {
            const item = event.params.item as { toolCall?: { name?: string } };
            herramientas.push(item.toolCall?.name ?? "mcpToolCall");
          }
          break;
        case "turn/completed": {
          clearTimeout(timer);
          off();
          offApproval();
          resolve(event.params.turn.status === "completed");
          break;
        }
      }
    });
  });

  console.log("\n\nherramientas MCP usadas:", herramientas.length ? herramientas.join(", ") : "(ninguna)");
  console.log("\n--- respuesta del asistente ---\n");
  console.log(texto.trim() || "(sin texto)");
  console.log("\nturn completado:", terminado);
} finally {
  await codex.close();
}
