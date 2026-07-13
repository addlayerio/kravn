<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AuthConfigView } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import { copyText } from '../lib/clipboard';

const { t } = useI18n();
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
const general = reactive({ autoProvision: true, defaultRole: 'viewer' as 'admin' | 'editor' | 'viewer', adminEmails: '' });
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

// ─── SCIM directory sync (provisioning from Entra/AD — complements SAML) ───────────────────────────
const canManageScim = auth.can('users.write');
const scim = reactive({ enabled: false, hasToken: false, defaultRole: 'viewer' as 'editor' | 'viewer' });
const newScimToken = ref('');
const scimEndpoint = ref('');
onMounted(() => void loadScim());

async function loadScim() {
  scimEndpoint.value = `${window.location.origin}/scim/v2`;
  try {
    const c = await api.get<{ enabled: boolean; hasToken: boolean; defaultRole: string }>('/api/scim/config');
    scim.enabled = c.enabled;
    scim.hasToken = c.hasToken;
    scim.defaultRole = c.defaultRole === 'editor' ? 'editor' : 'viewer';
  } catch {
    /* not permitted / unavailable */
  }
}
async function generateScimToken() {
  if (!confirm(t('authenticationView.confirmGenerateScimToken'))) return;
  try {
    const r = await api.post<{ token: string }>('/api/scim/token', {});
    newScimToken.value = r.token;
    await loadScim();
    toast.success(t('authenticationView.scimTokenGenerated'));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('authenticationView.scimTokenGenerateError'));
  }
}
async function saveScim() {
  try {
    await api.put('/api/scim/config', { enabled: scim.enabled, defaultRole: scim.defaultRole });
    toast.success(t('authenticationView.scimSettingsSaved'));
    await loadScim();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('authenticationView.scimSettingsSaveError'));
  }
}
async function disableScim() {
  if (!confirm(t('authenticationView.confirmDisableScim'))) return;
  await api.del('/api/scim/token');
  newScimToken.value = '';
  await loadScim();
  toast.success(t('authenticationView.scimDisabled'));
}

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
  general.adminEmails = (c.adminEmails ?? []).join('\n');
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
      adminEmails: general.adminEmails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean),
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
    toast.success(t('authenticationView.authSettingsSaved'));
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('authenticationView.saveError');
  } finally {
    saving.value = false;
  }
}

async function copyCb() {
  if (await copyText(callbackUrl.value)) toast.success(t('authenticationView.callbackUrlCopied'));
}

