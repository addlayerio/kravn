import type { KmsConfig } from '../../config/env.js';

/**
 * A KMS/HSM key provider performs ENVELOPE encryption: it wraps (encrypts) and unwraps (decrypts) a
 * 32-byte Data Encryption Key (DEK) using a Key Encryption Key (KEK) that never leaves the KMS/HSM.
 * Kravn generates the DEK, has the provider wrap it, persists ONLY the wrapped form (see app_keyring),
 * and unwraps it into memory once at boot.
 *
 * The provider endpoint is operator-supplied infrastructure config (from the environment, like
 * DATABASE_URL) — it is NOT attacker/user-controlled, so it is trusted the same way (no SSRF allowlist;
 * an internal Vault address is legitimate). Every call is bounded: no redirects, a hard timeout, and a
 * capped response read.
 */
export interface KmsProvider {
  readonly id: 'vault' | 'azure';
  /** Wrap a 32-byte DEK with the KMS KEK; returns an opaque token to persist. */
  wrapKey(dek: Buffer): Promise<string>;
  /** Unwrap a token produced by wrapKey back into the 32-byte DEK. */
  unwrapKey(wrapped: string): Promise<Buffer>;
}

const KMS_TIMEOUT_MS = 10_000;
const KMS_MAX_RESPONSE = 100_000;

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return 'kms';
  }
}

/** POST JSON to a KMS endpoint with no redirects, a hard timeout, and a capped response. Returns parsed JSON. */
async function kmsPostJson(url: string, headers: Record<string, string>, body: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(KMS_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`KMS request to ${hostOf(url)} failed: ${(err as Error).message}`);
  }
  const text = (await res.text()).slice(0, KMS_MAX_RESPONSE);
  if (!res.ok) throw new Error(`KMS request to ${hostOf(url)} returned ${res.status}: ${text.slice(0, 300)}`);
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`KMS response from ${hostOf(url)} was not JSON`);
  }
}

function assertDek(buf: Buffer, who: string): Buffer {
  if (buf.length !== 32) throw new Error(`${who}: unwrapped DEK is not 32 bytes (got ${buf.length})`);
  return buf;
}

/**
 * HashiCorp Vault Transit — "encryption as a service". POST transit/encrypt|decrypt with a base64 payload.
 * Vault holds the KEK (and, with an HSM auto-unseal / Enterprise Managed Keys, in an HSM).
 */
class VaultTransitProvider implements KmsProvider {
  readonly id = 'vault' as const;
  constructor(private readonly cfg: { addr: string; token: string; key: string; namespace?: string }) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'x-vault-token': this.cfg.token };
    if (this.cfg.namespace) h['x-vault-namespace'] = this.cfg.namespace;
    return h;
  }

  async wrapKey(dek: Buffer): Promise<string> {
    const url = `${this.cfg.addr}/v1/transit/encrypt/${encodeURIComponent(this.cfg.key)}`;
    const res = await kmsPostJson(url, this.headers(), JSON.stringify({ plaintext: dek.toString('base64') }));
    const ct = (res.data as { ciphertext?: string } | undefined)?.ciphertext;
    if (!ct) throw new Error('vault: transit/encrypt returned no ciphertext');
    return ct; // e.g. "vault:v1:...."
  }

  async unwrapKey(wrapped: string): Promise<Buffer> {
    const url = `${this.cfg.addr}/v1/transit/decrypt/${encodeURIComponent(this.cfg.key)}`;
    const res = await kmsPostJson(url, this.headers(), JSON.stringify({ ciphertext: wrapped }));
    const pt = (res.data as { plaintext?: string } | undefined)?.plaintext;
    if (!pt) throw new Error('vault: transit/decrypt returned no plaintext');
    return assertDek(Buffer.from(pt, 'base64'), 'vault');
  }
}

/**
 * Azure Key Vault — wrapKey/unwrapKey against a key (RSA-OAEP-256). The private key never leaves the vault
 * (or the Managed HSM). Auth is Entra client-credentials for the vault resource, same pattern the Graph
 * plugins use, cached until shortly before expiry.
 */
class AzureKeyVaultProvider implements KmsProvider {
  readonly id = 'azure' as const;
  private token?: { value: string; exp: number };
  constructor(
    private readonly cfg: { vaultUrl: string; key: string; tenantId: string; clientId: string; clientSecret: string },
  ) {}

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.exp > now + 60_000) return this.token.value;
    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          scope: 'https://vault.azure.net/.default',
          grant_type: 'client_credentials',
        }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(KMS_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`azure: token request failed: ${(err as Error).message}`);
    }
    const text = (await res.text()).slice(0, KMS_MAX_RESPONSE);
    if (!res.ok) throw new Error(`azure: token request returned ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('azure: no access_token from Entra');
    this.token = { value: json.access_token, exp: now + Number(json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  private keyOp(op: 'wrapkey' | 'unwrapkey'): string {
    // cfg.key may be "name" (latest version) or "name/version".
    return `${this.cfg.vaultUrl}/keys/${this.cfg.key}/${op}?api-version=7.4`;
  }

  async wrapKey(dek: Buffer): Promise<string> {
    const token = await this.accessToken();
    const res = await kmsPostJson(
      this.keyOp('wrapkey'),
      { authorization: `Bearer ${token}` },
      JSON.stringify({ alg: 'RSA-OAEP-256', value: dek.toString('base64url') }),
    );
    const val = res.value as string | undefined;
    if (!val) throw new Error('azure: wrapkey returned no value');
    return val; // base64url
  }

  async unwrapKey(wrapped: string): Promise<Buffer> {
    const token = await this.accessToken();
    const res = await kmsPostJson(
      this.keyOp('unwrapkey'),
      { authorization: `Bearer ${token}` },
      JSON.stringify({ alg: 'RSA-OAEP-256', value: wrapped }),
    );
    const val = res.value as string | undefined;
    if (!val) throw new Error('azure: unwrapkey returned no value');
    return assertDek(Buffer.from(val, 'base64url'), 'azure');
  }
}

/** Build the configured KMS provider, or null when key management is the default (bootstrap-secret) mode. */
export function createKmsProvider(kms: KmsConfig): KmsProvider | null {
  switch (kms.provider) {
    case 'vault':
      return new VaultTransitProvider(kms.vault);
    case 'azure':
      return new AzureKeyVaultProvider(kms.azure);
    case 'none':
    default:
      return null;
  }
}
