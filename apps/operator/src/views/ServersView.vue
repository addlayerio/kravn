<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { UpstreamServer, Transport, AuthType, CatalogServer, PluginView } from '@kravn/contracts';
import { MCP_SERVER_CATALOG, CATALOG_CATEGORIES, catalogDetail } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import { useEventStream } from '../lib/events';
import PluginConfigModal from '../components/PluginConfigModal.vue';
import IntegrationIcon from '../components/IntegrationIcon.vue';
import MarkdownText from '../components/MarkdownText.vue';
import { serverIconId } from '../lib/server-icon';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();
const servers = ref<UpstreamServer[]>([]);
const loading = ref(true);
const error = ref('');
const showModal = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);

const tab = ref<'installed' | 'catalog'>('installed');
const catalogSearch = ref('');
const catalogCategory = ref('');
const catalogCategories = CATALOG_CATEGORIES;

const blank = () => ({
  name: '',
  description: '',
  transport: 'streamable-http' as Transport,
  url: '',
  command: '',
  argsText: '',
  authType: 'none' as AuthType,
  authValue: '',
  headersText: '',
  enabled: true,
  // Persisted OAuth config (shown when authType === 'oauth'); edited here, used by Connect.
  oauthClientId: '',
  oauthClientSecret: '',
  oauthAuthUrl: '',
  oauthTokenUrl: '',
  oauthScope: '',
  oauthTokenAuthMethod: '',
  oauthSecretSet: false,
  // TLS to the upstream (http/sse): custom CA + mTLS client cert/key (key is write-only).
  tlsCa: '',
  tlsClientCert: '',
  tlsClientKey: '',
  tlsClientKeySet: false,
});
const form = reactive(blank());
const showTls = ref(false);
const callbackUrl = `${window.location.origin}/oauth/upstream/callback`;

async function loadOAuthConfig(id: string) {
  try {
    const res = await api.get<{ config: { clientId: string; authorizationUrl: string; tokenUrl: string; scope: string; tokenAuthMethod: string; clientSecretSet: boolean } | null }>(`/api/servers/${id}/oauth/config`);
    const c = res.config;
    if (c) {
      form.oauthClientId = c.clientId;
      form.oauthAuthUrl = c.authorizationUrl;
      form.oauthTokenUrl = c.tokenUrl;
      form.oauthScope = c.scope;
      form.oauthTokenAuthMethod = c.tokenAuthMethod;
      form.oauthSecretSet = c.clientSecretSet;
    }
  } catch {
    /* no saved config yet */
  }
}
async function saveOAuthConfig(id: string) {
  await api.put(`/api/servers/${id}/oauth/config`, {
    clientId: form.oauthClientId.trim(),
    clientSecret: form.oauthClientSecret.trim(), // blank keeps the stored one
    authorizationUrl: form.oauthAuthUrl.trim(),
    tokenUrl: form.oauthTokenUrl.trim(),
    scope: form.oauthScope.trim(),
    tokenAuthMethod: form.oauthTokenAuthMethod,
  });
}

// URLs already registered, so a catalog card shows "Added" instead of "Add".
const installedUrls = computed(() => new Set(servers.value.map((s) => s.url).filter(Boolean)));

const authLabel = computed<Record<CatalogServer['auth'], string>>(() => ({
  open: t('serversView.authNoAuth'),
  apikey: t('serversView.authApiKey'),
  oauth: 'OAuth 2.1',
}));

// ── Unified catalog: remote MCP servers + native (built-in) mcp-server plugins in one browse ──────
const nativeIntegrations = ref<PluginView[]>([]);
const canConfigure = auth.can('settings.read'); // listing/toggling native plugins needs settings perms
const NATIVE_CATEGORY = 'Integrations (built-in)';

const allCategories = computed(() => {
  const base = [...CATALOG_CATEGORIES];
  if (nativeIntegrations.value.length) base.unshift(NATIVE_CATEGORY);
  return base;
});

// Flat shape (not a discriminated union) so the Vue template can read optional fields without narrowing.
interface CatalogItem {
  kind: 'remote' | 'native';
  key: string;
  iconId: string;
  name: string;
  category: string;
  description: string;
  auth?: CatalogServer['auth'];
  provider?: string;
  tags?: string[];
  url?: string;
  remote?: CatalogServer;
  installed?: boolean;
  plugin?: PluginView;
  setup?: string;
  docsUrl?: string;
}

/** Generic, always-accurate "what you need" text derived from the auth class. */
function authGuidance(auth?: CatalogServer['auth']): string {
  if (auth === 'apikey') return t('serversView.authGuidanceApikey');
  if (auth === 'oauth') return t('serversView.authGuidanceOauth');
  return t('serversView.authGuidanceOpen');
}

