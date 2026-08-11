import { PrismaClient } from "@prisma/client";
import { CodexService } from "../src/chat/codexService.js";

const codex = new CodexService();
const prisma = new PrismaClient();

try {
  const { thread } = await codex.startThread({ model: "gpt-5.6-luna", sandbox: "read-only" });
  console.log("thread creado:", thread.id);

  await codex.startTurn({
    threadId: thread.id,
    input: [{ type: "text", text: "Hola. Responde solo con una frase corta." }],
  });

  const completado = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout esperando turn/completed")), 120_000);
    const off = codex.onThreadEvent(thread.id, (event) => {
      if (event.method === "turn/completed") {
        clearTimeout(timer);
        off();
        resolve(true);
      }
    });
  });
  console.log("turn completado:", completado);

  const row = await prisma.chatConversation.create({
    data: {
      codexThreadId: thread.id,
      title: "Conversación de prueba con turnos",
      selectedModel: "gpt-5.6-luna",
    },
  });
  console.log("fila local creada, id:", row.id);
} finally {
  await codex.close();
  await prisma.$disconnect();
}