async function importMetadata() {
  if (!metadataUrl.value.trim()) {
    toast.error(t('authenticationView.enterMetadataUrl'));
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
    toast.success(t('authenticationView.metadataImported'));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('authenticationView.importFailed'));
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="topbar">
    <div>
      <h1>{{ t('authenticationView.title') }}</h1>
      <small class="muted">{{ t('authenticationView.subtitle') }}</small>
    </div>
    <button v-if="canWrite" class="btn primary" :disabled="saving" @click="save">{{ saving ? t('authenticationView.saving') : t('authenticationView.saveChanges') }}</button>
  </div>

  <div v-if="error" class="alert error">{{ error }}</div>
  <p v-if="loading" class="muted">{{ t('authenticationView.loading') }}</p>

  <template v-else>
    <!-- OAuth2 / OIDC -->
    <div class="card">
      <div class="row spread">
        <h3>{{ t('authenticationView.oauthProvidersTitle') }}</h3>
        <button v-if="canWrite" class="btn" @click="addProvider">{{ t('authenticationView.addProvider') }}</button>
      </div>
      <p class="muted" style="margin-top: -0.25rem">{{ t('authenticationView.oauthProvidersHint') }}</p>

      <div v-if="providers.length === 0" class="empty">{{ t('authenticationView.noProviders') }}</div>
      <div v-for="(p, i) in providers" :key="i" class="card" style="background: var(--bg)">
        <div class="row" style="gap: 1rem">
          <div class="field" style="flex: 1"><label>{{ t('authenticationView.idSlug') }}</label><input v-model="p.id" placeholder="entra" :disabled="!canWrite" /></div>
          <div class="field" style="flex: 1"><label>{{ t('authenticationView.buttonLabel') }}</label><input v-model="p.label" placeholder="Microsoft" :disabled="!canWrite" /></div>
          <div class="field checkbox" style="margin-top: 1.5rem"><input :id="`pe-${i}`" v-model="p.enabled" type="checkbox" :disabled="!canWrite" /><label :for="`pe-${i}`" style="margin: 0">{{ t('authenticationView.enabled') }}</label></div>
        </div>
        <div class="field"><label>{{ t('authenticationView.discoveryUrl') }}</label><input v-model="p.discoveryUrl" placeholder="https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration" :disabled="!canWrite" /></div>
        <div class="row" style="gap: 1rem">
          <div class="field" style="flex: 1"><label>{{ t('authenticationView.clientId') }}</label><input v-model="p.clientId" :disabled="!canWrite" /></div>
          <div class="field" style="flex: 1">
            <label>{{ t('authenticationView.clientSecret') }} {{ p.clientSecretSet ? t('authenticationView.setLeaveBlank') : '' }}</label>
            <input v-model="p.clientSecret" type="password" :placeholder="p.clientSecretSet ? '••••••••' : ''" :disabled="!canWrite" />
          </div>
        </div>
        <div class="field"><label>{{ t('authenticationView.scopes') }}</label><input v-model="p.scopes" :disabled="!canWrite" /></div>
        <div class="row spread">
          <small class="muted">{{ t('authenticationView.redirectUri') }} <code>{{ callbackUrl.replace('/saml/callback', '/oauth/' + (p.id || '<id>') + '/callback') }}</code></small>
          <button v-if="canWrite" class="btn danger" @click="removeProvider(i)">{{ t('authenticationView.remove') }}</button>
        </div>
      </div>
    </div>

    <!-- SAML -->
    <div class="card">
      <h3>{{ t('authenticationView.samlTitle') }}</h3>

      <div class="card" style="background: var(--bg-page); border-style: dashed">
        <label>{{ t('authenticationView.importFromMetadata') }}</label>
        <div class="row" style="gap: 0.5rem">
          <input
            v-model="metadataUrl"
            placeholder="https://login.microsoftonline.com/<tenant>/federationmetadata/2007-06/federationmetadata.xml?appid=<appid>"
            :disabled="!canWrite"
          />
          <button class="btn" :disabled="!canWrite || importing" @click="importMetadata">
            {{ importing ? t('authenticationView.importing') : t('authenticationView.import') }}
          </button>
        </div>
        <small class="muted">
          {{ t('authenticationView.importMetadataHint') }}
        </small>
      </div>

      <div class="field checkbox"><input id="saml-en" v-model="saml.enabled" type="checkbox" :disabled="!canWrite" /><label for="saml-en" style="margin: 0">{{ t('authenticationView.enableSaml') }}</label></div>
      <div class="row" style="gap: 1rem">
        <div class="field" style="flex: 1"><label>{{ t('authenticationView.buttonLabel') }}</label><input v-model="saml.label" :disabled="!canWrite" /></div>
        <div class="field" style="flex: 1"><label>{{ t('authenticationView.emailAttribute') }}</label><input v-model="saml.emailAttribute" :placeholder="t('authenticationView.emailAttributePlaceholder')" :disabled="!canWrite" /></div>
      </div>
      <div class="field"><label>{{ t('authenticationView.idpSsoUrl') }}</label><input v-model="saml.entryPoint" :disabled="!canWrite" /></div>
      <div class="field"><label>{{ t('authenticationView.spEntityId') }}</label><input v-model="saml.issuer" :disabled="!canWrite" /></div>
      <div class="field"><label>{{ t('authenticationView.idpIssuer') }}</label><input v-model="saml.idpIssuer" :disabled="!canWrite" /></div>
      <div class="field">
        <label>{{ t('authenticationView.idpCert') }} {{ saml.idpCertSet ? t('authenticationView.setLeaveBlank') : '' }}</label>
        <textarea v-model="saml.idpCert" rows="4" :placeholder="saml.idpCertSet ? t('authenticationView.certStoredPlaceholder') : '-----BEGIN CERTIFICATE-----'" :disabled="!canWrite"></textarea>
      </div>
      <div class="row spread">
        <small class="muted">{{ t('authenticationView.acsCallbackUrl') }} <code>{{ callbackUrl }}</code></small>
        <button class="btn" @click="copyCb">{{ t('authenticationView.copy') }}</button>
      </div>
    </div>

    <!-- Provisioning -->
    <div class="card">
      <h3>{{ t('authenticationView.provisioningTitle') }}</h3>
      <div class="field checkbox"><input id="ap" v-model="general.autoProvision" type="checkbox" :disabled="!canWrite" /><label for="ap" style="margin: 0">{{ t('authenticationView.autoCreateUsers') }}</label></div>
      <div class="field" style="max-width: 240px">
        <label>{{ t('authenticationView.defaultRoleSso') }}</label>
        <select v-model="general.defaultRole" :disabled="!canWrite">
          <option value="viewer">{{ t('authenticationView.roleViewer') }}</option>
          <option value="editor">{{ t('authenticationView.roleEditor') }}</option>
          <option value="admin">{{ t('authenticationView.roleAdmin') }}</option>
        </select>
      </div>
      <div class="field" style="max-width: 480px">
        <label>{{ t('authenticationView.adminEmails') }}</label>
        <textarea
          v-model="general.adminEmails"
          rows="3"
          :disabled="!canWrite"
          placeholder="admin@yourcompany.com"
        ></textarea>
        <small class="muted">
          {{ t('authenticationView.adminEmailsHint') }}
        </small>
      </div>
    </div>

    <div v-if="canManageScim" class="card">
      <h2>{{ t('authenticationView.scimTitle') }}</h2>
      <small class="muted">
        {{ t('authenticationView.scimHint') }}
      </small>

      <div class="field" style="max-width: 560px; margin-top: 0.75rem">
        <label>{{ t('authenticationView.scimEndpoint') }}</label>
        <div class="row" style="gap: 0.5rem">
          <input :value="scimEndpoint" readonly />
          <button class="btn" type="button" @click="copyText(scimEndpoint)">{{ t('authenticationView.copy') }}</button>
        </div>
      </div>

      <div v-if="newScimToken" class="alert" style="border-color: var(--accent)">
        <strong>{{ t('authenticationView.secretTokenNotice') }}</strong>
        <div class="row" style="gap: 0.5rem; margin-top: 0.4rem">
          <input :value="newScimToken" readonly />
          <button class="btn" type="button" @click="copyText(newScimToken)">{{ t('authenticationView.copy') }}</button>
        </div>
      </div>

      <div class="row" style="gap: 0.5rem; align-items: center; margin-top: 0.5rem">
        <span class="badge" :class="scim.enabled && scim.hasToken ? 'online' : 'offline'">
          {{ scim.enabled && scim.hasToken ? t('authenticationView.statusEnabled') : t('authenticationView.statusDisabled') }}
        </span>
        <button class="btn primary" type="button" @click="generateScimToken">
          {{ scim.hasToken ? t('authenticationView.regenerateToken') : t('authenticationView.generateToken') }}
        </button>
        <button v-if="scim.hasToken" class="btn danger" type="button" @click="disableScim">{{ t('authenticationView.disable') }}</button>
      </div>

      <div class="field" style="max-width: 240px; margin-top: 0.75rem">
        <label>{{ t('authenticationView.roleForProvisioned') }}</label>
        <select v-model="scim.defaultRole">
          <option value="viewer">{{ t('authenticationView.roleViewer') }}</option>
          <option value="editor">{{ t('authenticationView.roleEditor') }}</option>
        </select>
      </div>
      <div class="btn-row"><button class="btn" type="button" @click="saveScim">{{ t('authenticationView.saveScimSettings') }}</button></div>
    </div>
  </template>
</template>
