import { z } from 'zod';

/**
 * TIER-2 application settings.
 *
 * This is the heart of Kravn's "configuration lives in the app" principle. These values
 * are stored in the DB, edited from the admin UI, and hot-reloaded — NOT Kubernetes env vars.
 * The same schema validates writes on the backend AND drives the settings form on the frontend.
 *
 * Tier-1 (bootstrap) config — DB connection, secret, port, public URL — lives in env, not here.
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Tool-definition pinning (rug-pull / tool-poisoning defence):
 *  - `off`     — do not track tool definitions.
 *  - `audit`   — pin each tool's definition on first sight; record + audit any later silent change, but keep serving it.
 *  - `enforce` — same, but a changed tool is quarantined (not advertised or invocable) until an admin re-approves it.
 */
export const TOOL_PINNING_MODES = ['off', 'audit', 'enforce'] as const;
export type ToolPinningMode = (typeof TOOL_PINNING_MODES)[number];

/** What to do when a cost/quota budget is exceeded: `warn` (log + audit, keep serving) or `block` (refuse). */
export const BUDGET_ACTIONS = ['warn', 'block'] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];

/** Cloud metadata endpoints that must stay blocked even when private networks are allowed. */
export const DEFAULT_BLOCKED_HOSTS = [
  '169.254.169.254', // AWS / Azure / GCP IMDS
  '100.100.100.200', // Alibaba
  '169.254.170.2', // ECS task metadata
  'metadata.google.internal',
  'metadata',
] as const;

export const appSettingsSchema = z
  .object({
    general: z
      .object({
        instanceName: z.string().min(1).max(80).default('Kravn'),
        /** Absolute public URL; if empty, the server auto-derives it from the request. */
        publicUrl: z.string().url().or(z.literal('')).default(''),
      })
      .default({}),

    security: z
      .object({
        /**
         * Allow the gateway to reach private / in-cluster networks. Defaults to TRUE because an
         * in-cluster MCP gateway's whole job is to reach in-cluster services — the opposite default
         * is exactly what made the reference product painful to deploy. Metadata IPs stay blocked.
         */
        ssrfAllowPrivateNetworks: z.boolean().default(true),
        ssrfBlockedHosts: z.array(z.string()).default([...DEFAULT_BLOCKED_HOSTS]),
        /** CSRF double-submit protection. Designed to "just work" with the SPA; rarely needs disabling. */
        csrfEnabled: z.boolean().default(true),
        trustedOrigins: z.array(z.string()).default([]),
        rateLimitEnabled: z.boolean().default(true),
        rateLimitPerMinute: z.number().int().positive().max(100_000).default(600),
        /** Model governance: allowlist of LLM model ids the chat may use (exact or `*` glob, e.g.
         *  `claude-*`). Empty = allow any model on a configured provider. */
        allowedModels: z.array(z.string()).default([]),
      })
      .default({}),

    governance: z
      .object({
        /** Rug-pull / tool-poisoning defence — see TOOL_PINNING_MODES. Defaults to off (opt-in). */
        toolPinning: z.enum(TOOL_PINNING_MODES).default('off'),
        /** Org-wide daily budgets (0 = off). Enforced globally per UTC day; per-team/endpoint is on the roadmap. */
        dailyTokenBudget: z.number().int().min(0).default(0),
        dailyCallBudget: z.number().int().min(0).default(0),
        budgetAction: z.enum(BUDGET_ACTIONS).default('warn'),
      })
      .default({}),

    mcp: z
      .object({
        enableStreamableHttp: z.boolean().default(true),
        enableSse: z.boolean().default(true),
        enableStdio: z.boolean().default(false),
        requestTimeoutMs: z.number().int().positive().max(600_000).default(30_000),
        keepAliveIntervalMs: z.number().int().positive().max(600_000).default(30_000),
        maxContentSizeBytes: z.number().int().positive().default(1_048_576),
      })
      .default({}),

    federation: z
      .object({
        autoReconnect: z.boolean().default(true),
        healthCheckIntervalMs: z.number().int().positive().max(3_600_000).default(60_000),
        allowAllDomains: z.boolean().default(false),
        allowedDomains: z.array(z.string()).default([]),
      })
      .default({}),

    auth: z
      .object({
        publicRegistrationEnabled: z.boolean().default(false),
        sessionTtlMinutes: z.number().int().positive().max(43_200).default(720),
        /** Idle timeout: a session with no activity for this long is rejected. 0 = disabled (only the
         *  absolute sessionTtlMinutes applies). */
        idleTimeoutMinutes: z.number().int().min(0).max(43_200).default(0),
        /** Local email+password login. Disable to run SSO-only (e.g. EntraID). */
        passwordLoginEnabled: z.boolean().default(true),
        /** Brute-force protection for local login (per IP and per email). */
        loginRateLimit: z
          .object({
            enabled: z.boolean().default(true),
            maxAttempts: z.number().int().positive().max(10_000).default(10),
            windowSeconds: z.number().int().positive().max(86_400).default(300),
          })
          .default({}),
      })
      .default({}),

    observability: z
      .object({
        metricsEnabled: z.boolean().default(true),
        otlpEndpoint: z.string().default(''),
        logLevel: z.enum(LOG_LEVELS).default('info'),
        /** Optional HTTP endpoint the audit log is POSTed to per event (Splunk HEC / generic SIEM). SSRF-guarded. */
        auditWebhookUrl: z.string().default(''),
      })
      .default({}),

    /**
     * White-label branding for the client-facing surfaces (chat client login + sidebar, OAuth approval page).
     * All fields optional; empty = the Kravn defaults. Publicly readable (via GET /api/branding) because the
     * login and approval screens must render it before authentication. See `isBrandingCustomized`.
     */
    branding: z
      .object({
        /** Replaces the "Kravn" wordmark on client-facing surfaces (falls back to general.instanceName, then "Kravn"). */
        brandName: z.string().max(80).default(''),
        /** Short phrase shown under the logo on the login / approval screens. */
        tagline: z.string().max(160).default(''),
        /** Logo image as a data URI (e.g. "data:image/png;base64,…"). Empty = the default raven mark. */
        logoDataUri: z
          .string()
          .max(512_000) // ~512KB cap: this rides on every public /api/bootstrap response, so keep it small.
          .refine((v) => v === '' || v.startsWith('data:image/'), 'Logo must be an image data URI.')
          .default(''),
        /** Accent/primary colour as a hex value (e.g. "#325ea8"); restricted to hex so it is safe to inject as a CSS var. */
        primaryColor: z
          .string()
          .refine((v) => v === '' || /^#[0-9a-fA-F]{3,8}$/.test(v), 'Use a hex colour like #325ea8.')
          .default(''),
        /** Advanced: raw CSS injected into client-facing surfaces (for a technician). Sanitised of </style on render. */
        cssOverride: z.string().max(20_000).default(''),
      })
      .default({}),
  })
  // Fail-closed cross-field guard, mirrored on backend writes and surfaced in the UI.
  .superRefine((val, ctx) => {
    if (val.federation.allowAllDomains && val.federation.allowedDomains.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['federation', 'allowAllDomains'],
        message: 'allowAllDomains cannot be combined with a non-empty allowedDomains list.',
      });
    }
  })
  .default({});

