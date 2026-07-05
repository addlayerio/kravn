# Key Management (at-rest encryption)

Kravn encrypts secrets at rest (plugin credentials, SSO/LLM configuration, upstream auth values) with
**AES-256-GCM**. The encryption key can come from the bootstrap secret (the default) or from an external
**KMS/HSM** via envelope encryption — for regulated deployments that must keep key custody in their own
key manager.

## Modes

Selected by `KRAVN_KMS_PROVIDER`:

| Mode | Key source | Ciphertext | When |
|---|---|---|---|
| `none` (default) | `KRAVN_SECRET` / auto-generated `secret.key`, hashed to a 256-bit key | `enc:v1:…` | Zero-config, single-node, or where env-managed secrets are acceptable |
| `vault` | HashiCorp Vault **Transit** wraps/unwraps the Data Encryption Key (DEK) | `enc:v2:…` | Vault-based orgs; HSM-backed with a Vault HSM seal / Managed Keys |
| `azure` | **Azure Key Vault** `wrapKey`/`unwrapKey` (RSA-OAEP-256) | `enc:v2:…` | Azure/Entra orgs; HSM-backed with Managed HSM |

## How it works (envelope encryption)

Kravn never holds your master key. In KMS mode:

1. On first boot Kravn generates a random 256-bit **DEK**, asks the KMS to **wrap** (encrypt) it with your
   **KEK** (which never leaves the KMS/HSM), and stores **only the wrapped DEK** in the `app_keyring` table.
2. On every boot it **unwraps** the DEK once (a single KMS call), holds it in memory, and uses it to
   encrypt/decrypt secrets locally (fast AES-GCM — no KMS call per secret).
3. Your KMS logs every unwrap (key-usage audit), you hold custody of the KEK, and you can rotate or revoke
   it in the KMS.

## Adopting a KMS on an existing install (no downtime, no bulk re-encryption)

Switching from `none` to a KMS is **safe and incremental**:

- Existing `enc:v1:` secrets keep decrypting — the bootstrap key is retained as a **read-only fallback**
  (so **keep `KRAVN_SECRET` set** after enabling a KMS).
- New and **edited** secrets are written as `enc:v2:` (KMS-wrapped DEK). Secrets you never touch stay
  `enc:v1:` and remain readable; re-saving one upgrades it to `enc:v2:` (lazy migration).

## Configuration

### HashiCorp Vault (Transit)

```
KRAVN_KMS_PROVIDER=vault
KRAVN_KMS_VAULT_ADDR=https://vault.internal:8200
KRAVN_KMS_VAULT_TOKEN=<a token with transit encrypt/decrypt on the key>
KRAVN_KMS_VAULT_KEY=kravn            # transit key name
KRAVN_KMS_VAULT_NAMESPACE=          # Vault Enterprise namespace (optional)
```

Vault setup: `vault secrets enable transit` then `vault write -f transit/keys/kravn`.

### Azure Key Vault

```
KRAVN_KMS_PROVIDER=azure
KRAVN_KMS_AZURE_VAULT_URL=https://<vault>.vault.azure.net
KRAVN_KMS_AZURE_KEY=kravn-kek        # key name, or "name/version"
KRAVN_KMS_AZURE_TENANT_ID=<tenant>
KRAVN_KMS_AZURE_CLIENT_ID=<app registration id>
KRAVN_KMS_AZURE_CLIENT_SECRET=<app secret>
```

The Entra app (client credentials) needs Key Vault **Wrap** and **Unwrap** on the key (e.g. the *Key Vault
Crypto User* role, or an access policy granting wrapKey/unwrapKey). Use an **RSA** (or RSA-HSM) key.

## Operational notes

- **The KMS endpoint is trusted infrastructure config** (like `DATABASE_URL`): it comes only from the
  environment, never from a user/request, so it is not subject to the SSRF allowlist (an internal Vault
  address is legitimate). Calls are still bounded (no redirects, 10s timeout, capped response).
- **Fail-closed:** if a KMS is configured but unreachable/misconfigured at boot, the gateway **fails to
  start** rather than silently falling back to unencrypted or a different key.
- **Do not change providers in place.** The keyring records which KMS wrapped the DEK; pointing
  `KRAVN_KMS_PROVIDER` at a different KMS is rejected (a vault-wrapped DEK can't be unwrapped by Azure).
  Switching KMS requires a deliberate re-key migration.
- **Do not remove a KMS after adopting it.** Once secrets are written as `enc:v2:`, decryption needs the
  DEK. If you set `KRAVN_KMS_PROVIDER=none` again, those secrets can't be read: decryption **fails loudly**
  (it never returns the ciphertext as if it were the value). Re-point the KMS to recover.
- **Multi-replica:** the first replica to boot provisions the keyring; the others read and unwrap the same
  DEK, so all replicas converge on one key.

## Limits / roadmap

- **KEK rotation** in the KMS is supported by the KMS itself; a Kravn-side **re-key/re-encrypt** command
  (bulk upgrade `enc:v1:` → `enc:v2:`, and DEK rotation) is planned.
- **JWT signing** still uses the bootstrap secret; splitting the signing key out to the KMS is planned.
- **AWS KMS / GCP KMS** are not yet shipped but slot into the same `KmsProvider` interface.
