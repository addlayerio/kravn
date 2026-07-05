# Key management (KMS/HSM)

Kravn encrypts secrets at rest — plugin credentials, SSO and LLM configuration, upstream auth — with
AES-256-GCM. By default the encryption key is derived from your signing secret (`KRAVN_SECRET`). For
regulated deployments that must keep **key custody in their own key manager**, Kravn can instead use an
external **KMS/HSM**: your master key never leaves the KMS, and your key manager logs every use.

## Why it matters

A bank or regulated org typically can't accept a long-lived symmetric key sitting in an environment
variable. With an external KMS you get **custody** (the key lives in your Vault/HSM, not in Kravn),
**auditability** (the KMS logs every unwrap), and **rotation and revocation** on your terms.

## Modes

Selected with `KRAVN_KMS_PROVIDER`:

| Mode | Key source | When |
|---|---|---|
| `none` *(default)* | Derived from `KRAVN_SECRET` / auto-generated `secret.key` | Zero-config or where env-managed secrets are acceptable |
| `vault` | **HashiCorp Vault** (Transit engine) wraps the encryption key | Vault-based orgs; HSM-backed with a Vault HSM seal |
| `azure` | **Azure Key Vault** (`wrapKey`/`unwrapKey`) | Azure/Entra orgs; HSM-backed with Managed HSM |

## How it works — envelope encryption

Kravn never holds your master key. In KMS mode:

1. On first boot Kravn generates a random data key, asks the KMS to **wrap** (encrypt) it with your master
   key — which never leaves the KMS/HSM — and stores **only the wrapped key**.
2. On every boot it **unwraps** the data key once (a single KMS call), keeps it in memory, and encrypts and
   decrypts secrets locally — so there's no KMS round-trip per secret.
3. Your KMS records every unwrap, you hold the master key, and you rotate or revoke it there.

## Set up HashiCorp Vault

Enable the Transit engine and create a key:

```bash
vault secrets enable transit
vault write -f transit/keys/kravn
```

Give Kravn a token with `encrypt`/`decrypt` on that key, then configure:

```bash
KRAVN_KMS_PROVIDER=vault
KRAVN_KMS_VAULT_ADDR=https://vault.internal:8200
KRAVN_KMS_VAULT_TOKEN=<token with transit encrypt/decrypt>
KRAVN_KMS_VAULT_KEY=kravn
KRAVN_KMS_VAULT_NAMESPACE=            # Vault Enterprise namespace (optional)
```

## Set up Azure Key Vault

Create an **RSA** (or RSA-HSM) key in your vault, and an Entra app (client credentials) granted **Wrap Key**
and **Unwrap Key** on it — for example the *Key Vault Crypto User* role. Then configure:

```bash
KRAVN_KMS_PROVIDER=azure
KRAVN_KMS_AZURE_VAULT_URL=https://<vault>.vault.azure.net
KRAVN_KMS_AZURE_KEY=kravn-kek         # key name, or "name/version"
KRAVN_KMS_AZURE_TENANT_ID=<tenant id>
KRAVN_KMS_AZURE_CLIENT_ID=<app registration id>
KRAVN_KMS_AZURE_CLIENT_SECRET=<app secret>
```

## Turn it on for an existing install

Adopting a KMS on a running install is **safe and needs no downtime or bulk re-encryption**:

- Existing secrets keep decrypting — the bootstrap key is retained as a read-only fallback, so **keep
  `KRAVN_SECRET` set** after enabling a KMS.
- New and edited secrets are written under the KMS key. Secrets you never touch stay on the old key and
  remain readable; re-saving one moves it to the KMS key.

::: tip Fail-closed
If a KMS is configured but unreachable or misconfigured, Kravn **fails to start** rather than falling back
to a different key or running unprotected. Set it up, confirm it boots, then roll it out.
:::

::: warning Don't remove or swap a KMS after adopting it
Once secrets are written under the KMS key, decryption needs it. Pointing `KRAVN_KMS_PROVIDER` back to
`none`, or at a different KMS, is rejected/insufficient — switching key managers is a deliberate re-key
migration, not a config swap.
:::

## Good to know

- The KMS endpoint is **operator infrastructure config** (from the environment, like `DATABASE_URL`) — it's
  never user-supplied. Calls are bounded (no redirects, a timeout, a capped response).
- **Multi-replica:** the first replica provisions the key; the others unwrap the same one, so all replicas
  agree.
- **On the roadmap:** in-product key rotation and a bulk re-key command, moving token signing onto the KMS,
  and AWS KMS / GCP KMS providers (same interface).

For the full technical reference, see
[`KEY_MANAGEMENT.md`](https://github.com/addlayerio/kravn/blob/main/KEY_MANAGEMENT.md) in the repository.

---

Related: [Configuration](/guide/configuration) · [Security & compliance](/guide/security).