export type AppSettings = z.infer<typeof appSettingsSchema>;

/** The branding subset (publicly readable — safe to serve pre-auth to login / approval screens). */
export type Branding = AppSettings['branding'];

/**
 * True once the client has replaced Kravn's identity (a custom logo or brand name). When true, the
 * "Powered by Kravn" attribution must render below the custom logo on every branded surface.
 */
export function isBrandingCustomized(b: Branding | undefined | null): boolean {
  return !!(b && (b.logoDataUri || b.brandName));
}

/** Neutralise any `</style` in an operator-supplied CSS override before injecting it into a <style> tag. */
export function sanitizeCssOverride(css: string): string {
  return (css || '').replace(/<\/style/gi, '<\\/style');
}

/** Produce a fully-populated default settings object from the schema's own defaults. */
export function defaultSettings(): AppSettings {
  return appSettingsSchema.parse(undefined);
}

/** Deep-merge a partial patch over a base settings object, then re-validate. */
export function mergeSettings(base: AppSettings, patch: unknown): AppSettings {
  const deepMerge = (a: any, b: any): any => {
    if (b === null || b === undefined) return a;
    if (Array.isArray(b) || typeof b !== 'object') return b;
    const out: any = { ...a };
    for (const key of Object.keys(b)) out[key] = deepMerge(a?.[key], b[key]);
    return out;
  };
  return appSettingsSchema.parse(deepMerge(base, patch));
}

// ─── UI metadata: drives the admin Settings form (labels, grouping, control type) ───────────────

export type SettingControl = 'boolean' | 'number' | 'string' | 'string[]' | 'enum';

export interface SettingFieldMeta {
  /** Dot path into AppSettings, e.g. "security.csrfEnabled". */
  path: string;
  label: string;
  control: SettingControl;
  help?: string;
  options?: readonly string[];
  secret?: boolean;
}

export interface SettingGroupMeta {
  key: string;
  label: string;
  description?: string;
  fields: SettingFieldMeta[];
}

