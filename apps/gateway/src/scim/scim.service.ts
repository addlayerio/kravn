import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Role } from '@kravn/contracts';
import type { Store } from '../db/store.js';

/**
 * SCIM 2.0 provisioning service. Entra/AD (or any SCIM client) authenticates with a bearer token whose
 * SHA-256 hash we store (never the token itself). Config lives in the `settings` table under id 'scim' —
 * NOT surfaced by /api/settings, so the hash never leaks. SCIM can create/deactivate users but never mint
 * admins: the provisioning role is a fixed, admin-excluded `defaultRole`.
 */
interface ScimStoredConfig {
  enabled: boolean;
  tokenHash: string;
  defaultRole: Role;
}
const DEFAULTS: ScimStoredConfig = { enabled: false, tokenHash: '', defaultRole: 'viewer' };

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export class ScimService {
  constructor(private store: Store) {}

  private async load(): Promise<ScimStoredConfig> {
    const r = await this.store.get<{ data: string }>('SELECT data FROM settings WHERE id = ?', ['scim']);
    if (!r?.data) return { ...DEFAULTS };
    try {
      return { ...DEFAULTS, ...(JSON.parse(r.data) as Partial<ScimStoredConfig>) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  private async save(c: ScimStoredConfig): Promise<void> {
    const data = JSON.stringify(c);
    const ts = new Date().toISOString();
    const existing = await this.store.get('SELECT id FROM settings WHERE id = ?', ['scim']);
    if (existing) await this.store.run('UPDATE settings SET data = ?, updated_at = ? WHERE id = ?', [data, ts, 'scim']);
    else await this.store.run('INSERT INTO settings (id, data, updated_at) VALUES (?,?,?)', ['scim', data, ts]);
  }

  /** SCIM never provisions admins — clamp any admin request down to editor. */
  private safeRole(role: Role): Role {
    return role === 'admin' ? 'editor' : role;
  }

  async status(): Promise<{ enabled: boolean; hasToken: boolean; defaultRole: Role }> {
    const c = await this.load();
    return { enabled: c.enabled, hasToken: !!c.tokenHash, defaultRole: c.defaultRole };
  }

  async setDefaultRole(role: Role): Promise<void> {
    const c = await this.load();
    c.defaultRole = this.safeRole(role);
    await this.save(c);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const c = await this.load();
    c.enabled = enabled;
    await this.save(c);
  }

  /** Generate a new bearer token (returned ONCE), persist only its hash, and enable SCIM. */
  async rotateToken(): Promise<string> {
    const token = `scim_${randomBytes(32).toString('base64url')}`;
    const c = await this.load();
    c.tokenHash = sha256(token);
    c.enabled = true;
    await this.save(c);
    return token;
  }

  async clearToken(): Promise<void> {
    const c = await this.load();
    c.tokenHash = '';
    c.enabled = false;
    await this.save(c);
  }

  /** Timing-safe check of a presented bearer token against the stored hash (only when SCIM is enabled). */
  async verifyBearer(bearer: string): Promise<boolean> {
    const c = await this.load();
    if (!c.enabled || !c.tokenHash || !bearer) return false;
    const a = Buffer.from(sha256(bearer), 'hex');
    const b = Buffer.from(c.tokenHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async provisioningRole(): Promise<Role> {
    return (await this.load()).defaultRole;
  }
}
