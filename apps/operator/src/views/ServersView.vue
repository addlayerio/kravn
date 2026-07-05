<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { UpstreamServer, Transport, AuthType, CatalogServer } from '@kravn/contracts';
import { MCP_SERVER_CATALOG, CATALOG_CATEGORIES } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

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

const filteredCatalog = computed(() => {
  const q = catalogSearch.value.trim().toLowerCase();
  const cat = catalogCategory.value;
  return MCP_SERVER_CATALOG.filter((s) => {
    if (cat && s.category !== cat) return false;
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      (s.tags ?? []).some((t) => t.includes(q))
    );
  });
});

const authLabel: Record<CatalogServer['auth'], string> = {
  open: 'No auth',
  apikey: 'API key',
  oauth: 'OAuth 2.1',
};

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ servers: UpstreamServer[] }>('/api/servers');
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

// OAuth 2.1 servers: open the provider sign-in, then poll until the callback connects the server.
async function connectOAuth(srv: UpstreamServer) {
  try {
    const res = await api.post<{ authorizationUrl: string }>(`/api/servers/${srv.id}/oauth/authorize`);
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
    toast.error(e instanceof ApiError ? e.message : 'Could not start OAuth authorization.');
  }
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
        <button :class="{ active: tab === 'catalog' }" @click="tab = 'catalog'">Catalog</button>
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
        <input v-model="catalogSearch" class="catalog-search" placeholder="Search integrations…" />
        <select v-model="catalogCategory">
          <option value="">All categories</option>
          <option v-for="c in catalogCategories" :key="c" :value="c">{{ c }}</option>
        </select>
        <span class="muted count">{{ filteredCatalog.length }} servers</span>
      </div>
      <p class="muted legend">
        Curated public MCP servers — one click prefills the connection.
        <span class="cc-auth open">No auth</span> and <span class="cc-auth apikey">API key</span> connect now;
        <span class="cc-auth oauth">OAuth 2.1</span> upstream sign-in is rolling out.
      </p>
    </div>

    <div class="catalog-grid">
      <div v-for="e in filteredCatalog" :key="e.id" class="catalog-card">
        <div class="cc-head">
          <span class="cc-name">{{ e.name }}</span>
          <span class="cc-auth" :class="e.auth">{{ authLabel[e.auth] }}</span>
        </div>
        <div class="cc-cat muted">{{ e.category }}</div>
        <p class="cc-desc">{{ e.description }}</p>
        <div class="cc-foot">
          <span v-if="installedUrls.has(e.url)" class="muted">Added ✓</span>
          <button v-else-if="auth.can('servers.write')" class="btn" @click="addFromCatalog(e)">Add</button>
        </div>
      </div>
    </div>
  </template>

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
.cc-foot {
  display: flex;
  justify-content: flex-end;
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
