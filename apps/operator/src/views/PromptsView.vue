<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { Prompt, LocalPrompt, LocalPromptArgument, UpstreamServer } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

const auth = useAuthStore();
const toast = useToastStore();

const locals = ref<LocalPrompt[]>([]);
const discovered = ref<Prompt[]>([]);
const servers = ref<Record<string, UpstreamServer>>({});
const loading = ref(true);

const showModal = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const error = ref('');

const blank = () => ({
  name: '',
  description: '',
  role: 'user' as 'user' | 'assistant' | 'system',
  template: '',
  arguments: [] as LocalPromptArgument[],
  enabled: true,
});
const form = reactive(blank());

const previewValues = reactive<Record<string, string>>({});
const previewOutput = ref('');
const previewError = ref('');

// Literal examples for the UI (kept in script so Vue doesn't try to interpolate the braces).
const argExample = '{{ argName }}';
const templatePlaceholder = 'Summarize the following ticket for {{ audience }}:\n\n{{ content }}';

async function load() {
  loading.value = true;
  try {
    const [lp, dp, sv] = await Promise.all([
      api.get<{ localPrompts: LocalPrompt[] }>('/api/local-prompts'),
      api.get<{ prompts: Prompt[] }>('/api/prompts'),
      api.get<{ servers: UpstreamServer[] }>('/api/servers'),
    ]);
    locals.value = lp.localPrompts;
    discovered.value = dp.prompts;
    servers.value = Object.fromEntries(sv.servers.map((s) => [s.id, s]));
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openCreate() {
  Object.assign(form, blank());
  editingId.value = null;
  error.value = '';
  previewOutput.value = '';
  previewError.value = '';
  showModal.value = true;
}
function openEdit(p: LocalPrompt) {
  Object.assign(form, {
    name: p.name,
    description: p.description,
    role: p.role,
    template: p.template,
    arguments: p.arguments.map((a) => ({ ...a })),
    enabled: p.enabled,
  });
  editingId.value = p.id;
  error.value = '';
  previewOutput.value = '';
  previewError.value = '';
  showModal.value = true;
}

function addArg() {
  form.arguments.push({ name: '', description: '', required: false });
}
function removeArg(i: number) {
  form.arguments.splice(i, 1);
}

async function preview() {
  previewError.value = '';
  previewOutput.value = '';
  try {
    const values: Record<string, unknown> = {};
    for (const a of form.arguments) values[a.name] = previewValues[a.name] ?? '';
    const res = await api.post<{ rendered: string }>('/api/local-prompts/preview', { template: form.template, values });
    previewOutput.value = res.rendered;
  } catch (e) {
    previewError.value = e instanceof ApiError ? e.message : 'Preview failed.';
  }
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    const payload = {
      name: form.name,
      description: form.description,
      role: form.role,
      template: form.template,
      arguments: form.arguments.filter((a) => a.name.trim()),
      enabled: form.enabled,
    };
    if (editingId.value) await api.patch(`/api/local-prompts/${editingId.value}`, payload);
    else await api.post('/api/local-prompts', payload);
    showModal.value = false;
    toast.success(editingId.value ? 'Prompt updated.' : 'Prompt created.');
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Save failed.';
  } finally {
    saving.value = false;
  }
}

async function remove(p: LocalPrompt) {
  if (!confirm(`Delete prompt "${p.name}"?`)) return;
  await api.del(`/api/local-prompts/${p.id}`);
  toast.success('Prompt deleted.');
  await load();
}
</script>

<template>
  <div class="topbar">
    <h1>Prompts</h1>
    <button v-if="auth.can('registry.write')" class="btn primary" @click="openCreate">+ New prompt</button>
  </div>

  <div class="card">
    <h3>Kravn prompts</h3>
    <p class="muted" style="margin-top: -0.25rem">
      Reusable prompt templates (Jinja2-compatible) you author here and expose over MCP — globally or inside a virtual server.
    </p>
    <p v-if="loading" class="muted">Loading…</p>
    <div v-else-if="locals.length === 0" class="empty">No prompts yet. Create one to expose it via <code>prompts/list</code>.</div>
    <table v-else>
      <thead>
        <tr><th>Name</th><th>Description</th><th>Args</th><th>Ver</th><th>Enabled</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="p in locals" :key="p.id">
          <td style="font-weight: 600">{{ p.name }}</td>
          <td><small class="muted">{{ p.description }}</small></td>
          <td><small class="muted">{{ p.arguments.length }}</small></td>
          <td><small class="muted">v{{ p.version }}</small></td>
          <td><span class="badge" :class="p.enabled ? 'online' : 'disabled'">{{ p.enabled ? 'on' : 'off' }}</span></td>
          <td>
            <div class="btn-row" v-if="auth.can('registry.write')">
              <button class="btn" @click="openEdit(p)">Edit</button>
              <button class="btn danger" @click="remove(p)">Delete</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h3>Discovered prompts</h3>
    <p class="muted" style="margin-top: -0.25rem">Imported from upstream servers (read-only).</p>
    <div v-if="!loading && discovered.length === 0" class="empty">No discovered prompts.</div>
    <table v-else-if="!loading">
      <thead>
        <tr><th>Name</th><th>Server</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr v-for="p in discovered" :key="p.id">
          <td style="font-weight: 600">{{ p.name }}</td>
          <td><small class="muted">{{ servers[p.serverId]?.name || p.serverId }}</small></td>
          <td><small class="muted">{{ p.description }}</small></td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal" style="max-width: 720px">
      <h2>{{ editingId ? 'Edit prompt' : 'New prompt' }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="row" style="gap: 1rem">
        <div class="field" style="flex: 2"><label>Name</label><input v-model="form.name" placeholder="summarize_ticket" /></div>
        <div class="field" style="flex: 1">
          <label>Message role</label>
          <select v-model="form.role"><option value="user">user</option><option value="assistant">assistant</option><option value="system">system</option></select>
        </div>
      </div>
      <div class="field"><label>Description</label><input v-model="form.description" /></div>

      <div class="field">
        <label>Template — use <code>{{ argExample }}</code> for variables (Jinja2: <code>if</code>/<code>for</code>/filters supported)</label>
        <textarea v-model="form.template" rows="6" :placeholder="templatePlaceholder"></textarea>
      </div>

      <div class="field">
        <label>Arguments</label>
        <div v-for="(a, i) in form.arguments" :key="i" class="row" style="gap: 0.5rem; margin-bottom: 0.4rem">
          <input v-model="a.name" placeholder="name" style="flex: 1" />
          <input v-model="a.description" placeholder="description (optional)" style="flex: 2" />
          <label class="checkbox" style="white-space: nowrap"><input v-model="a.required" type="checkbox" /> required</label>
          <button class="btn danger" @click="removeArg(i)">✕</button>
        </div>
        <button class="btn" @click="addArg">+ Add argument</button>
      </div>

      <div class="field checkbox">
        <input id="lp-enabled" v-model="form.enabled" type="checkbox" />
        <label for="lp-enabled" style="margin: 0">Enabled</label>
      </div>

      <div class="card" style="background: var(--bg)">
        <div class="row spread">
          <strong>Preview</strong>
          <button class="btn" @click="preview">Render preview</button>
        </div>
        <div v-if="form.arguments.length" class="grid" style="grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); margin-top: 0.5rem">
          <div v-for="a in form.arguments" :key="a.name">
            <label>{{ a.name }}</label>
            <input v-model="previewValues[a.name]" :placeholder="a.description" />
          </div>
        </div>
        <div v-if="previewError" class="alert error" style="margin-top: 0.5rem">{{ previewError }}</div>
        <pre v-if="previewOutput" class="code" style="margin-top: 0.5rem">{{ previewOutput }}</pre>
      </div>

      <div class="btn-row" style="justify-content: flex-end; margin-top: 1rem">
        <button class="btn" @click="showModal = false">Cancel</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
      </div>
    </div>
  </div>
</template>
