<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { VirtualServer, Tool, Resource, Prompt, LocalPrompt, Team } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import PipelineEditor from '../components/PipelineEditor.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toast = useToastStore();
const canWrite = auth.can('virtualservers.write');

const routeId = computed(() => String(route.params.id));
// The create route is `virtual-servers/new` (name `virtual-server-new`) — a static path with NO `:id` param,
// so route.params.id is undefined there. Detect "new" by route name (not a param value that never exists).
const isNew = computed(() => route.name === 'virtual-server-new' || !route.params.id);
const vsId = ref<string | null>(null); // the persisted id (drives the pipeline editor)

const tools = ref<Tool[]>([]);
const resources = ref<Resource[]>([]);
const prompts = ref<Prompt[]>([]);
const localPrompts = ref<LocalPrompt[]>([]);
const teams = ref<Team[]>([]);
const loading = ref(true);
const error = ref('');
const saving = ref(false);

const blank = () => ({
  name: '',
  description: '',
  toolIds: [] as string[],
  resourceIds: [] as string[],
  promptIds: [] as string[],
  access: 'authenticated' as 'public' | 'authenticated' | 'restricted',
  allowedTeams: [] as string[],
  enabled: true,
});
const form = reactive(blank());

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [v, t, r, p, lp] = await Promise.all([
      api.get<{ virtualServers: VirtualServer[] }>('/api/virtual-servers'),
      api.get<{ tools: Tool[] }>('/api/tools'),
      api.get<{ resources: Resource[] }>('/api/resources'),
      api.get<{ prompts: Prompt[] }>('/api/prompts'),
      api.get<{ localPrompts: LocalPrompt[] }>('/api/local-prompts'),
    ]);
    tools.value = t.tools;
    resources.value = r.resources;
    prompts.value = p.prompts;
    localPrompts.value = lp.localPrompts;
    teams.value = (await api.get<{ teams: Team[] }>('/api/teams').catch(() => ({ teams: [] }))).teams;

    if (!isNew.value) {
      const found = v.virtualServers.find((x) => x.id === routeId.value);
      if (!found) {
        toast.error('MCP endpoint not found.');
        router.replace('/virtual-servers');
        return;
      }
      vsId.value = found.id;
      Object.assign(form, {
        name: found.name,
        description: found.description,
        toolIds: [...found.toolIds],
        resourceIds: [...found.resourceIds],
        promptIds: [...found.promptIds],
        access: found.access,
        allowedTeams: [...found.allowedTeams],
        enabled: found.enabled,
      });
    }
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function save(): Promise<void> {
  error.value = '';
  saving.value = true;
  try {
    const payload = { ...form };
    if (vsId.value) {
      await api.patch(`/api/virtual-servers/${vsId.value}`, payload);
      toast.success('MCP endpoint updated.');
    } else {
      const created = await api.post<{ virtualServer: VirtualServer }>('/api/virtual-servers', payload);
      toast.success('MCP endpoint created — now configure its pipeline below.');
      // Navigate to the edit route so the pipeline editor (which needs an id) appears.
      router.replace(`/virtual-servers/${created.virtualServer.id}`);
      vsId.value = created.virtualServer.id;
    }
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Save failed.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="topbar">
    <div class="row" style="gap: 0.6rem; align-items: center">
      <button class="btn" @click="router.push('/virtual-servers')">← Back</button>
      <h1 style="margin: 0">{{ isNew ? 'New MCP endpoint' : form.name || 'MCP endpoint' }}</h1>
    </div>
  </div>

  <div v-if="loading" class="card"><p class="muted">Loading…</p></div>

  <template v-else>
    <div class="card">
      <h3>Configuration</h3>
      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="field"><label>Name</label><input v-model="form.name" required :disabled="!canWrite" /></div>
      <div class="field"><label>Description</label><input v-model="form.description" :disabled="!canWrite" /></div>

      <div class="field">
        <label>Tools ({{ form.toolIds.length }} selected)</label>
        <div class="card picker">
          <div v-if="tools.length === 0" class="muted">No tools available.</div>
          <div v-for="t in tools" :key="t.id" class="checkbox">
            <input :id="`t-${t.id}`" type="checkbox" :value="t.id" v-model="form.toolIds" :disabled="!canWrite" />
            <label :for="`t-${t.id}`" style="margin: 0">{{ t.name }}</label>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Resources ({{ form.resourceIds.length }})</label>
        <div class="card picker">
          <div v-if="resources.length === 0" class="muted">No resources available.</div>
          <div v-for="r in resources" :key="r.id" class="checkbox">
            <input :id="`r-${r.id}`" type="checkbox" :value="r.id" v-model="form.resourceIds" :disabled="!canWrite" />
            <label :for="`r-${r.id}`" style="margin: 0">{{ r.uri }}</label>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Prompts ({{ form.promptIds.length }})</label>
        <div class="card picker">
          <div v-if="prompts.length === 0 && localPrompts.length === 0" class="muted">No prompts available.</div>
          <div v-for="p in localPrompts" :key="p.id" class="checkbox">
            <input :id="`lp-${p.id}`" type="checkbox" :value="p.id" v-model="form.promptIds" :disabled="!canWrite" />
            <label :for="`lp-${p.id}`" style="margin: 0">{{ p.name }} <small class="muted">(local)</small></label>
          </div>
          <div v-for="p in prompts" :key="p.id" class="checkbox">
            <input :id="`p-${p.id}`" type="checkbox" :value="p.id" v-model="form.promptIds" :disabled="!canWrite" />
            <label :for="`p-${p.id}`" style="margin: 0">{{ p.name }}</label>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Access policy</label>
        <select v-model="form.access" :disabled="!canWrite">
          <option value="public">Public — no authentication</option>
          <option value="authenticated">Authenticated — any signed-in user</option>
          <option value="restricted">Restricted — specific teams</option>
        </select>
        <small class="muted">
          Consumption is by team membership — a platform admin consumes a restricted endpoint by being in one
          of its teams, not by being an admin.
        </small>
      </div>
      <div class="field" v-if="form.access === 'restricted'">
        <label>Allowed teams</label>
        <div class="card picker">
          <div v-if="teams.length === 0" class="muted">No teams defined.</div>
          <label v-for="t in teams" :key="t.id" class="checkbox" style="font-weight: 400">
            <input type="checkbox" :value="t.id" v-model="form.allowedTeams" :disabled="!canWrite" /> {{ t.name }}
          </label>
        </div>
      </div>

      <div class="field checkbox">
        <input id="vs-enabled" v-model="form.enabled" type="checkbox" :disabled="!canWrite" />
        <label for="vs-enabled" style="margin: 0">Enabled</label>
      </div>

      <div class="btn-row" style="justify-content: flex-end">
        <button v-if="canWrite" class="btn primary" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : vsId ? 'Save changes' : 'Create' }}
        </button>
      </div>
    </div>

    <!-- Per-VS pipeline: only after the VS exists (needs an id). Global hooks show inherited (read-only). -->
    <div v-if="vsId" class="vs-pipeline">
      <h2>Pipeline for this MCP endpoint</h2>
      <p class="muted">
        Global hooks run first and can't be removed here. Add hooks that run <strong>only</strong> for calls
        routed through this MCP endpoint.
      </p>
      <PipelineEditor :scope="vsId" />
    </div>
    <div v-else class="card muted">Create the MCP endpoint first to configure its own pipeline.</div>
  </template>
</template>

<style scoped>
.muted { color: var(--text-muted); }
.picker { max-height: 160px; overflow: auto; margin: 0; background: var(--bg-page); }
.vs-pipeline { margin-top: 1.5rem; }
.vs-pipeline h2 { margin-bottom: 0.25rem; }
</style>
