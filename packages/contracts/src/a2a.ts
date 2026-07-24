import { z } from 'zod';

/**
 * A2A (Agent2Agent) protocol shapes shared across the gateway (client + server directions) and the
 * operator UI. Kravn plays BOTH roles:
 *
 *  - A2A CLIENT — a remote A2A agent is registered as an upstream `Server` with `transport: 'a2a'`.
 *    Its Agent Card skills are bridged into the tool registry, so any Kravn MCP/chat consumer can
 *    delegate a task to it under the same governance/audit as any other tool.
 *  - A2A SERVER — Kravn publishes its OWN Agent Card at `/.well-known/agent-card.json` and speaks A2A
 *    JSON-RPC at `POST /a2a`, exposing org agents (and, optionally, MCP endpoints) as skills. Inbound
 *    tasks are authenticated + entitlement-checked and executed under governance, then audited.
 *
 * A2A is JSON-RPC 2.0 over HTTP(S) with SSE streaming; MCP connects an agent to tools (vertical),
 * A2A connects agents to agents (horizontal). The two compose.
 */

/** Bumped as the published Agent Card / method surface tracks the A2A spec. */
export const A2A_PROTOCOL_VERSION = '0.3.0';

// ─── Task lifecycle (the 8 canonical states + the catch-all `unknown`) ───────────────────────────

export const A2A_TASK_STATES = [
  'submitted',
  'working',
  'input-required',
  'auth-required',
  'completed',
  'canceled',
  'failed',
  'rejected',
  'unknown',
] as const;
export type A2aTaskState = (typeof A2A_TASK_STATES)[number];
export const a2aTaskStateSchema = z.enum(A2A_TASK_STATES);

/** States from which no further work happens (the task is done or paused pending external input). */
export const A2A_TERMINAL_STATES: readonly A2aTaskState[] = [
  'completed',
  'canceled',
  'failed',
  'rejected',
];
/** Paused states — the task stopped and is waiting on the caller (bridge treats these as stop points). */
export const A2A_INTERRUPT_STATES: readonly A2aTaskState[] = ['input-required', 'auth-required'];

export function isTerminalTaskState(s: A2aTaskState): boolean {
  return A2A_TERMINAL_STATES.includes(s);
}
export function isStoppedTaskState(s: A2aTaskState): boolean {
  return A2A_TERMINAL_STATES.includes(s) || A2A_INTERRUPT_STATES.includes(s);
}

// ─── JSON-RPC error codes (A2A domain errors live in the -32001..-32099 vendor range) ────────────

export const A2A_ERROR = {
  /** Spec JSON-RPC codes, reused for parity with the MCP server. */
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** A2A domain codes. */
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
  AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED: -32007,
} as const;

// ─── Message / Part / Artifact value shapes ──────────────────────────────────────────────────────

export interface A2aTextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}
export interface A2aFilePart {
  kind: 'file';
  file: { name?: string; mimeType?: string; bytes?: string; uri?: string };
  metadata?: Record<string, unknown>;
}
export interface A2aDataPart {
  kind: 'data';
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export type A2aPart = A2aTextPart | A2aFilePart | A2aDataPart;

export interface A2aMessage {
  role: 'user' | 'agent';
  parts: A2aPart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  kind: 'message';
  metadata?: Record<string, unknown>;
}

export interface A2aArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
}

export interface A2aTaskStatus {
  state: A2aTaskState;
  message?: A2aMessage;
  /** ISO-8601. */
  timestamp?: string;
}

export interface A2aTask {
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
  kind: 'task';
  metadata?: Record<string, unknown>;
}

/** SSE frames emitted by message/stream and tasks/resubscribe. */
export interface A2aStatusUpdateEvent {
  taskId: string;
  contextId: string;
  kind: 'status-update';
  status: A2aTaskStatus;
  final: boolean;
  metadata?: Record<string, unknown>;
}
export interface A2aArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  kind: 'artifact-update';
  artifact: A2aArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

// ─── Push-notification config (async task delivery to a caller-supplied webhook) ─────────────────

export interface A2aPushConfig {
  id?: string;
  url: string;
  token?: string;
  authentication?: { schemes: string[]; credentials?: string };
}

// ─── Agent Card (what Kravn publishes, and what a remote agent advertises) ───────────────────────

export interface A2aAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2aAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface A2aSecurityScheme {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  description?: string;
  [k: string]: unknown;
}

export interface A2aAgentProvider {
  organization: string;
  url: string;
}

export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  /** Base A2A JSON-RPC service URL (Kravn: `${publicUrl}/a2a`). */
  url: string;
  preferredTransport?: string;
  version: string;
  provider?: A2aAgentProvider;
  capabilities: A2aAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aAgentSkill[];
  securitySchemes?: Record<string, A2aSecurityScheme>;
  security?: Array<Record<string, string[]>>;
  /** Kravn extension: which internal capability backs a skill (agent id or endpoint slug). Never leaks secrets. */
  metadata?: Record<string, unknown>;
}

// ─── Inbound JSON-RPC param validation (server direction) ─────────────────────────────────────────
//
// Parts are validated leniently — the server mainly reads text parts, and rejecting an unknown part
// kind would break interop with agents that send richer content.

const a2aPartSchema = z.object({ kind: z.string().min(1) }).passthrough();

export const a2aMessageSchema = z.object({
  role: z.enum(['user', 'agent']).default('user'),
  parts: z.array(a2aPartSchema).min(1),
  messageId: z.string().max(191).optional(),
  taskId: z.string().max(64).optional(),
  // Bounded to the a2a_tasks.context_id column width so an overlong id is rejected uniformly (400) rather
  // than overflowing/truncating at the DB on non-SQLite dialects.
  contextId: z.string().max(64).optional(),
  kind: z.literal('message').optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const a2aPushConfigSchema = z.object({
  // Bounded to the a2a_push_configs.id column width (see contextId note above).
  id: z.string().max(64).optional(),
  url: z.string().url(),
  token: z.string().max(4096).optional(),
  authentication: z
    .object({ schemes: z.array(z.string()), credentials: z.string().optional() })
    .optional(),
});

export const a2aSendParamsSchema = z.object({
  message: a2aMessageSchema,
  configuration: z
    .object({
      blocking: z.boolean().optional(),
      acceptedOutputModes: z.array(z.string()).optional(),
      historyLength: z.number().int().min(0).max(1000).optional(),
      pushNotificationConfig: a2aPushConfigSchema.optional(),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type A2aSendParams = z.infer<typeof a2aSendParamsSchema>;

export const a2aTaskQueryParamsSchema = z.object({
  id: z.string().min(1),
  historyLength: z.number().int().min(0).max(1000).optional(),
});
export const a2aTaskIdParamsSchema = z.object({ id: z.string().min(1) });
export const a2aPushSetParamsSchema = z.object({
  taskId: z.string().min(1),
  pushNotificationConfig: a2aPushConfigSchema,
});

// ─── Operator-facing task summary (what the A2A admin view lists) ─────────────────────────────────

export interface A2aTaskSummary {
  id: string;
  contextId: string;
  skillId: string;
  actorEmail: string | null;
  state: A2aTaskState;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}
