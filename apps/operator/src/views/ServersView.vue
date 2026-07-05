<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { UpstreamServer, Transport, AuthType, CatalogServer, PluginView } from '@kravn/contracts';
import { MCP_SERVER_CATALOG, CATALOG_CATEGORIES, catalogDetail } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import PluginConfigModal from '../components/PluginConfigModal.vue';

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
});
const form = reactive(blank());

// URLs already registered, so a catalog card shows "Added" instead of "Add".
const installedUrls = computed(() => new Set(servers.value.map((s) => s.url).filter(Boolean)));

const authLabel: Record<CatalogServer['auth'], string> = {
  open: 'No auth',
  apikey: 'API key',
  oauth: 'OAuth 2.1',
};

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
  if (auth === 'apikey')
    return 'Create an API key in your provider account and paste it as the token when you add this server. It is sent as a Bearer header and stored encrypted.';
  if (auth === 'oauth')
    return 'No token to manage — add it, then click Connect and sign in with the provider. Kravn stores the tokens encrypted and refreshes them automatically. Some providers (e.g. GitHub) require you to register an OAuth app first — Kravn will show the exact redirect URL and ask for the Client ID/secret if so.';
  return 'No credential needed — add it and it connects immediately.';
}

const catalogItems = computed<CatalogItem[]>(() => {
  const q = catalogSearch.value.trim().toLowerCase();
  const cat = catalogCategory.value;
  const items: CatalogItem[] = [];
  for (const p of nativeIntegrations.value) {
    if (cat && cat !== NATIVE_CATEGORY) continue;
    if (q && !`${p.name} ${p.description} ${p.id}`.toLowerCase().includes(q)) continue;
    items.push({ kind: 'native', key: `n:${p.id}`, name: p.name, category: NATIVE_CATEGORY, description: p.description, plugin: p });
  }
  for (const s of MCP_SERVER_CATALOG) {
    if (cat && s.category !== cat) continue;
    if (q && !(s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || (s.tags ?? []).some((t) => t.includes(q)))) continue;
    const d = catalogDetail(s.id);
    items.push({ kind: 'remote', key: `r:${s.id}`, name: s.name, category: s.category, description: s.description, auth: s.auth, provider: s.provider, tags: s.tags, url: s.url, remote: s, installed: installedUrls.value.has(s.url), setup: d.setup, docsUrl: d.docsUrl });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
});

const detailItem = ref<CatalogItem | null>(null);
const configPlugin = ref<PluginView | null>(null);

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
    if (detailItem.value?.kind === 'native' && detailItem.value.plugin.id === p.id) {
      const fresh = nativeIntegrations.value.find((x) => x.id === p.id);
      if (fresh) detailItem.value = { ...detailItem.value, plugin: fresh };
    }
    toast.success(`${p.name} ${p.enabled ? 'disabled' : 'enabled'}.`);
    await load(); // reflect the plugin-backed server in the Installed list
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : 'Could not update integration.');
  }
}

function onPluginSaved(res: { plugins: PluginView[] }) {
  nativeIntegrations.value = res.plugins.filter((p) => p.type === 'mcp-server');
  toast.success('Configuration saved.');
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

function openCreate() {
  Object.assign(form, blank());
  editingId.value = null;
  error.value = '';
  showModal.value = true;
}
function openEdit(s: UpstreamServer) {
  Object.assign(form, {
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
  });
  editingId.value = s.id;
  error.value = '';
  showModal.value = true;
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

// OAuth client credentials the operator must supply for providers without Dynamic Client Registration.
const oauthClient = ref<{ id: string; name: string } | null>(null);
const oauthClientForm = reactive({ clientId: '', clientSecret: '' });
const oauthCallbackUrl = `${window.location.origin}/oauth/upstream/callback`;

// OAuth 2.1 servers: open the provider sign-in, then poll until the callback connects the server. If the
// provider can't auto-register an app (e.g. GitHub), the backend asks for client credentials and we collect
// them, then retry with them.
async function connectOAuth(srv: UpstreamServer, manualClient?: { clientId: string; clientSecret?: string }) {
  try {
    const res = await api.post<{ authorizationUrl: string }>(`/api/servers/${srv.id}/oauth/authorize`, manualClient ?? {});
    oauthClient.value = null;
    const win = window.open(res.authorizationUrl, '_blank', 'width=560,height=720');
    if (!win) {
      toast.error('Popup blocked — allow popups for this site and try Connect again.');
      return;
    }
    toast.success('Finish signing in in the new window…');
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      await load();
      const cur = servers.value.find((x) => x.id === srv.id);
      if ((cur && cur.status === 'online') || tries >= 12) clearInterval(timer);
    }, 3000);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'oauth_needs_client') {
      oauthClientForm.clientId = '';
      oauthClientForm.clientSecret = '';
      oauthClient.value = { id: srv.id, name: srv.name };
      return;
    }
    toast.error(e instanceof ApiError ? e.message : 'Could not start OAuth authorization.');
  }
}

