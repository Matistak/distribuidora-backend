/**
 * Protocolo tipado de `codex app-server`.
 *
 * Etapa 2: interfaz interna pequena para enviar requests y suscribirse a
 * eventos de Codex. Los tipos siguen el schema del app-server (generado en
 * t3code/packages/effect-codex-app-server) pero recortados al subconjunto que
 * la aplicacion usa: threads, turns, modelos y notificaciones de texto.
 *
 * Decision (Etapa 2): se mantiene un cliente simple en TypeScript y no se
 * adapta `effect-codex-app-server` (ver CHAT-CODEX.md, Fase 2).
 */

// ---------------------------------------------------------------- Requests

export interface CodexInitializeParams {
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
}

export interface CodexModelListParams {
  cursor?: string | null;
  includeHidden?: boolean | null;
  limit?: number | null;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string | null;
  defaultServiceTier?: string | null;
  supportedReasoningEfforts?: ReadonlyArray<{ value: string }>;
}

export interface CodexModelListResult {
  data: ReadonlyArray<CodexModel>;
  nextCursor?: string | null;
}

export interface CodexThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  baseInstructions?: string | null;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
  serviceTier?: string | null;
}

export interface CodexThreadResumeParams {
  threadId: string;
  model?: string | null;
  cwd?: string | null;
}

export interface CodexThreadListParams {
  limit?: number | null;
}

export interface CodexThreadReadParams {
  threadId: string;
  includeTurns?: boolean | null;
}

export interface CodexThreadSummary {
  id: string;
  name?: string | null;
  preview: string;
  createdAt: number;
  updatedAt: number;
  model?: string | null;
}

export interface CodexThread {
  id: string;
  name?: string | null;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: { type: string };
  turns: ReadonlyArray<CodexTurn>;
}

export interface CodexThreadStartResult {
  thread: CodexThread;
  model: string;
}

export interface CodexThreadResumeResult {
  thread: CodexThread;
}

export interface CodexThreadListResult {
  data: ReadonlyArray<CodexThreadSummary>;
  nextCursor?: string | null;
}

export interface CodexThreadReadResult {
  thread: CodexThread;
}

export interface CodexUserInput {
  type: "text";
  text: string;
}

export interface CodexTurnStartParams {
  threadId: string;
  input: ReadonlyArray<CodexUserInput>;
  model?: string | null;
  cwd?: string | null;
}

export interface CodexTurn {
  id: string;
  status: { type: string };
  items?: ReadonlyArray<unknown>;
}

export interface CodexTurnStartResult {
  turn: CodexTurn;
}

export interface CodexTurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ------------------------------------------------------------- Notifications

export interface CodexTurnStartedNotification {
  threadId: string;
  turn: CodexTurn;
}

export interface CodexTurnCompletedNotification {
  threadId: string;
  turn: CodexTurn & {
    error?: { type?: string; message?: string } | null;
  };
}

export interface CodexAgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CodexItemStartedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  kind?: string;
}

export interface CodexItemCompletedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  kind?: string;
}

/** Nombre y shape de cada notificacion que la aplicacion consume. */
export interface CodexNotificationMap {
  "turn/started": CodexTurnStartedNotification;
  "turn/completed": CodexTurnCompletedNotification;
  "item/agentMessage/delta": CodexAgentMessageDeltaNotification;
  "item/started": CodexItemStartedNotification;
  "item/completed": CodexItemCompletedNotification;
}

export type CodexNotificationMethod = keyof CodexNotificationMap;

/** Evento ya decodificado que la aplicacion puede consumir por thread. */
export type CodexEvent = {
  [M in CodexNotificationMethod]: {
    method: M;
    params: CodexNotificationMap[M];
  };
}[CodexNotificationMethod];
