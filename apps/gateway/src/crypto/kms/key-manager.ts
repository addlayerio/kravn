import crypto from 'node:crypto';
import type { Logger } from 'pino';
import type { Store } from '../../db/store.js';
import type { Env } from '../../config/env.js';
import { Encryptor, bootstrapKeySet, ENC_PREFIX_V2, type KeyEntry } from '../../crypto.js';
import { createKmsProvider, type KmsProvider } from './key-provider.js';

const KEYRING_ID = 'default';

/**
 * Resolves the at-rest encryption key set at boot and hands back a ready Encryptor.
 *
 * - Default (no KMS): the Encryptor uses the bootstrap-secret key (`enc:v1:`), exactly as before.
 * - KMS mode: the Data Encryption Key (`enc:v2:`) is unwrapped from the external KMS/HSM once, and the
 *   bootstrap-secret key is retained as a READ-ONLY fallback so any pre-existing `enc:v1:` secrets keep
 *   decrypting — they upgrade to `enc:v2:` on their next save (lazy migration; no bulk re-encryption).
 *
 * All KMS network I/O happens here (async, at boot). encrypt()/decrypt() stay synchronous on the
 * in-memory key set, so no call site changes.
 */
export class KeyManager {
  private constructor(
    readonly encryptor: Encryptor,
    readonly mode: 'bootstrap' | 'kms',
    readonly providerId: 'vault' | 'azure' | null,
  ) {}

  static async create(deps: { env: Env; secret: string; store: Store; log: Logger }): Promise<KeyManager> {
    const { env, secret, store, log } = deps;
    const provider = createKmsProvider(env.kms);
    if (!provider) {
      return new KeyManager(new Encryptor(bootstrapKeySet(secret)), 'bootstrap', null);
    }

    const dek = await resolveDek(provider, store, log);
    const active: KeyEntry = { prefix: ENC_PREFIX_V2, key: dek };
    const readers: KeyEntry[] = [active];
    // Retain the bootstrap key as a read fallback so existing enc:v1: data still decrypts after adopting KMS.
    if (secret) readers.push(bootstrapKeySet(secret).active);

    log.info({ provider: provider.id }, 'key management: external KMS active (envelope encryption)');
    return new KeyManager(new Encryptor({ active, readers }), 'kms', provider.id);
  }
}

/** Load and unwrap the stored DEK, or provision one on first boot (persisting only the wrapped form). */
async function resolveDek(provider: KmsProvider, store: Store, log: Logger): Promise<Buffer> {
  const existing = await readKeyring(store);
  if (existing) {
    if (existing.provider !== provider.id) {
      throw new Error(
        `app_keyring was created with KMS provider '${existing.provider}' but KRAVN_KMS_PROVIDER is ` +
          `'${provider.id}'. Changing KMS providers requires a re-key migration, not a config swap.`,
      );
    }
    return provider.unwrapKey(existing.wrapped);
  }

  // First boot under this KMS: generate a DEK, wrap it with the external KEK, persist ONLY the wrapped form.
  const dek = crypto.randomBytes(32);
  const wrapped = await provider.wrapKey(dek);
  try {
    await store.run('INSERT INTO app_keyring (id, provider, wrapped_dek, created_at) VALUES (?, ?, ?, ?)', [
      KEYRING_ID,
      provider.id,
      wrapped,
      new Date().toISOString(),
    ]);
    log.info({ provider: provider.id }, 'key management: provisioned a new DEK (wrapped by the KMS)');
    return dek;
  } catch (err) {
    // Race: another replica inserted the keyring first. Re-read and unwrap the winning DEK so replicas agree.
    const row = await readKeyring(store);
    if (row) {
      log.warn({ err }, 'key management: keyring insert raced; using the persisted DEK');
      return provider.unwrapKey(row.wrapped);
    }
    throw err;
  }
}

async function readKeyring(store: Store): Promise<{ provider: string; wrapped: string } | null> {
  const row = await store.get<{ provider: string; wrapped_dek: string }>(
    'SELECT provider, wrapped_dek FROM app_keyring WHERE id = ?',
    [KEYRING_ID],
  );
  return row ? { provider: row.provider, wrapped: row.wrapped_dek } : null;
}
