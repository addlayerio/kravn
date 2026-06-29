<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { UpstreamServer, Transport, AuthType } from '@kravn/contracts';
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
    <h1>Servers</h1>
    <button v-if="auth.can('servers.write')" class="btn primary" @click="openCreate">+ Add server</button>
  </div>

  <div class="card">
    <p v-if="loading" class="muted">Loading…</p>
    <div v-else-if="servers.length === 0" class="empty">No upstream MCP servers registered yet.</div>
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
              <button class="btn" @click="sync(s)">Sync</button>
              <button v-if="auth.can('servers.write')" class="btn" @click="openEdit(s)">Edit</button>
              <button v-if="auth.can('servers.delete')" class="btn danger" @click="remove(s)">Delete</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal">
      <h2>{{ editingId ? 'Edit server' : 'Add server' }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="field">
        <label>Name</label>
        <input v-model="form.name" required />
      </div>
      <div class="field">
        <label>Description</label>
        <input v-model="form.description" />
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
          <input v-model="form.url" placeholder="https://my-mcp-server.svc.cluster.local/mcp" />
        </div>
      </template>
      <template v-else>
        <div class="field">
          <label>Command</label>
          <input v-model="form.command" placeholder="npx" />
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
        </select>
      </div>
      <div class="field" v-if="form.authType !== 'none'">
        <label>Credential {{ editingId ? '(leave blank to keep current)' : '' }}</label>
        <input v-model="form.authValue" type="password" :placeholder="form.authType === 'basic' ? 'user:password' : 'token'" />
      </div>

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
