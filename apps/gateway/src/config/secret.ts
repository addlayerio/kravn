import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Env } from './env.js';

/**
 * Resolve the signing/encryption secret.
 *
 * - If KRAVN_SECRET is set, use it (required, and shared, for multi-replica deployments).
 * - Otherwise (single-node, zero-config), generate one once and persist it to
 *   <dataDir>/secret.key so restarts keep the same key. This is what lets Kravn
 *   "boot of one" without the operator having to invent a secret.
 */
export function resolveSecret(env: Env): string {
  if (env.rawSecret && env.rawSecret.length >= 16) return env.rawSecret;

  const keyPath = path.resolve(env.dataDir, 'secret.key');
  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, 'utf8').trim();
      if (existing.length >= 16) return existing;
    }
  } catch {
    /* fall through to generate */
  }

  const generated = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(env.dataDir, { recursive: true });
  fs.writeFileSync(keyPath, generated, { mode: 0o600 });
  return generated;
}