function submitOAuthClient() {
  const c = oauthClient.value;
  const clientId = oauthClientForm.clientId.trim();
  if (!c || !clientId) return;
  const srv = servers.value.find((x) => x.id === c.id);
  if (srv) connectOAuth(srv, { clientId, clientSecret: oauthClientForm.clientSecret.trim() || undefined });
}

function parseHeaders(): Record<string, string> {
  if (!form.headersText.trim()) return {};
  try {
    return JSON.parse(form.headersText);
  } catch {
    throw new Error('Headers must be valid JSON.');
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
      enabled: form.enabled,
    };
    if (editingId.value) {
      const patch: Record<string, unknown> = { ...base };
      if (form.authValue) patch.authValue = form.authValue;
      await api.patch(`/api/servers/${editingId.value}`, patch);
    } else {
      await api.post('/api/servers', { ...base, transport: form.transport, authValue: form.authValue, env: {} });
    }
    showModal.value = false;
    toast.success(editingId.value ? 'Server updated.' : 'Server added.');
    tab.value = 'installed';
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : (e as Error).message || 'Save failed.';
  } finally {
    saving.value = false;
  }
}

async function sync(srv: UpstreamServer) {
  try {
    const res = await api.post<{ server: UpstreamServer }>(`/api/servers/${srv.id}/sync`);
    if (res.server.status === 'online') toast.success(`"${srv.name}" connected and synced.`);
    else toast.error(`"${srv.name}": ${res.server.lastError || 'could not connect.'}`);
  } catch {
    toast.error(`Could not sync "${srv.name}".`);
  }
  await load();
}
async function remove(srv: UpstreamServer) {
  if (!confirm(`Delete server "${srv.name}"? This also removes its imported tools.`)) return;
  await api.del(`/api/servers/${srv.id}`);
  toast.success('Server deleted.');
  await load();
}
</script>

