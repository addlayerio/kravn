import crypto from 'node:crypto';

/**
 * Password hashing via node:crypto scrypt (no native dependency).
 * Format: scrypt$<saltB64>$<hashB64>
 */
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Credential-at-rest encryption (AES-256-GCM). FAIL-CLOSED: if encryption is requested and fails,
 * we throw rather than silently persisting plaintext.
 *
 * Stored format: enc:v1:<base64url(nonce(12) || ciphertext || tag(16))>
 */
const ENC_PREFIX = 'enc:v1:';

export class Encryptor {
  private readonly key: Buffer;

  constructor(secret: string) {
    // Derive a stable 32-byte key from the bootstrap secret.
    this.key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  }

  isEncrypted(value: string): boolean {
    return typeof value === 'string' && value.startsWith(ENC_PREFIX);
  }

  encrypt(plaintext: string): string {
    if (plaintext === '') return '';
    if (this.isEncrypted(plaintext)) return plaintext; // idempotent passthrough
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([nonce, ct, tag]).toString('base64url');
    const out = ENC_PREFIX + blob;
    // Fail-closed sanity check: never return something that isn't recognizably encrypted.
    if (!this.isEncrypted(out)) throw new Error('encryption produced an invalid blob');
    return out;
  }

  decrypt(stored: string): string {
    if (stored === '') return '';
    if (!this.isEncrypted(stored)) {
      // Legacy/plaintext value — return as-is so reads don't break, but this should not happen.
      return stored;
    }
    const raw = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64url');
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function newJti(): string {
  return crypto.randomBytes(16).toString('base64url');
}

export function slugify(input: string): string {
  const stripped = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return stripped || 'item';
}

/** Stable hex digest prefix of an input, for deriving bounded-length deterministic ids. */
export function shortHash(input: string, length = 12): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
}
