import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../services.js';
import { sendError } from './_helpers.js';
import { evaluateFilter } from '../automations/runner.service.js';

/**
 * Signature headers, in the order we trust them. GitHub sends `x-hub-signature-256`; Jira and Bitbucket send
 * `x-hub-signature`; the rest are common enough to be worth accepting so an operator rarely needs a shim.
 */
const SIGNATURE_HEADERS = ['x-hub-signature-256', 'x-hub-signature', 'x-signature-256', 'x-kravn-signature'];
/** Plain shared-secret headers, for senders that can add a header but can't sign. */
const SECRET_HEADERS = ['x-kravn-secret', 'x-webhook-secret', 'x-hook-secret'];
/**
 * Sender-supplied delivery ids. When one is present we can dedupe honestly over a long window; without one we
 * fall back to hashing the body over a SHORT window, because two genuinely distinct events can share a body.
 */
const DELIVERY_ID_HEADERS = ['x-github-delivery', 'x-atlassian-webhook-identifier', 'x-gitlab-event-uuid', 'x-idempotency-key', 'x-request-id', 'x-delivery-id'];
const DEDUPE_WINDOW_WITH_ID = 3_600; // 1h — an explicit id is unique, so a wide window is safe
const DEDUPE_WINDOW_BODY_HASH = 60; // 60s — only catches a retry storm, not a legitimate repeat

function headerValue(req: FastifyRequest, names: string[]): { name: string; value: string } | null {
  for (const n of names) {
    const raw = req.headers[n];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v === 'string' && v.trim()) return { name: n, value: v.trim() };
  }
  return null;
}

/** Constant-time compare that never leaks length through an early return. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Still burn a comparison so a length mismatch isn't measurably faster than a content mismatch.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify an HMAC-SHA256 signature over the RAW body. Accepts both `sha256=<hex>` (GitHub/Jira style) and a
 * bare hex digest. The raw body is required — re-serializing the parsed JSON would change the bytes and every
 * signature would fail.
 */
function verifyHmac(rawBody: string, secret: string, provided: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const got = provided.includes('=') ? provided.slice(provided.indexOf('=') + 1).trim() : provided;
  return safeEqual(expected, got.toLowerCase());
}

/**
 * **Public webhook ingress** — the event trigger for automations.
 *
 * `POST /api/hooks/:token` starts the automation that owns `:token`, with the request body as the event
 * payload. Deliberately unauthenticated in the session sense: the caller is Jira or GitHub, not a Kravn user.
 * What stands in for a session is (a) the unguessable token in the URL, (b) an optional shared secret or HMAC
 * signature, and (c) the fact that the run executes as the automation's OWNER — so the owner's role, teams and
 * tool entitlements remain the hard ceiling on anything the agent can do. A webhook can start work; it can
 * never widen what that work is allowed to touch.
 *
 * Always answers fast (202) and runs the agent detached: webhook senders time out in seconds and an agent run
 * takes minutes. A non-2xx would make the sender retry, so intentional drops (filter didn't match, duplicate
 * delivery, automation paused) answer 200 with a reason instead of an error.
 */
export function hookRoutes(app: FastifyInstance, s: Services): void {
  app.post('/api/hooks/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const found = await s.repos.automations.getByEventToken(token);
    // Unknown token: nothing exists at this URL, and we say nothing more than that.
    if (!found || found.automation.kind !== 'event') return sendError(reply, 404, 'not_found', 'No automation is listening here.');
    const { automation, userId, eventSecretEncrypted } = found;

    // ── Authenticate the sender ───────────────────────────────────────────────
    if (automation.eventAuth !== 'none') {
      const secret = eventSecretEncrypted ? s.encryptor.decrypt(eventSecretEncrypted) : '';
      if (!secret) return sendError(reply, 401, 'unauthorized', 'This automation requires a secret that is not configured.');
      if (automation.eventAuth === 'hmac') {
        const sig = headerValue(req, SIGNATURE_HEADERS);
        const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
        if (!sig || !rawBody || !verifyHmac(rawBody, secret, sig.value)) {
          return sendError(reply, 401, 'unauthorized', 'Invalid signature.');
        }
      } else {
        const provided = headerValue(req, SECRET_HEADERS);
        if (!provided || !safeEqual(secret, provided.value)) return sendError(reply, 401, 'unauthorized', 'Invalid secret.');
      }
    }

    // A paused automation acknowledges and drops — a 4xx here would make the sender retry forever.
    if (!automation.enabled) return reply.code(200).send({ accepted: false, reason: 'disabled' });

    // ── Deduplicate the delivery ──────────────────────────────────────────────
    const delivery = headerValue(req, DELIVERY_ID_HEADERS);
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const dedupeKey = delivery
      ? `hookdup:${automation.id}:${delivery.value}`
      : `hookdup:${automation.id}:body:${crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`;
    const { count: seen } = await s.sharedStore.incr(dedupeKey, delivery ? DEDUPE_WINDOW_WITH_ID : DEDUPE_WINDOW_BODY_HASH);
    if (seen !== 1) return reply.code(200).send({ accepted: false, reason: 'duplicate' });

    // ── Filter ────────────────────────────────────────────────────────────────
    const payload = req.body ?? {};
    const filter = evaluateFilter(automation.eventFilter, payload);
    if (!filter.matched) return reply.code(200).send({ accepted: false, reason: 'filtered', condition: filter.failed });

    // ── Loop / runaway backstop ───────────────────────────────────────────────
    // The classic failure: the agent writes back to the source, the source fires the webhook, and it never
    // stops. A per-automation ceiling bounds that blast radius regardless of which integration caused it.
    //
    // Counted LAST, so only deliveries that actually start a run consume the budget. Senders often can't be
    // narrowed to one event type — subscribing to every Jira issue event and filtering down to `issue_created`
    // is the normal shape — and charging those filtered deliveries would exhaust the ceiling on traffic that
    // never costs a model call.
    if (automation.maxRunsPerHour > 0) {
      const { count } = await s.sharedStore.incr(`hookrate:${automation.id}`, 3_600);
      if (count > automation.maxRunsPerHour) {
        s.log.warn({ automation: automation.id, count }, 'automation hourly ceiling hit — delivery rejected');
        return sendError(reply, 429, 'rate_limited', `This automation has hit its ceiling of ${automation.maxRunsPerHour} runs/hour.`);
      }
    }

    // ── Accept, then run detached ─────────────────────────────────────────────
    // The sender gets its 202 in milliseconds; the agent run continues in the background and records its own
    // outcome in the run history. Nothing awaits it, so a slow model never turns into a webhook timeout.
    reply.code(202).send({ accepted: true, automation: automation.name });
    setImmediate(() => {
      void s.automationRunner.run(automation, userId, 'event', payload);
    });
  });
}