const catalogItems = computed<CatalogItem[]>(() => {
  const q = catalogSearch.value.trim().toLowerCase();
  const cat = catalogCategory.value;
  const items: CatalogItem[] = [];
  for (const p of nativeIntegrations.value) {
    if (cat && cat !== NATIVE_CATEGORY) continue;
    if (q && !`${p.name} ${p.description} ${p.id}`.toLowerCase().includes(q)) continue;
    items.push({ kind: 'native', key: `n:${p.id}`, iconId: p.id, name: p.name, category: NATIVE_CATEGORY, description: p.description, plugin: p });
  }
  for (const s of MCP_SERVER_CATALOG) {
    if (cat && s.category !== cat) continue;
    if (q && !(s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || (s.tags ?? []).some((t) => t.includes(q)))) continue;
    const d = catalogDetail(s.id);
    items.push({ kind: 'remote', key: `r:${s.id}`, iconId: s.id, name: s.name, category: s.category, description: s.description, auth: s.auth, provider: s.provider, tags: s.tags, url: s.url, remote: s, installed: installedUrls.value.has(s.url), setup: d.setup, docsUrl: d.docsUrl });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
});

const detailItem = ref<CatalogItem | null>(null);
const configPlugin = ref<PluginView | null>(null);
// A native integration can be added more than once: each is a plugin-backed server INSTANCE with its own
// credentials. `instanceConfig` drives the create/edit modal (reusing the schema form).
const instanceConfig = ref<{ plugin: PluginView; serverId?: string; name?: string } | null>(null);
function addInstance(p: PluginView) {
  instanceConfig.value = { plugin: p };
}
async function onInstanceSaved() {
  instanceConfig.value = null;
  toast.success(t('serversView.instanceSaved'));
  await load();
}

async function refreshNative() {
  if (!canConfigure) return;
  try {
    const r = await api.get<{ plugins: PluginView[] }>('/api/plugins');
    nativeIntegrations.value = r.plugins.filter((p) => p.type === 'mcp-server');
  } catch {
    /* a viewer without settings.read simply sees the remote catalog only */
  }
}

async function toggleNative(p: PluginView) {
  try {
    const res = await api.patch<{ plugins: PluginView[] }>(`/api/plugins/${p.id}`, { enabled: !p.enabled });
    nativeIntegrations.value = res.plugins.filter((x) => x.type === 'mcp-server');
    if (detailItem.value?.kind === 'native' && detailItem.value.plugin?.id === p.id) {
      const fresh = nativeIntegrations.value.find((x) => x.id === p.id);
      if (fresh) detailItem.value = { ...detailItem.value, plugin: fresh };
    }
    toast.success(p.enabled ? t('serversView.integrationDisabled', { name: p.name }) : t('serversView.integrationEnabled', { name: p.name }));
    await load(); // reflect the plugin-backed server in the Installed list
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('serversView.couldNotUpdateIntegration'));
  }
}

function onPluginSaved(res?: { plugins: PluginView[] }) {
  if (res) nativeIntegrations.value = res.plugins.filter((p) => p.type === 'mcp-server');
  toast.success(t('serversView.configurationSaved'));
}

