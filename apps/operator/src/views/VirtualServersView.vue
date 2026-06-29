<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { VirtualServer, Tool, Resource, Prompt, LocalPrompt, Team } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import { copyText } from '../lib/clipboard';

const auth = useAuthStore();
const toast = useToastStore();
const vservers = ref<VirtualServer[]>([]);
const tools = ref<Tool[]>([]);
const resources = ref<Resource[]>([]);
const prompts = ref<Prompt[]>([]);
const localPrompts = ref<LocalPrompt[]>([]);
const teams = ref<Team[]>([]);
const loading = ref(true);
const error = ref('');
const saving = ref(false);

const showModal = ref(false);
const editingId = ref<string | null>(null);
const blank = () => ({
  name: '',
  description: '',
  toolIds: [] as string[],
  resourceIds: [] as string[],
  promptIds: [] as string[],
  access: 'authenticated' as 'public' | 'authenticated' | 'restricted',
  allowedRoles: [] as string[],
  allowedTeams: [] as string[],
  enabled: true,
});
const form = reactive(blank());

async function load() {
  loading.value = true;
  try {
    const [v, t, r, p, lp] = await Promise.all([
      api.get<{ virtualServers: VirtualServer[] }>('/api/virtual-servers'),
      api.get<{ tools: Tool[] }>('/api/tools'),
      api.get<{ resources: Resource[] }>('/api/resources'),
      api.get<{ prompts: Prompt[] }>('/api/prompts'),
      api.get<{ localPrompts: LocalPrompt[] }>('/api/local-prompts'),
    ]);
    vservers.value = v.virtualServers;
    tools.value = t.tools;
    resources.value = r.resources;
    prompts.value = p.prompts;
    localPrompts.value = lp.localPrompts;
    teams.value = (await api.get<{ teams: Team[] }>('/api/teams').catch(() => ({ teams: [] }))).teams;
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
function openEdit(v: VirtualServer) {
  Object.assign(form, {
    name: v.name,
    description: v.description,
    toolIds: [...v.toolIds],
    resourceIds: [...v.resourceIds],
    promptIds: [...v.promptIds],
    access: v.access,
    allowedRoles: [...v.allowedRoles],
    allowedTeams: [...v.allowedTeams],
    enabled: v.enabled,
  });
  editingId.value = v.id;
  error.value = '';
  showModal.value = true;
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    const payload = { ...form };
    if (editingId.value) await api.patch(`/api/virtual-servers/${editingId.value}`, payload);
    else await api.post('/api/virtual-servers', payload);
    showModal.value = false;
    toast.success(editingId.value ? 'Virtual server updated.' : 'Virtual server created.');
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Save failed.';
  } finally {
    saving.value = false;
  }
}

async function remove(v: VirtualServer) {
  if (!confirm(`Delete virtual server "${v.name}"?`)) return;
  await api.del(`/api/virtual-servers/${v.id}`);
  toast.success('Virtual server deleted.');
  await load();
}

function endpoint(slug: string): string {
  return `${location.origin}/servers/${slug}/mcp`;
}
async function copyUrl(slug: string): Promise<void> {
  const ok = await copyText(endpoint(slug));
  if (ok) toast.success('MCP endpoint URL copied to clipboard.');
  else toast.error(`Copy failed — the URL is: ${endpoint(slug)}`);
}
</script>

<template>
  <div class="topbar">
    <h1>Virtual servers</h1>
    <button v-if="auth.can('virtualservers.write')" class="btn primary" @click="openCreate">+ New virtual server</button>
  </div>

  <p class="muted" style="margin-top: -0.5rem">
    Compose tools, resources and prompts from multiple upstreams into a single MCP endpoint.
  </p>

  <div class="card">
    <p v-if="loading" class="muted">Loading…</p>
    <div v-else-if="vservers.length === 0" class="empty">No virtual servers yet.</div>
    <table v-else>
      <thead>
        <tr><th>Name</th><th>Contents</th><th>MCP endpoint</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="v in vservers" :key="v.id">
          <td>
            <div style="font-weight: 600">{{ v.name }}</div>
            <small class="muted">{{ v.description }}</small>
          </td>
          <td>
            <small class="muted">{{ v.toolIds.length }} tools · {{ v.resourceIds.length }} resources · {{ v.promptIds.length }} prompts</small>
            <div><span class="badge" style="margin-top: 0.25rem">{{ v.access }}</span></div>
          </td>
          <td><small style="font-family: ui-monospace, monospace">/servers/{{ v.slug }}/mcp</small></td>
          <td>
            <div class="btn-row">
              <button class="btn" @click="copyUrl(v.slug)">Copy URL</button>
              <button v-if="auth.can('virtualservers.write')" class="btn" @click="openEdit(v)">Edit</button>
              <button v-if="auth.can('virtualservers.delete')" class="btn danger" @click="remove(v)">Delete</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal">
      <h2>{{ editingId ? 'Edit' : 'New' }} virtual server</h2>
      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="field"><label>Name</label><input v-model="form.name" required /></div>
      <div class="field"><label>Description</label><input v-model="form.description" /></div>

      <div class="field">
        <label>Tools ({{ form.toolIds.length }} selected)</label>
        <div class="card" style="max-height: 160px; overflow: auto; margin: 0">
          <div v-if="tools.length === 0" class="muted">No tools available.</div>
          <div v-for="t in tools" :key="t.id" class="checkbox">
            <input :id="`t-${t.id}`" type="checkbox" :value="t.id" v-model="form.toolIds" />
            <label :for="`t-${t.id}`" style="margin: 0">{{ t.name }}</label>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Resources ({{ form.resourceIds.length }})</label>
        <div class="card" style="max-height: 120px; overflow: auto; margin: 0">
          <div v-if="resources.length === 0" class="muted">No resources available.</div>
          <div v-for="r in resources" :key="r.id" class="checkbox">
            <input :id="`r-${r.id}`" type="checkbox" :value="r.id" v-model="form.resourceIds" />
            <label :for="`r-${r.id}`" style="margin: 0">{{ r.uri }}</label>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Prompts ({{ form.promptIds.length }})</label>
        <div class="card" style="max-height: 140px; overflow: auto; margin: 0">
          <div v-if="prompts.length === 0 && localPrompts.length === 0" class="muted">No prompts available.</div>
          <div v-for="p in localPrompts" :key="p.id" class="checkbox">
            <input :id="`lp-${p.id}`" type="checkbox" :value="p.id" v-model="form.promptIds" />
            <label :for="`lp-${p.id}`" style="margin: 0">{{ p.name }} <small class="muted">(local)</small></label>
          </div>
          <div v-for="p in prompts" :key="p.id" class="checkbox">
            <input :id="`p-${p.id}`" type="checkbox" :value="p.id" v-model="form.promptIds" />
            <label :for="`p-${p.id}`" style="margin: 0">{{ p.name }}</label>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Access policy</label>
        <select v-model="form.access">
          <option value="public">Public — no authentication</option>
          <option value="authenticated">Authenticated — any signed-in user</option>
          <option value="restricted">Restricted — specific roles</option>
        </select>
      </div>
      <div class="field" v-if="form.access === 'restricted'">
        <label>Allowed roles</label>
        <div class="row" style="gap: 1rem">
          <label v-for="r in ['admin', 'editor', 'viewer']" :key="r" class="checkbox">
            <input type="checkbox" :value="r" v-model="form.allowedRoles" /> {{ r }}
          </label>
        </div>
      </div>
      <div class="field" v-if="form.access === 'restricted'">
        <label>Allowed teams</label>
        <div class="card" style="max-height: 120px; overflow: auto; margin: 0; background: var(--bg-page)">
          <div v-if="teams.length === 0" class="muted">No teams defined.</div>
          <label v-for="t in teams" :key="t.id" class="checkbox" style="font-weight: 400">
            <input type="checkbox" :value="t.id" v-model="form.allowedTeams" /> {{ t.name }}
          </label>
        </div>
        <small class="muted">Members of any selected team (or any selected role) may use this server.</small>
      </div>

      <div class="field checkbox">
        <input id="vs-enabled" v-model="form.enabled" type="checkbox" />
        <label for="vs-enabled" style="margin: 0">Enabled</label>
      </div>

      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="showModal = false">Cancel</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
      </div>
    </div>
  </div>
</template>
