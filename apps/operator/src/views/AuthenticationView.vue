<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { AuthConfigView } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import { copyText } from '../lib/clipboard';

const auth = useAuthStore();
const toast = useToastStore();
const canWrite = auth.can('settings.write');

const loading = ref(true);
const saving = ref(false);
const error = ref('');
const callbackUrl = ref('');

interface ProviderRow {
  id: string;
  label: string;
  discoveryUrl: string;
  clientId: string;
  clientSecretSet: boolean;
  clientSecret: string;
  scopes: string;
  enabled: boolean;
}

const providers = ref<ProviderRow[]>([]);
const saml = reactive({
  enabled: false,
  label: 'SAML',
  entryPoint: '',
  issuer: 'kravn',
  idpIssuer: '',
  idpCertSet: false,
  idpCert: '',
  emailAttribute: 'email',
});
const general = reactive({ autoProvision: true, defaultRole: 'viewer' as 'admin' | 'editor' | 'viewer' });
const metadataUrl = ref('');
const importing = ref(false);

onMounted(async () => {
  try {
    const { config } = await api.get<{ config: AuthConfigView }>('/api/auth/config');
    applyConfig(config);
  } finally {
    loading.value = false;
  }
});

function applyConfig(c: AuthConfigView) {
  providers.value = c.oauthProviders.map((p) => ({
    id: p.id,
    label: p.label,
    discoveryUrl: p.discoveryUrl,
    clientId: p.clientId,
    clientSecretSet: p.clientSecretSet,
    clientSecret: '',
    scopes: p.scopes.join(' '),
    enabled: p.enabled,
  }));
  Object.assign(saml, {
    enabled: c.saml.enabled,
    label: c.saml.label,
    entryPoint: c.saml.entryPoint,
    issuer: c.saml.issuer,
    idpIssuer: c.saml.idpIssuer,
    idpCertSet: c.saml.idpCertSet,
    idpCert: '',
    emailAttribute: c.saml.emailAttribute,
  });
  general.autoProvision = c.autoProvision;
  general.defaultRole = c.defaultRole as 'admin' | 'editor' | 'viewer';
  callbackUrl.value = c.samlCallbackUrl;
}

function addProvider() {
  providers.value.push({
    id: '',
    label: '',
    discoveryUrl: '',
    clientId: '',
    clientSecretSet: false,
    clientSecret: '',
    scopes: 'openid email profile',
    enabled: true,
  });
}
function removeProvider(i: number) {
  providers.value.splice(i, 1);
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    const payload = {
      autoProvision: general.autoProvision,
      defaultRole: general.defaultRole,
      oauthProviders: providers.value.map((p) => ({
        id: p.id,
        label: p.label,
        discoveryUrl: p.discoveryUrl,
        clientId: p.clientId,
        scopes: p.scopes.split(/\s+/).filter(Boolean),
        enabled: p.enabled,
        ...(p.clientSecret ? { clientSecret: p.clientSecret } : {}),
      })),
      saml: {
        enabled: saml.enabled,
        label: saml.label,
        entryPoint: saml.entryPoint,
        issuer: saml.issuer,
        idpIssuer: saml.idpIssuer,
        emailAttribute: saml.emailAttribute,
        ...(saml.idpCert ? { idpCert: saml.idpCert } : {}),
      },
    };
    const { config } = await api.put<{ config: AuthConfigView }>('/api/auth/config', payload);
    applyConfig(config);
    toast.success('Authentication settings saved.');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Could not save.';
  } finally {
    saving.value = false;
  }
}

async function copyCb() {
  if (await copyText(callbackUrl.value)) toast.success('Callback URL copied.');
}

