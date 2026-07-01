import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { roleSchema } from '@kravn/contracts';
import type { UserRecord } from '../db/repos.js';
import type { Services } from '../services.js';
import { hashPassword, newId } from '../crypto.js';
import { bearerToken } from '../auth/plugin.js';
import { deriveBaseUrl } from '../http/baseurl.js';

const SCIM_CT = 'application/scim+json';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';

/**
 * SCIM 2.0 provisioning endpoint (`/scim/v2/*`) so an IdP (Entra/AD) can create, update, deactivate and
 * delete users independently of login — the provisioning half that SAML (authentication) doesn't cover.
 * Authenticated by a bearer token whose hash Kravn stores (see ScimService); this is a machine path, NOT
 * gated by the admin console. SCIM never mints admins (role is a fixed defaultRole) and never deactivates
 * an existing admin (so an AD sync can't lock out a Kravn administrator). Admin management of the token
 * lives under `/api/scim/*` (control-plane, users.write).
 */
export function scimRoutes(app: FastifyInstance, s: Services): void {
  const scimError = (reply: FastifyReply, status: number, detail: string, scimType?: string) =>
    reply
      .code(status)
      .header('content-type', SCIM_CT)
      .send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(status), detail, ...(scimType ? { scimType } : {}) });

  const scimSend = (reply: FastifyReply, status: number, body: unknown) =>
    reply.code(status).header('content-type', SCIM_CT).send(body);

  function toScimUser(base: string, u: UserRecord | Omit<UserRecord, 'passwordHash'>): Record<string, unknown> {
    const parts = (u.name || '').trim().split(/\s+/);
    return {
      schemas: [USER_SCHEMA],
      id: u.id,
      userName: u.email,
      name: { formatted: u.name || '', givenName: parts[0] || '', familyName: parts.slice(1).join(' ') || '' },
      displayName: u.name || u.email,
      active: !u.disabled,
      emails: [{ value: u.email, primary: true, type: 'work' }],
      meta: { resourceType: 'User', location: `${base}/scim/v2/Users/${u.id}` },
    };
  }

  const displayNameFrom = (body: any): string => {
    if (typeof body?.displayName === 'string' && body.displayName.trim()) return body.displayName.trim();
    const g = body?.name?.givenName ?? '';
    const f = body?.name?.familyName ?? '';
    return `${g} ${f}`.trim() || (body?.name?.formatted ?? '');
  };
  const emailFrom = (body: any): string => {
    if (typeof body?.userName === 'string' && body.userName.includes('@')) return body.userName.trim().toLowerCase();
    const primary = Array.isArray(body?.emails) ? body.emails.find((e: any) => e?.primary) ?? body.emails[0] : null;
    return String(primary?.value ?? body?.userName ?? '').trim().toLowerCase();
  };

  // ─── Bearer auth for every /scim/v2 route ────────────────────────────────────────────────────────
  const scimAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(req);
    if (!token || !(await s.scim.verifyBearer(token))) {
      reply.header('WWW-Authenticate', 'Bearer');
      return scimError(reply, 401, 'Missing or invalid SCIM bearer token.');
    }
  };
  const scim = { preHandler: [scimAuth] };

  // ─── Discovery (Entra probes these during setup) ─────────────────────────────────────────────────
  app.get('/scim/v2/ServiceProviderConfig', scim, async (req, reply) =>
    scimSend(reply, 200, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: `${deriveBaseUrl(req, s.settings, s.env)}`,
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'Bearer token authentication.' }],
    }),
  );
  app.get('/scim/v2/ResourceTypes', scim, async (req, reply) =>
    scimSend(reply, 200, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 1,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: USER_SCHEMA,
          meta: { resourceType: 'ResourceType', location: `${deriveBaseUrl(req, s.settings, s.env)}/scim/v2/ResourceTypes/User` },
        },
      ],
    }),
  );
  app.get('/scim/v2/Schemas', scim, async (_req, reply) =>
    scimSend(reply, 200, { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 1, Resources: [{ id: USER_SCHEMA, name: 'User' }] }),
  );

  // ─── Users ───────────────────────────────────────────────────────────────────────────────────────
  app.get('/scim/v2/Users', scim, async (req, reply) => {
    const base = deriveBaseUrl(req, s.settings, s.env);
    const q = req.query as { filter?: string; startIndex?: string; count?: string };
    const all = await s.repos.users.list();
    let matched = all;
    const m = String(q.filter ?? '').match(/userName\s+eq\s+"([^"]+)"/i);
    if (m) {
      const email = m[1].toLowerCase();
      matched = all.filter((u) => u.email.toLowerCase() === email);
    }
    // SCIM 1-based pagination; clamp count so a client can't ask for an unbounded page.
    const startIndex = Math.max(1, parseInt(String(q.startIndex ?? '1'), 10) || 1);
    const count = Math.min(200, Math.max(0, parseInt(String(q.count ?? '200'), 10) || 200));
    const page = matched.slice(startIndex - 1, startIndex - 1 + count);
    return scimSend(reply, 200, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: matched.length,
      startIndex,
      itemsPerPage: page.length,
      Resources: page.map((u) => toScimUser(base, u)),
    });
  });

  app.get('/scim/v2/Users/:id', scim, async (req, reply) => {
    const { id } = req.params as { id: string };
    const u = await s.repos.users.getById(id);
    if (!u) return scimError(reply, 404, 'User not found.');
    return scimSend(reply, 200, toScimUser(deriveBaseUrl(req, s.settings, s.env), u));
  });

  app.post('/scim/v2/Users', scim, async (req, reply) => {
    const base = deriveBaseUrl(req, s.settings, s.env);
    const body = req.body as any;
    const email = emailFrom(body);
    if (!email || !email.includes('@')) return scimError(reply, 400, 'userName (email) is required.', 'invalidValue');
    const existing = await s.repos.users.getByEmail(email);
    if (existing) return scimError(reply, 409, 'A user with this userName already exists.', 'uniqueness');
    const active = body?.active === undefined ? true : body.active === true || body.active === 'True' || body.active === 'true';
    const user = await s.repos.users.create({
      id: newId(),
      email,
      name: displayNameFrom(body),
      role: await s.scim.provisioningRole(), // never admin
      passwordHash: hashPassword(newId() + newId()), // SCIM users sign in via SSO, not a usable password
    });
    if (!active) await s.repos.users.update(user.id, { disabled: true });
    const fresh = (await s.repos.users.getById(user.id))!;
    return scimSend(reply, 201, toScimUser(base, fresh));
  });

  /** Apply a PUT (full replace) or PATCH ops to a user. Never disables an admin; never changes role. */
  async function applyChanges(
    target: UserRecord,
    changes: { email?: string; name?: string; active?: boolean },
  ): Promise<void> {
    const patch: { name?: string; email?: string; disabled?: boolean } = {};
    if (changes.name !== undefined) patch.name = changes.name;
    if (changes.email && changes.email !== target.email) patch.email = changes.email;
    if (changes.active !== undefined && target.role !== 'admin') patch.disabled = !changes.active; // never deactivate an admin
    if (Object.keys(patch).length) await s.repos.users.update(target.id, patch);
  }

  app.put('/scim/v2/Users/:id', scim, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await s.repos.users.getById(id);
    if (!target) return scimError(reply, 404, 'User not found.');
    const body = req.body as any;
    const email = emailFrom(body);
    if (email && email !== target.email) {
      const clash = await s.repos.users.getByEmail(email);
      if (clash && clash.id !== id) return scimError(reply, 409, 'A user with this userName already exists.', 'uniqueness');
    }
    const active = body?.active === undefined ? !target.disabled : body.active === true || body.active === 'True' || body.active === 'true';
    await applyChanges(target, { email: email || undefined, name: displayNameFrom(body) || target.name, active });
    return scimSend(reply, 200, toScimUser(deriveBaseUrl(req, s.settings, s.env), (await s.repos.users.getById(id))!));
  });

  app.patch('/scim/v2/Users/:id', scim, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await s.repos.users.getById(id);
    if (!target) return scimError(reply, 404, 'User not found.');
    const ops = (req.body as any)?.Operations ?? (req.body as any)?.operations ?? [];
    const changes: { email?: string; name?: string; active?: boolean } = {};
    for (const op of Array.isArray(ops) ? ops : []) {
      const path = String(op?.path ?? '').toLowerCase();
      const val = op?.value;
      const setActive = (v: unknown) => {
        changes.active = v === true || v === 'True' || v === 'true';
      };
      if (path === 'active') setActive(val);
      else if (path === 'displayname' || path === 'name.formatted') changes.name = String(val ?? '');
      else if (path === 'username' || path === 'emails[type eq "work"].value') changes.email = String(val ?? '').toLowerCase();
      else if (!path && val && typeof val === 'object') {
        // path-less replace: value is an object of attributes
        if ('active' in val) setActive((val as any).active);
        if (typeof (val as any).displayName === 'string') changes.name = (val as any).displayName;
        if (typeof (val as any).userName === 'string') changes.email = String((val as any).userName).toLowerCase();
      }
    }
    await applyChanges(target, changes);
    return scimSend(reply, 200, toScimUser(deriveBaseUrl(req, s.settings, s.env), (await s.repos.users.getById(id))!));
  });

  app.delete('/scim/v2/Users/:id', scim, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await s.repos.users.getById(id);
    if (!target) return scimError(reply, 404, 'User not found.');
    // Soft delete: deactivate rather than destroy (keeps history; the ABM can hard-delete). Never an admin.
    if (target.role !== 'admin') await s.repos.users.update(id, { disabled: true });
    return reply.code(204).send();
  });

  // ─── Admin management of the SCIM token (control-plane, users.write) ─────────────────────────────
  const write = { preHandler: [app.authenticate, app.authorize('users.write')] };

  app.get('/api/scim/config', write, async () => s.scim.status());

  app.post('/api/scim/token', write, async (_req, reply) => {
    const token = await s.scim.rotateToken();
    // Returned exactly once — only its hash is stored.
    return reply.code(201).send({ token, note: 'Copy this now — it will not be shown again.' });
  });

  app.put('/api/scim/config', write, async (req, reply) => {
    const body = (req.body ?? {}) as { enabled?: boolean; defaultRole?: string };
    if (typeof body.enabled === 'boolean') await s.scim.setEnabled(body.enabled);
    if (body.defaultRole !== undefined) {
      const role = roleSchema.safeParse(body.defaultRole);
      if (!role.success) return reply.code(400).send({ error: { code: 'bad_role', message: 'Invalid default role.' } });
      await s.scim.setDefaultRole(role.data);
    }
    return s.scim.status();
  });

  app.delete('/api/scim/token', write, async (_req, reply) => {
    await s.scim.clearToken();
    return reply.code(204).send();
  });
}