export const SETTINGS_UI: SettingGroupMeta[] = [
  {
    key: 'general',
    label: 'General',
    fields: [
      { path: 'general.instanceName', label: 'Instance name', control: 'string' },
      {
        path: 'general.publicUrl',
        label: 'Public URL',
        control: 'string',
        help: 'Leave empty to auto-derive from the request (Host / X-Forwarded-*).',
      },
    ],
  },
  {
    key: 'security',
    label: 'Security',
    description: 'Defaults are tuned to boot cleanly in-cluster. Tighten as you harden.',
    fields: [
      {
        path: 'security.ssrfAllowPrivateNetworks',
        label: 'Allow private / in-cluster networks',
        control: 'boolean',
        help: 'Required to reach MCP servers running inside your cluster. Metadata IPs stay blocked regardless.',
      },
      { path: 'security.ssrfBlockedHosts', label: 'Always-blocked hosts', control: 'string[]' },
      { path: 'security.csrfEnabled', label: 'CSRF protection', control: 'boolean' },
      { path: 'security.trustedOrigins', label: 'Trusted origins', control: 'string[]' },
      { path: 'security.rateLimitEnabled', label: 'Rate limiting', control: 'boolean' },
      { path: 'security.rateLimitPerMinute', label: 'Requests / minute', control: 'number' },
      { path: 'security.allowedModels', label: 'Allowed LLM models (empty = any; * glob ok)', control: 'string[]' },
    ],
  },
  {
    key: 'governance',
    label: 'Governance',
    description: 'Runtime guardrails for agent activity. Review the queues under the Governance page.',
    fields: [
      {
        path: 'governance.toolPinning',
        label: 'Tool-definition pinning (rug-pull defence)',
        control: 'enum',
        options: TOOL_PINNING_MODES,
        help: 'off = ignore · audit = record + audit any tool-definition change · enforce = also quarantine a changed tool until re-approved under Governance → Tool changes.',
      },
      { path: 'governance.dailyCallBudget', label: 'Daily tool-call budget (0 = off)', control: 'number' },
      { path: 'governance.dailyTokenBudget', label: 'Daily LLM token budget (0 = off)', control: 'number' },
      { path: 'governance.budgetAction', label: 'When a budget is exceeded', control: 'enum', options: BUDGET_ACTIONS },
    ],
  },
  {
    key: 'mcp',
    label: 'MCP transports',
    fields: [
      { path: 'mcp.enableStreamableHttp', label: 'Streamable HTTP', control: 'boolean' },
      { path: 'mcp.enableSse', label: 'SSE (legacy)', control: 'boolean' },
      { path: 'mcp.enableStdio', label: 'stdio (local servers)', control: 'boolean' },
      { path: 'mcp.requestTimeoutMs', label: 'Request timeout (ms)', control: 'number' },
      { path: 'mcp.keepAliveIntervalMs', label: 'Keepalive interval (ms)', control: 'number' },
      { path: 'mcp.maxContentSizeBytes', label: 'Max content size (bytes)', control: 'number' },
    ],
  },
  {
    key: 'federation',
    label: 'Federation',
    fields: [
      { path: 'federation.autoReconnect', label: 'Auto-reconnect upstreams', control: 'boolean' },
      { path: 'federation.healthCheckIntervalMs', label: 'Health-check interval (ms)', control: 'number' },
      { path: 'federation.allowAllDomains', label: 'Allow all domains', control: 'boolean' },
      { path: 'federation.allowedDomains', label: 'Allowed domains', control: 'string[]' },
    ],
  },
  {
    key: 'auth',
    label: 'Authentication',
    fields: [
      { path: 'auth.passwordLoginEnabled', label: 'Local password login', control: 'boolean' },
      { path: 'auth.publicRegistrationEnabled', label: 'Public registration', control: 'boolean' },
      { path: 'auth.sessionTtlMinutes', label: 'Session TTL (minutes)', control: 'number' },
      { path: 'auth.idleTimeoutMinutes', label: 'Idle timeout (minutes, 0 = off)', control: 'number' },
      { path: 'auth.loginRateLimit.enabled', label: 'Login rate limit', control: 'boolean' },
      { path: 'auth.loginRateLimit.maxAttempts', label: 'Rate limit · max attempts', control: 'number' },
      { path: 'auth.loginRateLimit.windowSeconds', label: 'Rate limit · window (seconds)', control: 'number' },
    ],
  },
  {
    key: 'observability',
    label: 'Observability',
    fields: [
      { path: 'observability.metricsEnabled', label: 'Prometheus /metrics', control: 'boolean' },
      { path: 'observability.otlpEndpoint', label: 'OTLP endpoint', control: 'string' },
      { path: 'observability.logLevel', label: 'Log level', control: 'enum', options: LOG_LEVELS },
      { path: 'observability.auditWebhookUrl', label: 'Audit SIEM webhook (POST each audit event)', control: 'string' },
    ],
  },
];
