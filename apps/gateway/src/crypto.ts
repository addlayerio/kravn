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
 * Stored format: <prefix><base64url(nonce(12) || ciphertext || tag(16))>
 *   enc:v1:  — key derived from the bootstrap secret (KRAVN_SECRET / secret.key). The default.
 *   enc:v2:  — key is a Data Encryption Key (DEK) unwrapped at boot from an external KMS/HSM
 *              (envelope encryption; see crypto/kms). The KEK never leaves the KMS.
 *
 * The Encryptor writes with the ACTIVE key and can read any format for which it holds a key, so an
 * install can adopt a KMS without a bulk re-encryption: existing enc:v1: values keep decrypting via the
 * retained bootstrap key (a read-only fallback), and new/edited secrets are written as enc:v2:.
 */
export const ENC_PREFIX_V1 = 'enc:v1:';
export const ENC_PREFIX_V2 = 'enc:v2:';
const KNOWN_ENC_PREFIXES = [ENC_PREFIX_V1, ENC_PREFIX_V2];

export interface KeyEntry {
  /** Ciphertext prefix this key reads/writes (e.g. 'enc:v1:'). */
  prefix: string;
  /** 32-byte AES-256 key. */
  key: Buffer;
}

export interface KeySet {
  /** Key used for NEW writes. */
  active: KeyEntry;
  /** Every key usable to DECRYPT (includes `active`; extra entries are read-only fallbacks). */
  readers: KeyEntry[];
}

/** The default (no-KMS) key set: one key derived from the bootstrap secret, byte-compatible with pre-v2 data. */
export function bootstrapKeySet(secret: string): KeySet {
  const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const entry: KeyEntry = { prefix: ENC_PREFIX_V1, key };
  return { active: entry, readers: [entry] };
}

export class Encryptor {
  private readonly active: KeyEntry;
  private readonly readers: KeyEntry[];

  constructor(keys: KeySet) {
    this.active = keys.active;
    // De-dup by prefix; the active key is always a reader too.
    const seen = new Set<string>();
    this.readers = [];
    for (const e of [keys.active, ...keys.readers]) {
      if (!seen.has(e.prefix)) {
        seen.add(e.prefix);
        this.readers.push(e);
      }
    }
  }

  /** True if `value` is a recognizable Kravn ciphertext (any known format), whether or not we can decrypt it. */
  isEncrypted(value: string): boolean {
    return typeof value === 'string' && KNOWN_ENC_PREFIXES.some((p) => value.startsWith(p));
  }

  encrypt(plaintext: string): string {
    if (plaintext === '') return '';
    if (this.isEncrypted(plaintext)) return plaintext; // idempotent passthrough
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.active.key, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([nonce, ct, tag]).toString('base64url');
    const out = this.active.prefix + blob;
    // Fail-closed sanity check: never return something that isn't recognizably encrypted.
    if (!this.isEncrypted(out)) throw new Error('encryption produced an invalid blob');
    return out;
  }

  decrypt(stored: string): string {
    if (stored === '') return '';
    const reader = this.readers.find((r) => stored.startsWith(r.prefix));
    if (!reader) {
      // A recognizable Kravn ciphertext we hold NO key for = a misconfiguration (e.g. a KMS that was
      // configured, used, then removed). FAIL LOUD rather than returning ciphertext that would be mistaken
      // for the secret and handed to an upstream. Genuine legacy plaintext (no enc: prefix) still passes
      // through so unencrypted-at-rest reads don't break.
      if (this.isEncrypted(stored)) {
        throw new Error('cannot decrypt: value uses an encryption key this process does not hold (KMS/key misconfigured?)');
      }
      return stored;
    }
    const raw = Buffer.from(stored.slice(reader.prefix.length), 'base64url');
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', reader.key, nonce);
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