async function importMetadata() {
  if (!metadataUrl.value.trim()) {
    toast.error('Enter a federation metadata URL.');
    return;
  }
  importing.value = true;
  try {
    const { metadata } = await api.post<{ metadata: { entityId: string; entryPoint: string; idpCert: string } }>(
      '/api/auth/sso/saml/import-metadata',
      { url: metadataUrl.value.trim() },
    );
    saml.entryPoint = metadata.entryPoint;
    saml.idpCert = metadata.idpCert;
    saml.idpCertSet = true;
    saml.idpIssuer = metadata.entityId;
    saml.enabled = true;
    toast.success('Metadata imported — review the fields and click “Save changes”.');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : 'Import failed.');
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="topbar">
    <div>
      <h1>Authentication</h1>
      <small class="muted">Single sign-on for people logging into Kravn (global identity).</small>
    </div>
    <button v-if="canWrite" class="btn primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save changes' }}</button>
  </div>

  <div v-if="error" class="alert error">{{ error }}</div>
  <p v-if="loading" class="muted">Loading…</p>

  <template v-else>
    <!-- OAuth2 / OIDC -->
    <div class="card">
      <div class="row spread">
        <h3>OAuth2 / OIDC providers</h3>
        <button v-if="canWrite" class="btn" @click="addProvider">+ Add provider</button>
      </div>
      <p class="muted" style="margin-top: -0.25rem">Any OIDC provider with a discovery URL (Entra ID, Okta, Google, Keycloak, Auth0…).</p>

      <div v-if="providers.length === 0" class="empty">No providers configured.</div>
      <div v-for="(p, i) in providers" :key="i" class="card" style="background: var(--bg)">
        <div class="row" style="gap: 1rem">
          <div class="field" style="flex: 1"><label>ID (slug)</label><input v-model="p.id" placeholder="entra" :disabled="!canWrite" /></div>
          <div class="field" style="flex: 1"><label>Button label</label><input v-model="p.label" placeholder="Microsoft" :disabled="!canWrite" /></div>
          <div class="field checkbox" style="margin-top: 1.5rem"><input :id="`pe-${i}`" v-model="p.enabled" type="checkbox" :disabled="!canWrite" /><label :for="`pe-${i}`" style="margin: 0">Enabled</label></div>
        </div>
        <div class="field"><label>Discovery URL</label><input v-model="p.discoveryUrl" placeholder="https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration" :disabled="!canWrite" /></div>
        <div class="row" style="gap: 1rem">
          <div class="field" style="flex: 1"><label>Client ID</label><input v-model="p.clientId" :disabled="!canWrite" /></div>
          <div class="field" style="flex: 1">
            <label>Client secret {{ p.clientSecretSet ? '(set — leave blank to keep)' : '' }}</label>
            <input v-model="p.clientSecret" type="password" :placeholder="p.clientSecretSet ? '••••••••' : ''" :disabled="!canWrite" />
          </div>
        </div>
        <div class="field"><label>Scopes (space-separated)</label><input v-model="p.scopes" :disabled="!canWrite" /></div>
        <div class="row spread">
          <small class="muted">Redirect URI: <code>{{ callbackUrl.replace('/saml/callback', '/oauth/' + (p.id || '<id>') + '/callback') }}</code></small>
          <button v-if="canWrite" class="btn danger" @click="removeProvider(i)">Remove</button>
        </div>
      </div>
    </div>

    <!-- SAML -->
    <div class="card">
      <h3>SAML</h3>

      <div class="card" style="background: var(--bg-page); border-style: dashed">
        <label>Import from federation metadata URL</label>
        <div class="row" style="gap: 0.5rem">
          <input
            v-model="metadataUrl"
            placeholder="https://login.microsoftonline.com/<tenant>/federationmetadata/2007-06/federationmetadata.xml?appid=<appid>"
            :disabled="!canWrite"
          />
          <button class="btn" :disabled="!canWrite || importing" @click="importMetadata">
            {{ importing ? 'Importing…' : 'Import' }}
          </button>
        </div>
        <small class="muted">
          Pulls the SSO URL, signing certificate and IdP issuer from your IdP's metadata (Entra ID, Okta, Keycloak…).
          The fields below are filled in — review them and click “Save changes”.
        </small>
      </div>

      <div class="field checkbox"><input id="saml-en" v-model="saml.enabled" type="checkbox" :disabled="!canWrite" /><label for="saml-en" style="margin: 0">Enable SAML</label></div>
      <div class="row" style="gap: 1rem">
        <div class="field" style="flex: 1"><label>Button label</label><input v-model="saml.label" :disabled="!canWrite" /></div>
        <div class="field" style="flex: 1"><label>Email attribute</label><input v-model="saml.emailAttribute" placeholder="email or nameID" :disabled="!canWrite" /></div>
      </div>
      <div class="field"><label>IdP SSO URL (entryPoint)</label><input v-model="saml.entryPoint" :disabled="!canWrite" /></div>
      <div class="field"><label>SP entity ID (issuer)</label><input v-model="saml.issuer" :disabled="!canWrite" /></div>
      <div class="field"><label>IdP issuer (entityID) — optional, validates the assertion source</label><input v-model="saml.idpIssuer" :disabled="!canWrite" /></div>
      <div class="field">
        <label>IdP signing certificate (PEM) {{ saml.idpCertSet ? '(set — leave blank to keep)' : '' }}</label>
        <textarea v-model="saml.idpCert" rows="4" :placeholder="saml.idpCertSet ? '••••• stored •••••' : '-----BEGIN CERTIFICATE-----'" :disabled="!canWrite"></textarea>
      </div>
      <div class="row spread">
        <small class="muted">ACS / callback URL (register in your IdP): <code>{{ callbackUrl }}</code></small>
        <button class="btn" @click="copyCb">Copy</button>
      </div>
    </div>

    <!-- Provisioning -->
    <div class="card">
      <h3>Provisioning</h3>
      <div class="field checkbox"><input id="ap" v-model="general.autoProvision" type="checkbox" :disabled="!canWrite" /><label for="ap" style="margin: 0">Auto-create users on first SSO login</label></div>
      <div class="field" style="max-width: 240px">
        <label>Default role for new SSO users</label>
        <select v-model="general.defaultRole" :disabled="!canWrite">
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option value="admin">Admin</option>
        </select>
      </div>
    </div>
  </template>
</template>
