import type { HookPlugin } from '@kravn/plugin-sdk';
import type { ApprovalService } from '../approvals/approval.service.js';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A simple `*`-glob → anchored, case-insensitive RegExp. */
function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.trim().split('*').map(escapeRe).join('.*')}$`, 'i');
}

/** True if any pattern matches the tool name, the `server/tool` pair, or the server id. */
function matchesAny(patterns: string[], server: string, tool: string): boolean {
  const hay = [tool, `${server}/${tool}`, server];
  return patterns.some((p) => {
    let re: RegExp;
    try {
      re = globToRe(p);
    } catch {
      return false;
    }
    return hay.some((h) => re.test(h));
  });
}

const SECRETISH = /pass|secret|token|key|auth|credential/i;
/** Shallow secret-redacted, bounded JSON of the call arguments for the approver to review. */
function redactPreview(args: unknown): string {
  const redact = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(redact);
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = SECRETISH.test(k) ? '[redacted]' : redact(v[k]);
    return o;
  };
  try {
    return JSON.stringify(redact(args));
  } catch {
    return '{}';
  }
}

/**
 * Human Approval Gate — maker-checker for agent tool calls. Not in native-hooks.ts because it needs the
 * ApprovalService (DB + cross-replica wait); built by a factory with that dependency injected, like the
 * other privileged native plugins.
 */
export function approvalGate(deps: { approvals: ApprovalService }): HookPlugin {
  const onToolCall = async (ctx: any) => {
    const config = ctx.config || {};
    const patterns: string[] = Array.isArray(config.tools) ? config.tools.filter((x: unknown) => typeof x === 'string' && (x as string).trim()) : [];
    if (!patterns.length) return; // opt-in: nothing configured → gate nothing
    const server = String(ctx.server ?? '');
    const tool = String(ctx.tool ?? '');
    if (!matchesAny(patterns, server, tool)) return; // not a high-risk tool → allow through

    const timeoutMs = Math.min(Math.max(Number(config.timeoutSeconds) || 60, 5), 900) * 1000;
    try {
      const id = await deps.approvals.request({
        serverId: server,
        toolName: tool,
        mcpEndpointId: typeof ctx.mcpEndpointId === 'string' ? ctx.mcpEndpointId : undefined,
        actor: ctx.actor && { id: ctx.actor.id, email: ctx.actor.email },
        argsPreview: redactPreview(ctx.arguments),
      });
      const row = await deps.approvals.waitFor(id, timeoutMs);
      if (row.status === 'approved') return; // let the call proceed
      if (row.status === 'denied') {
        ctx.deny(`Denied${row.resolvedBy ? ` by ${row.resolvedBy}` : ''}${row.reason ? `: ${row.reason}` : ''}.`);
        return;
      }
      // expired / not decided in time → bounded-wait fallback: block with a queue id to retry.
      ctx.deny(`Human approval required and not granted within ${Math.round(timeoutMs / 1000)}s. Request queued as ${id}; ask an approver to approve it, then retry this call.`);
    } catch (err) {
      // Fail CLOSED: an approval gate that cannot confirm approval must never let the call through.
      try {
        ctx.log?.(`approval gate error: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        /* best-effort */
      }
      ctx.deny('The approval system is unavailable; this call was blocked for safety. Try again shortly.');
    }
  };

  return {
    manifest: {
      id: 'approval-gate',
      name: 'Human Approval Gate',
      version: '0.1.0',
      type: 'hook',
      description:
        'Maker-checker for agent actions: a matching tool call is HELD until a human approves it. Approved → the call runs; denied → blocked; not decided within the timeout → blocked with a queue id to retry (bounded-wait). Configure which tools require approval (glob on tool name or server/tool) and the wait timeout. Fails closed and is multi-replica safe.',
      author: 'Kravn',
      priority: 1,
      configSchema: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: { type: 'string' },
            title: 'Tools requiring approval — glob on the TOOL NAME (recommended, e.g. *delete*, *transfer*), or on server-id/tool. Note: matches the server id, not its display name.',
          },
          timeoutSeconds: { type: 'number', title: 'Max seconds to hold the call waiting for approval (5–900)', default: 60 },
        },
      },
    },
    hooks: { onToolCall },
  };
}