<template>
  <div class="topbar">
    <h1>MCP Servers</h1>
    <div class="btn-row">
      <div class="segmented" role="tablist">
        <button :class="{ active: tab === 'installed' }" @click="tab = 'installed'">Installed</button>
        <button data-tour="catalog-tab" :class="{ active: tab === 'catalog' }" @click="tab = 'catalog'">Catalog</button>
      </div>
      <button v-if="auth.can('servers.write')" class="btn primary" @click="openCreate">+ Add server</button>
    </div>
  </div>

  <div v-if="tab === 'installed'" class="card">
    <p v-if="loading" class="muted">Loading…</p>
    <div v-else-if="servers.length === 0" class="empty">
      No upstream MCP servers registered yet. Browse the <a href="#" @click.prevent="tab = 'catalog'">Catalog</a> to add one.
    </div>
    <table v-else>
      <thead>
        <tr><th>Name</th><th>Transport</th><th>Endpoint</th><th>Status</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="s in servers" :key="s.id">
          <td>
            <div style="font-weight: 600">{{ s.name }}</div>
            <small class="muted">{{ s.description }}</small>
          </td>
          <td><small class="muted">{{ s.transport }}</small></td>
          <td><small class="muted">{{ s.transport === 'stdio' ? s.command : s.url }}</small></td>
          <td>
            <span class="badge" :class="s.status">{{ s.status }}</span>
            <div v-if="s.lastError"><small class="muted">{{ s.lastError }}</small></div>
          </td>
          <td>
            <div class="btn-row">
              <button v-if="s.authType === 'oauth' && auth.can('servers.write')" class="btn primary" @click="connectOAuth(s)">Connect</button>
              <button class="btn" @click="sync(s)">Sync</button>
              <button v-if="auth.can('servers.write')" class="btn" @click="openEdit(s)">Edit</button>
              <button v-if="auth.can('servers.delete')" class="btn danger" @click="remove(s)">Delete</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <template v-else>
    <div class="card">
      <div class="catalog-toolbar">
        <input v-model="catalogSearch" data-tour="catalog-search" class="catalog-search" placeholder="Search integrations…" />
        <select v-model="catalogCategory">
          <option value="">All categories</option>
          <option v-for="c in allCategories" :key="c" :value="c">{{ c }}</option>
        </select>
        <span class="muted count">{{ catalogItems.length }} integrations</span>
      </div>
      <p class="muted legend">
        Every integration in one place. <span class="cc-auth native">Built-in</span> run inside Kravn;
        the rest are public MCP servers — <span class="cc-auth open">No auth</span> /
        <span class="cc-auth apikey">API key</span> connect on add, <span class="cc-auth oauth">OAuth 2.1</span>
        with one-click sign-in. Click a card for details.
      </p>
    </div>

    <div class="catalog-grid" data-tour="catalog-grid">
      <div v-for="e in catalogItems" :key="e.key" class="catalog-card">
        <div class="cc-body" role="button" tabindex="0" title="View details" @click="detailItem = e" @keydown.enter="detailItem = e">
          <div class="cc-head">
            <span class="cc-name">{{ e.name }}</span>
            <span v-if="e.kind === 'native'" class="cc-auth native">Built-in</span>
            <span v-else class="cc-auth" :class="e.auth">{{ e.auth ? authLabel[e.auth] : '' }}</span>
          </div>
          <div class="cc-cat muted">{{ e.category }}</div>
          <p class="cc-desc">{{ e.description }}</p>
          <div class="cc-hint muted"><small>Details →</small></div>
        </div>
        <div class="cc-foot">
          <template v-if="e.kind === 'native'">
            <span class="badge" :class="e.plugin?.enabled ? 'online' : 'disabled'">{{ e.plugin?.enabled ? 'on' : 'off' }}</span>
            <template v-if="auth.can('settings.write')">
              <button class="btn" @click="configPlugin = e.plugin ?? null">Config</button>
              <button class="btn" :class="{ primary: !e.plugin?.enabled }" @click="e.plugin && toggleNative(e.plugin)">{{ e.plugin?.enabled ? 'Disable' : 'Enable' }}</button>
            </template>
          </template>
          <template v-else>
            <span v-if="e.installed" class="muted">Added ✓</span>
            <button v-else-if="auth.can('servers.write')" class="btn" @click="e.remote && addFromCatalog(e.remote)">Add</button>
          </template>
        </div>
      </div>
    </div>
  </template>

  <!-- Unified catalog detail modal -->
  <div v-if="detailItem" class="modal-backdrop" @click.self="detailItem = null">
    <div class="modal" style="max-width: 600px">
      <div class="row spread">
        <h2 style="margin: 0">{{ detailItem.name }}</h2>
        <span v-if="detailItem.kind === 'native'" class="cc-auth native">Built-in</span>
        <span v-else class="cc-auth" :class="detailItem.auth">{{ detailItem.auth ? authLabel[detailItem.auth] : '' }}</span>
      </div>
      <div class="cc-cat muted" style="margin-top: 0.4rem">
        {{ detailItem.category }}<template v-if="detailItem.provider"> · {{ detailItem.provider }}</template>
      </div>
      <p style="margin-top: 1rem">{{ detailItem.description }}</p>

      <template v-if="detailItem.kind === 'remote'">
        <div class="cc-kv"><span class="muted">Endpoint</span><code>{{ detailItem.url }}</code></div>
        <div class="cc-kv">
          <span class="muted">Connects with</span>
          <span>{{ detailItem.auth ? authLabel[detailItem.auth] : '' }}<template v-if="detailItem.auth === 'oauth'"> — sign in after adding</template></span>
        </div>
        <div class="setup-note">
          <div class="setup-title">Getting set up</div>
          {{ detailItem.setup || authGuidance(detailItem.auth) }}
          <a v-if="detailItem.docsUrl" :href="detailItem.docsUrl" target="_blank" rel="noopener noreferrer" class="docs-link">Provider docs ↗</a>
        </div>
        <div v-if="detailItem.tags && detailItem.tags.length" class="cc-tags">
          <span v-for="t in detailItem.tags" :key="t" class="badge">{{ t }}</span>
        </div>
      </template>
      <template v-else>
        <div class="cc-kv"><span class="muted">Runs</span><span>In-process, built into Kravn (app-only credential)</span></div>
        <div v-if="detailItem.plugin?.setup" class="setup-note">
          <div class="setup-title">Setup &amp; required permissions</div>
          {{ detailItem.plugin.setup }}
        </div>
      </template>

      <div class="btn-row" style="justify-content: flex-end; margin-top: 1.5rem">
        <button class="btn" @click="detailItem = null">Close</button>
        <template v-if="detailItem.kind === 'native' && auth.can('settings.write')">
          <button class="btn" @click="configPlugin = detailItem.plugin ?? null">Configure</button>
          <button class="btn primary" @click="detailItem.plugin && toggleNative(detailItem.plugin)">{{ detailItem.plugin?.enabled ? 'Disable' : 'Enable' }}</button>
        </template>
        <template v-else-if="detailItem.kind === 'remote'">
          <span v-if="detailItem.installed" class="muted" style="align-self: center">Added ✓</span>
          <button v-else-if="auth.can('servers.write')" class="btn primary" @click="addFromDetail()">Add</button>
        </template>
      </div>
    </div>
  </div>

  <PluginConfigModal v-if="configPlugin" :plugin="configPlugin" @close="configPlugin = null" @saved="onPluginSaved" />

  <!-- OAuth client credentials (providers without automatic app registration, e.g. GitHub) -->
  <div v-if="oauthClient" class="modal-backdrop" @click.self="oauthClient = null">
    <div class="modal" style="max-width: 560px">
      <h2>Connect {{ oauthClient.name }}</h2>
      <p class="muted" style="margin-top: -0.25rem">
        This provider needs a pre-registered OAuth app (it doesn't support automatic registration). Create one
        in the provider's developer settings using the redirect URL below, then paste its Client ID (and
        secret) here.
      </p>
      <div class="field">
        <label>Redirect URL — register this at the provider</label>
        <input :value="oauthCallbackUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
      </div>
      <div class="field">
        <label>Client ID</label>
        <input v-model="oauthClientForm.clientId" placeholder="the OAuth app's Client ID" />
      </div>
      <div class="field">
        <label>Client Secret <span class="muted">(if the app has one)</span></label>
        <input v-model="oauthClientForm.clientSecret" type="password" autocomplete="new-password" placeholder="leave blank for a public/PKCE app" />
      </div>
      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="oauthClient = null">Cancel</button>
        <button class="btn primary" :disabled="!oauthClientForm.clientId.trim()" @click="submitOAuthClient">Continue</button>
      </div>
    </div>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal">
      <h2>{{ editingId ? 'Edit server' : 'Add server' }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="field">
        <label>Name</label>
        <input v-model="form.name" required maxlength="120" />
      </div>
      <div class="field">
        <label>Description</label>
        <input v-model="form.description" maxlength="2000" />
      </div>
      <div class="field" v-if="!editingId">
        <label>Transport</label>
        <select v-model="form.transport">
          <option value="streamable-http">Streamable HTTP</option>
          <option value="sse">SSE</option>
          <option value="stdio">stdio (local process)</option>
        </select>
      </div>

      <template v-if="form.transport !== 'stdio'">
        <div class="field">
          <label>URL</label>
          <input v-model="form.url" maxlength="2048" placeholder="https://my-mcp-server.svc.cluster.local/mcp" />
        </div>
      </template>
      <template v-else>
        <div class="field">
          <label>Command</label>
          <input v-model="form.command" maxlength="2000" placeholder="npx" />
        </div>
        <div class="field">
          <label>Arguments (one per line)</label>
          <textarea v-model="form.argsText" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-everything"></textarea>
        </div>
      </template>

      <div class="field">
        <label>Auth</label>
        <select v-model="form.authType">
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic (user:pass)</option>
          <option value="oauth">OAuth 2.1 (sign in after saving)</option>
        </select>
      </div>
      <div class="field" v-if="form.authType === 'bearer' || form.authType === 'basic'">
        <label>Credential {{ editingId ? '(leave blank to keep current)' : '' }}</label>
        <input v-model="form.authValue" type="password" maxlength="8192" :placeholder="form.authType === 'basic' ? 'user:password' : 'token'" />
      </div>
      <p v-else-if="form.authType === 'oauth'" class="muted oauth-note">
        Save this server, then click <strong>Connect</strong> to sign in with the provider. Kravn stores the
        tokens encrypted and refreshes them automatically.
      </p>

      <div class="field">
        <label>Extra headers (JSON, optional)</label>
        <textarea v-model="form.headersText" rows="2" placeholder='{ "X-Tenant": "acme" }'></textarea>
      </div>

      <div class="field checkbox">
        <input id="enabled" v-model="form.enabled" type="checkbox" />
        <label for="enabled" style="margin: 0">Enabled (connect on save)</label>
      </div>

      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="showModal = false">Cancel</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
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
.cc-name {
  font-weight: 600;
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
  white-space: pre-line;
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