async function load() {
  loading.value = true;
  try {
    const [res] = await Promise.all([api.get<{ servers: UpstreamServer[] }>('/api/servers'), refreshNative()]);
    servers.value = res.servers;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
// Live updates over SSE instead of polling: refresh when a server/plugin changes on the server.
useEventStream((type) => {
  if (type === 'registry') void load();
});

function openCreate() {
  Object.assign(form, blank());
  editingId.value = null;
  error.value = '';
  showModal.value = true;
}
// A plugin-backed server (transport 'plugin', id `plg_<pluginId>`) has no url/auth to edit — its real
// config lives in the native plugin (db/user/token, entered on install). Route its Edit to that config
// modal instead of the generic upstream-server form, so install and edit ask for the same thing.
function editServer(s: UpstreamServer) {
  if (s.transport === 'plugin') {
    const type = nativeIntegrations.value.find((p) => p.id === s.command);
    if (type) {
      // The auto-created default instance edits the plugin's own config; a user-created instance edits its
      // own per-instance config (stored on the server row).
      if (s.id === `plg_${s.command}`) configPlugin.value = type;
      else instanceConfig.value = { plugin: type, serverId: s.id, name: s.name };
      return;
    }
  }
  openEdit(s);
}

function openEdit(s: UpstreamServer) {
  Object.assign(form, blank(), {
    name: s.name,
    description: s.description,
    transport: s.transport,
    url: s.url,
    command: s.command,
    argsText: s.args.join('\n'),
    authType: s.authType,
    authValue: '',
    headersText: Object.keys(s.headers).length ? JSON.stringify(s.headers, null, 2) : '',
    enabled: s.enabled,
    tlsCa: s.tlsCa,
    tlsClientCert: s.tlsClientCert,
    tlsClientKeySet: s.tlsClientKeySet,
  });
  editingId.value = s.id;
  error.value = '';
  showModal.value = true;
  showTls.value = !!(s.tlsCa || s.tlsClientCert || s.tlsClientKeySet);
  if (s.authType === 'oauth') void loadOAuthConfig(s.id);
}

// Prefill the Add form from a catalog entry — the admin only supplies a credential if the server needs one.
// 'apikey' servers take the key as a Bearer header; 'open'/'oauth' start with no credential (OAuth upstream
// sign-in is a separate connect step).
function addFromCatalog(e: CatalogServer) {
  Object.assign(form, blank());
  form.name = e.name;
  form.description = e.description;
  form.transport = e.transport;
  form.url = e.url;
  form.authType = e.auth === 'apikey' ? 'bearer' : e.auth === 'oauth' ? 'oauth' : 'none';
  editingId.value = null;
  error.value = '';
  showModal.value = true;
}

/** Add the remote server from the detail modal (then close it). */
function addFromDetail() {
  if (detailItem.value?.remote) {
    addFromCatalog(detailItem.value.remote);
    detailItem.value = null;
  }
}

// Manual OAuth config the operator supplies when a provider can't be auto-discovered/registered (e.g. GitHub).
type OAuthCfg = { clientId?: string; clientSecret?: string; authorizationUrl?: string; tokenUrl?: string; scope?: string };
const oauthClient = ref<{ id: string; name: string } | null>(null);
const oauthClientForm = reactive({ clientId: '', clientSecret: '', authorizationUrl: '', tokenUrl: '', scope: '' });
const oauthCallbackUrl = `${window.location.origin}/oauth/upstream/callback`;

// OAuth 2.1 servers: open the provider sign-in, then poll until the callback connects the server. If the
// provider can't auto-configure (no metadata/DCR — e.g. GitHub), the backend replies oauth_needs_client and
// we open a form to collect the endpoints + client, then retry.
async function connectOAuth(srv: UpstreamServer, cfg?: OAuthCfg) {
  try {
    const res = await api.post<{ authorizationUrl: string }>(`/api/servers/${srv.id}/oauth/authorize`, cfg ?? {});
    oauthClient.value = null;
    const win = window.open(res.authorizationUrl, '_blank', 'width=560,height=720');
    if (!win) {
      toast.error(t('serversView.popupBlocked'));
      return;
    }
    // No polling — the SSE stream refreshes the list when the callback connects the server.
    toast.success(t('serversView.finishSigningIn'));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'oauth_needs_client') {
      Object.assign(oauthClientForm, { clientId: '', clientSecret: '', authorizationUrl: '', tokenUrl: '', scope: '' });
      oauthClient.value = { id: srv.id, name: srv.name };
      return;
    }
    toast.error(e instanceof ApiError ? e.message : t('serversView.couldNotStartOAuth'));
  }
}

async function submitOAuthClient() {
  const c = oauthClient.value;
  const clientId = oauthClientForm.clientId.trim();
  if (!c || !clientId) return;
  const srv = servers.value.find((x) => x.id === c.id);
  if (!srv) return;
  // Persist first (so it survives a failure + is editable from Edit), then connect using the stored config.
  await api
    .put(`/api/servers/${c.id}/oauth/config`, {
      clientId,
      clientSecret: oauthClientForm.clientSecret.trim(),
      authorizationUrl: oauthClientForm.authorizationUrl.trim(),
      tokenUrl: oauthClientForm.tokenUrl.trim(),
      scope: oauthClientForm.scope.trim(),
    })
    .catch(() => {});
  connectOAuth(srv);
}

function parseHeaders(): Record<string, string> {
  if (!form.headersText.trim()) return {};
  try {
    return JSON.parse(form.headersText);
  } catch {
    throw new Error(t('serversView.headersInvalidJson'));
  }
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    const args = form.argsText.split('\n').map((a) => a.trim()).filter(Boolean);
    const headers = parseHeaders();
    const base = {
      name: form.name,
      description: form.description,
      url: form.url,
      command: form.command,
      args,
      headers,
      authType: form.authType,
      tlsCa: form.tlsCa,
      tlsClientCert: form.tlsClientCert,
      enabled: form.enabled,
    };
    let serverId = editingId.value;
    if (editingId.value) {
      const patch: Record<string, unknown> = { ...base };
      if (form.authValue) patch.authValue = form.authValue;
      if (form.tlsClientKey) patch.tlsClientKey = form.tlsClientKey;
      await api.patch(`/api/servers/${editingId.value}`, patch);
    } else {
      const res = await api.post<{ server: UpstreamServer }>('/api/servers', { ...base, transport: form.transport, authValue: form.authValue, tlsClientKey: form.tlsClientKey, env: {} });
      serverId = res.server?.id ?? null;
    }
    // Persist the editable OAuth config so Connect uses it and it isn't lost on a failed attempt.
    if (form.authType === 'oauth' && serverId) await saveOAuthConfig(serverId);
    showModal.value = false;
    toast.success(editingId.value ? t('serversView.serverUpdated') : t('serversView.serverAdded'));
    tab.value = 'installed';
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : (e as Error).message || t('serversView.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function sync(srv: UpstreamServer) {
  try {
    const res = await api.post<{ server: UpstreamServer }>(`/api/servers/${srv.id}/sync`);
    if (res.server.status === 'online') toast.success(t('serversView.syncedOk', { name: srv.name }));
    else toast.error(t('serversView.syncFailedError', { name: srv.name, error: res.server.lastError || t('serversView.couldNotConnect') }));
  } catch {
    toast.error(t('serversView.couldNotSync', { name: srv.name }));
  }
  await load();
}
async function remove(srv: UpstreamServer) {
  if (!confirm(t('serversView.confirmDelete', { name: srv.name }))) return;
  await api.del(`/api/servers/${srv.id}`);
  toast.success(t('serversView.serverDeleted'));
  await load();
}
</script>

<template>
  <div class="topbar">
    <h1>{{ t('serversView.mcpServers') }}</h1>
    <div class="btn-row">
      <div class="segmented" role="tablist">
        <button :class="{ active: tab === 'installed' }" @click="tab = 'installed'">{{ t('serversView.installed') }}</button>
        <button data-tour="catalog-tab" :class="{ active: tab === 'catalog' }" @click="tab = 'catalog'">{{ t('serversView.catalog') }}</button>
      </div>
      <button v-if="auth.can('servers.write')" class="btn primary" @click="openCreate">+ {{ t('serversView.addServer') }}</button>
    </div>
  </div>

  <div v-if="tab === 'installed'" class="card">
    <p v-if="loading" class="muted">{{ t('serversView.loading') }}</p>
    <div v-else-if="servers.length === 0" class="empty">
      {{ t('serversView.emptyPrefix') }} <a href="#" @click.prevent="tab = 'catalog'">{{ t('serversView.catalog') }}</a> {{ t('serversView.emptySuffix') }}
    </div>
    <table v-else>
      <thead>
        <tr><th>{{ t('serversView.colName') }}</th><th>{{ t('serversView.colTransport') }}</th><th>{{ t('serversView.colEndpoint') }}</th><th>{{ t('serversView.colStatus') }}</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="s in servers" :key="s.id">
          <td>
            <div style="display: flex; align-items: center; gap: 0.6rem">
              <IntegrationIcon :id="serverIconId(s)" :name="s.name" :size="26" />
              <div>
                <div style="font-weight: 600">{{ s.name }}</div>
                <small class="muted">{{ s.description }}</small>
              </div>
            </div>
          </td>
          <td><small class="muted">{{ s.transport }}</small></td>
          <td><small class="muted">{{ s.transport === 'stdio' ? s.command : s.url }}</small></td>
          <td>
            <span class="badge" :class="s.status">{{ s.status }}</span>
            <div v-if="s.lastError"><small class="muted">{{ s.lastError }}</small></div>
          </td>
          <td>
            <div class="btn-row">
              <button v-if="s.authType === 'oauth' && s.status !== 'online' && auth.can('servers.write')" class="btn primary" @click="connectOAuth(s)">{{ t('serversView.connect') }}</button>
              <button class="btn" @click="sync(s)">{{ t('serversView.sync') }}</button>
              <button v-if="auth.can('servers.write')" class="btn" @click="editServer(s)">{{ s.transport === 'plugin' ? t('serversView.configure') : t('serversView.edit') }}</button>
              <button v-if="auth.can('servers.delete')" class="btn danger" @click="remove(s)">{{ t('serversView.delete') }}</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <template v-else>
    <div class="card">
      <div class="catalog-toolbar">
        <input v-model="catalogSearch" data-tour="catalog-search" class="catalog-search" :placeholder="t('serversView.searchPlaceholder')" />
        <select v-model="catalogCategory">
          <option value="">{{ t('serversView.allCategories') }}</option>
          <option v-for="c in allCategories" :key="c" :value="c">{{ c }}</option>
        </select>
        <span class="muted count">{{ t('serversView.integrationsCount', { count: catalogItems.length }) }}</span>
      </div>
      <p class="muted legend">
        {{ t('serversView.legendIntro') }} <span class="cc-auth native">{{ t('serversView.builtIn') }}</span> {{ t('serversView.legendRunInside') }}
        <span class="cc-auth open">{{ t('serversView.authNoAuth') }}</span> /
        <span class="cc-auth apikey">{{ t('serversView.authApiKey') }}</span> {{ t('serversView.legendConnectOnAdd') }} <span class="cc-auth oauth">OAuth 2.1</span>
        {{ t('serversView.legendOneClick') }}
      </p>
    </div>

    <div class="catalog-grid" data-tour="catalog-grid">
      <div v-for="e in catalogItems" :key="e.key" class="catalog-card">
        <div class="cc-body" role="button" tabindex="0" :title="t('serversView.viewDetails')" @click="detailItem = e" @keydown.enter="detailItem = e">
          <div class="cc-head">
            <span class="cc-title">
              <IntegrationIcon :id="e.iconId" :name="e.name" :size="30" />
              <span class="cc-name">{{ e.name }}</span>
            </span>
            <span v-if="e.kind === 'native'" class="cc-auth native">{{ t('serversView.builtIn') }}</span>
            <span v-else class="cc-auth" :class="e.auth">{{ e.auth ? authLabel[e.auth] : '' }}</span>
          </div>
          <div class="cc-cat muted">{{ e.category }}</div>
          <p class="cc-desc">{{ e.description }}</p>
          <div class="cc-hint muted"><small>{{ t('serversView.details') }} →</small></div>
        </div>
        <div class="cc-foot">
          <template v-if="e.kind === 'native'">
            <template v-if="auth.can('settings.write')">
              <button class="btn" @click="configPlugin = e.plugin ?? null">{{ t('serversView.config') }}</button>
              <button class="btn" :class="{ primary: !e.plugin?.enabled }" @click="e.plugin && toggleNative(e.plugin)">{{ e.plugin?.enabled ? t('serversView.disable') : t('serversView.enable') }}</button>
            </template>
            <!-- Add another INSTANCE (its own credentials), same flow as a remote server. -->
            <button v-if="auth.can('servers.write') && e.plugin" class="btn primary" @click="addInstance(e.plugin)">{{ t('serversView.add') }}</button>
          </template>
          <template v-else>
            <span v-if="e.installed" class="muted">{{ t('serversView.added') }} ✓</span>
            <button v-else-if="auth.can('servers.write')" class="btn" @click="e.remote && addFromCatalog(e.remote)">{{ t('serversView.add') }}</button>
          </template>
        </div>
      </div>
    </div>
  </template>

  <!-- Unified catalog detail modal -->
  <div v-if="detailItem" class="modal-backdrop" @click.self="detailItem = null">
    <div class="modal" style="max-width: 600px">
      <div class="row spread">
        <div style="display: flex; align-items: center; gap: 0.7rem">
          <IntegrationIcon :id="detailItem.iconId" :name="detailItem.name" :size="38" />
          <h2 style="margin: 0">{{ detailItem.name }}</h2>
        </div>
        <span v-if="detailItem.kind === 'native'" class="cc-auth native">{{ t('serversView.builtIn') }}</span>
        <span v-else class="cc-auth" :class="detailItem.auth">{{ detailItem.auth ? authLabel[detailItem.auth] : '' }}</span>
      </div>
      <div class="cc-cat muted" style="margin-top: 0.4rem">
        {{ detailItem.category }}<template v-if="detailItem.provider"> · {{ detailItem.provider }}</template>
      </div>
      <MarkdownText :text="detailItem.description" style="margin-top: 1rem" />

      <template v-if="detailItem.kind === 'remote'">
        <div class="cc-kv"><span class="muted">{{ t('serversView.endpoint') }}</span><code>{{ detailItem.url }}</code></div>
        <div class="cc-kv">
          <span class="muted">{{ t('serversView.connectsWith') }}</span>
          <span>{{ detailItem.auth ? authLabel[detailItem.auth] : '' }}<template v-if="detailItem.auth === 'oauth'"> {{ t('serversView.signInAfterAdding') }}</template></span>
        </div>
        <div class="setup-note">
          <div class="setup-title">{{ t('serversView.gettingSetUp') }}</div>
          <MarkdownText :text="detailItem.setup || authGuidance(detailItem.auth)" />
          <a v-if="detailItem.docsUrl" :href="detailItem.docsUrl" target="_blank" rel="noopener noreferrer" class="docs-link">{{ t('serversView.providerDocs') }} ↗</a>
        </div>
        <div v-if="detailItem.tags && detailItem.tags.length" class="cc-tags">
          <span v-for="t in detailItem.tags" :key="t" class="badge">{{ t }}</span>
        </div>
      </template>
      <template v-else>
        <div class="cc-kv"><span class="muted">{{ t('serversView.runs') }}</span><span>{{ t('serversView.runsInProcess') }}</span></div>
        <div v-if="detailItem.plugin?.setup" class="setup-note">
          <div class="setup-title">{{ t('serversView.setupPermissions') }}</div>
          <MarkdownText :text="detailItem.plugin.setup" />
        </div>
      </template>

      <div class="btn-row" style="justify-content: flex-end; margin-top: 1.5rem">
        <button class="btn" @click="detailItem = null">{{ t('serversView.close') }}</button>
        <template v-if="detailItem.kind === 'native' && auth.can('settings.write')">
          <button class="btn" @click="configPlugin = detailItem.plugin ?? null">{{ t('serversView.configure') }}</button>
          <button class="btn primary" @click="detailItem.plugin && toggleNative(detailItem.plugin)">{{ detailItem.plugin?.enabled ? t('serversView.disable') : t('serversView.enable') }}</button>
        </template>
        <template v-else-if="detailItem.kind === 'remote'">
          <span v-if="detailItem.installed" class="muted" style="align-self: center">{{ t('serversView.added') }} ✓</span>
          <button v-else-if="auth.can('servers.write')" class="btn primary" @click="addFromDetail()">{{ t('serversView.add') }}</button>
        </template>
      </div>
    </div>
  </div>

  <PluginConfigModal v-if="configPlugin" :plugin="configPlugin" @close="configPlugin = null" @saved="onPluginSaved" />
  <PluginConfigModal
    v-if="instanceConfig"
    :plugin="instanceConfig.plugin"
    :instance="{ serverId: instanceConfig.serverId, name: instanceConfig.name }"
    @close="instanceConfig = null"
    @saved="onInstanceSaved"
  />

  <!-- OAuth client credentials (providers without automatic app registration, e.g. GitHub) -->
  <div v-if="oauthClient" class="modal-backdrop" @click.self="oauthClient = null">
    <div class="modal" style="max-width: 560px">
      <h2>{{ t('serversView.connectName', { name: oauthClient.name }) }}</h2>
      <p class="muted" style="margin-top: -0.25rem">
        {{ t('serversView.oauthClientIntro') }}
      </p>
      <div class="field">
        <label>{{ t('serversView.redirectUrlLabel') }}</label>
        <input :value="oauthCallbackUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
      </div>
      <div class="field">
        <label>{{ t('serversView.clientId') }}</label>
        <input v-model="oauthClientForm.clientId" :placeholder="t('serversView.clientIdPlaceholder')" />
      </div>
      <div class="field">
        <label>{{ t('serversView.clientSecret') }} <span class="muted">{{ t('serversView.secretOptionalNote') }}</span></label>
        <input v-model="oauthClientForm.clientSecret" type="password" autocomplete="new-password" :placeholder="t('serversView.clientSecretPlaceholderPublic')" />
      </div>
      <div class="field">
        <label>{{ t('serversView.authorizationUrl') }} <span class="muted">{{ t('serversView.authUrlNoteDiscover') }}</span></label>
        <input v-model="oauthClientForm.authorizationUrl" placeholder="e.g. https://github.com/login/oauth/authorize" />
      </div>
      <div class="field">
        <label>{{ t('serversView.tokenUrl') }} <span class="muted">{{ t('serversView.tokenUrlNotePair') }}</span></label>
        <input v-model="oauthClientForm.tokenUrl" placeholder="e.g. https://github.com/login/oauth/access_token" />
      </div>
      <div class="field">
        <label>{{ t('serversView.scopes') }} <span class="muted">{{ t('serversView.scopesNoteOptional') }}</span></label>
        <input v-model="oauthClientForm.scope" placeholder="e.g. repo read:org read:user" />
      </div>
      <p class="muted" style="font-size: 0.82em">
        {{ t('serversView.oauthClientUrlsNote') }}
      </p>
      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="oauthClient = null">{{ t('serversView.cancel') }}</button>
        <button class="btn primary" :disabled="!oauthClientForm.clientId.trim()" @click="submitOAuthClient">{{ t('serversView.continue') }}</button>
      </div>
    </div>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal">
      <h2>{{ editingId ? t('serversView.editServerTitle') : t('serversView.addServerTitle') }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="field">
        <label>{{ t('serversView.name') }}</label>
        <input v-model="form.name" required maxlength="120" />
      </div>
      <div class="field">
        <label>{{ t('serversView.description') }}</label>
        <input v-model="form.description" maxlength="2000" />
      </div>
      <div class="field" v-if="!editingId">
        <label>{{ t('serversView.transport') }}</label>
        <select v-model="form.transport">
          <option value="streamable-http">Streamable HTTP</option>
          <option value="sse">SSE</option>
          <option value="stdio">{{ t('serversView.stdioOption') }}</option>
        </select>
      </div>

      <template v-if="form.transport !== 'stdio'">
        <div class="field">
          <label>{{ t('serversView.url') }}</label>
          <input v-model="form.url" maxlength="2048" placeholder="https://my-mcp-server.svc.cluster.local/mcp" />
        </div>
      </template>
      <template v-else>
        <div class="field">
          <label>{{ t('serversView.command') }}</label>
          <input v-model="form.command" maxlength="2000" placeholder="npx" />
        </div>
        <div class="field">
          <label>{{ t('serversView.argumentsLabel') }}</label>
          <textarea v-model="form.argsText" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-everything"></textarea>
        </div>
      </template>

      <div class="field">
        <label>{{ t('serversView.auth') }}</label>
        <select v-model="form.authType">
          <option value="none">{{ t('serversView.authNone') }}</option>
          <option value="bearer">{{ t('serversView.authBearer') }}</option>
          <option value="basic">{{ t('serversView.authBasic') }}</option>
          <option value="oauth">{{ t('serversView.authOAuthOption') }}</option>
        </select>
      </div>
      <div class="field" v-if="form.authType === 'bearer' || form.authType === 'basic'">
        <label>{{ t('serversView.credential') }} {{ editingId ? t('serversView.leaveBlankKeepCurrent') : '' }}</label>
        <input v-model="form.authValue" type="password" maxlength="8192" :placeholder="form.authType === 'basic' ? 'user:password' : 'token'" />
      </div>
      <template v-else-if="form.authType === 'oauth'">
        <p class="muted oauth-note">
          {{ t('serversView.oauthNotePart1') }} <strong>{{ t('serversView.connect') }}</strong>{{ t('serversView.oauthNotePart2') }}
        </p>
        <div class="field">
          <label>{{ t('serversView.redirectUrlLabel') }}</label>
          <input :value="callbackUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
        </div>
        <div class="field">
          <label>{{ t('serversView.clientId') }}</label>
          <input v-model="form.oauthClientId" :placeholder="t('serversView.clientIdPlaceholder')" />
        </div>
        <div class="field">
          <label>{{ t('serversView.clientSecret') }} <span class="muted">{{ form.oauthSecretSet ? t('serversView.secretSetNote') : t('serversView.secretOptionalNote') }}</span></label>
          <input v-model="form.oauthClientSecret" type="password" autocomplete="new-password" :placeholder="form.oauthSecretSet ? t('serversView.secretPlaceholderSet') : t('serversView.clientSecretPlaceholderPublic')" />
        </div>
        <div class="field">
          <label>{{ t('serversView.authorizationUrl') }} <span class="muted">{{ t('serversView.authUrlNoteDiscoverBlank') }}</span></label>
          <input v-model="form.oauthAuthUrl" placeholder="e.g. https://github.com/login/oauth/authorize" />
        </div>
        <div class="field">
          <label>{{ t('serversView.tokenUrl') }}</label>
          <input v-model="form.oauthTokenUrl" placeholder="e.g. https://github.com/login/oauth/access_token" />
        </div>
        <div class="field">
          <label>{{ t('serversView.scopes') }} <span class="muted">{{ t('serversView.scopesNoteSpaceSep') }}</span></label>
          <input v-model="form.oauthScope" placeholder="e.g. repo read:org read:user" />
        </div>
        <div class="field">
          <label>{{ t('serversView.clientAuth') }} <span class="muted">{{ t('serversView.clientAuthNote') }}</span></label>
          <select v-model="form.oauthTokenAuthMethod">
            <option value="">{{ t('serversView.tokenAuthAuto') }}</option>
            <option value="client_secret_basic">{{ t('serversView.tokenAuthBasic') }}</option>
            <option value="client_secret_post">{{ t('serversView.tokenAuthPost') }}</option>
            <option value="none">{{ t('serversView.tokenAuthNone') }}</option>
          </select>
        </div>
      </template>

      <div class="field">
        <label>{{ t('serversView.extraHeaders') }}</label>
        <textarea v-model="form.headersText" rows="2" placeholder='{ "X-Tenant": "acme" }'></textarea>
      </div>

      <div v-if="form.transport !== 'stdio'" class="field">
        <label style="cursor: pointer" @click="showTls = !showTls">
          {{ showTls ? '▾' : '▸' }} {{ t('serversView.tlsToggle') }} <span class="muted">{{ t('serversView.advanced') }}</span>
        </label>
        <div v-if="showTls" class="card" style="margin: 0; background: var(--bg-page)">
          <small class="muted" style="display: block; margin-bottom: 0.5rem">
            {{ t('serversView.tlsNote') }}
          </small>
          <div class="field">
            <label>{{ t('serversView.caBundle') }}</label>
            <textarea v-model="form.tlsCa" rows="3" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----&#10;…"></textarea>
          </div>
          <div class="field">
            <label>{{ t('serversView.clientCert') }}</label>
            <textarea v-model="form.tlsClientCert" rows="3" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----&#10;…"></textarea>
          </div>
          <div class="field">
            <label>{{ t('serversView.clientKey') }}</label>
            <textarea v-model="form.tlsClientKey" rows="3" spellcheck="false" :placeholder="form.tlsClientKeySet ? t('serversView.clientKeyPlaceholderSet') : t('serversView.clientKeyPlaceholderUnset')"></textarea>
          </div>
        </div>
      </div>

      <div class="field checkbox">
        <input id="enabled" v-model="form.enabled" type="checkbox" />
        <label for="enabled" style="margin: 0">{{ t('serversView.enabledLabel') }}</label>
      </div>

      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="showModal = false">{{ t('serversView.cancel') }}</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? t('serversView.saving') : t('serversView.save') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  border: 1px solid var(--border, #33384a);
  border-radius: 8px;
  overflow: hidden;
}
.segmented button {
  padding: 6px 14px;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
  opacity: 0.7;
}
.segmented button.active {
  background: var(--accent, #6c8cff);
  color: #fff;
  opacity: 1;
}
.catalog-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.catalog-search {
  flex: 1;
  min-width: 200px;
}
.catalog-toolbar .count {
  margin-left: auto;
  white-space: nowrap;
}
.legend {
  margin: 10px 0 0;
  font-size: 0.85em;
}
.catalog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.catalog-card {
  border: 1px solid var(--border, #33384a);
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.cc-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.cc-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cc-cat {
  font-size: 0.8em;
}
.cc-desc {
  flex: 1;
  margin: 4px 0 10px;
  font-size: 0.88em;
  line-height: 1.4;
  opacity: 0.85;
}
.cc-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  cursor: pointer;
  border-radius: 8px;
}
.cc-body:focus-visible {
  outline: 2px solid var(--accent, #6c8cff);
  outline-offset: 3px;
}
.cc-body:hover .cc-name {
  color: var(--accent, #6c8cff);
}
.cc-hint {
  opacity: 0;
  transition: opacity 0.15s ease;
  color: var(--accent, #6c8cff);
}
.cc-body:hover .cc-hint,
.cc-body:focus-visible .cc-hint {
  opacity: 1;
}
.cc-foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.cc-auth.native {
  color: #8b5cf6;
  border-color: rgba(139, 92, 246, 0.4);
  background: rgba(139, 92, 246, 0.12);
}
.cc-kv {
  display: flex;
  gap: 10px;
  margin-top: 10px;
  font-size: 0.85em;
}
.cc-kv > .muted {
  min-width: 110px;
}
.cc-kv code {
  word-break: break-all;
}
.cc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 12px;
}
.setup-note {
  margin-top: 1rem;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--border, #33384a);
  border-left: 3px solid var(--accent, #6c8cff);
  border-radius: 8px;
  background: var(--bg-page, rgba(0, 0, 0, 0.15));
  font-size: 0.85em;
  line-height: 1.5;
}
.setup-note .setup-title {
  font-weight: 600;
  margin-bottom: 0.3rem;
  white-space: normal;
}
.docs-link {
  display: inline-block;
  margin-top: 0.5rem;
  color: var(--accent, #6c8cff);
  text-decoration: none;
  white-space: normal;
}
.docs-link:hover {
  text-decoration: underline;
}
.cc-auth {
  font-size: 0.72em;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  white-space: nowrap;
}
.cc-auth.open {
  color: #2ea043;
  border-color: rgba(46, 160, 67, 0.4);
  background: rgba(46, 160, 67, 0.1);
}
.cc-auth.apikey {
  color: #4a90d9;
  border-color: rgba(74, 144, 217, 0.4);
  background: rgba(74, 144, 217, 0.1);
}
.cc-auth.oauth {
  color: #d29922;
  border-color: rgba(210, 153, 34, 0.4);
  background: rgba(210, 153, 34, 0.12);
}
.oauth-note {
  font-size: 0.85em;
  line-height: 1.5;
}
</style>
