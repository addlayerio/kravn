<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { McpEndpoint, Tool, Resource, Prompt, LocalPrompt, Team, UpstreamServer } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import PipelineEditor from '../components/PipelineEditor.vue';
import GroupedSelect, { type GroupedItem, type GroupMeta } from '../components/GroupedSelect.vue';
import { serverIconId } from '../lib/server-icon';

const LOCAL_GROUP = '__local__';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toast = useToastStore();
const { t } = useI18n();
const canWrite = auth.can('endpoints.write');

const routeId = computed(() => String(route.params.id));
// The create route is `mcp-endpoints/new` (name `mcp-endpoint-new`) — a static path with NO `:id` param,
// so route.params.id is undefined there. Detect "new" by route name (not a param value that never exists).
const isNew = computed(() => route.name === 'mcp-endpoint-new' || !route.params.id);
const vsId = ref<string | null>(null); // the persisted id (drives the pipeline editor)

const tools = ref<Tool[]>([]);
const resources = ref<Resource[]>([]);
const prompts = ref<Prompt[]>([]);
const localPrompts = ref<LocalPrompt[]>([]);
const teams = ref<Team[]>([]);
const serverMeta = ref<Record<string, GroupMeta>>({});
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

// Flatten each catalog into GroupedSelect rows, bucketed by origin server (serverId). Local prompts
// have no server, so they go under the synthetic LOCAL_GROUP.
const toolItems = computed<GroupedItem[]>(() =>
  tools.value.map((t) => ({ id: t.id, groupId: t.serverId, label: t.name, sublabel: t.description })),
);
const resourceItems = computed<GroupedItem[]>(() =>
  resources.value.map((r) => ({ id: r.id, groupId: r.serverId, label: r.name || r.uri, sublabel: r.uri })),
);
const promptItems = computed<GroupedItem[]>(() => [
  ...localPrompts.value.map((p) => ({ id: p.id, groupId: LOCAL_GROUP, label: p.name, sublabel: p.description, tag: 'local' })),
  ...prompts.value.map((p) => ({ id: p.id, groupId: p.serverId, label: p.name, sublabel: p.description })),
]);

async function load(): Promise<void> {
  loading.value = true;
  try {
    // Fetch everything up front (teams included) so there is NO await between populating the item lists
    // and populating form.*Ids below — otherwise GroupedSelect's length watcher flushes on a microtask
    // during an intervening await and seeds its expanded groups before the selection exists.
    const [v, toolsRes, r, p, lp, sv, tm] = await Promise.all([
      api.get<{ mcpEndpoints: McpEndpoint[] }>('/api/mcp-endpoints'),
      api.get<{ tools: Tool[] }>('/api/tools'),
      api.get<{ resources: Resource[] }>('/api/resources'),
      api.get<{ prompts: Prompt[] }>('/api/prompts'),
      api.get<{ localPrompts: LocalPrompt[] }>('/api/local-prompts'),
      api.get<{ servers: UpstreamServer[] }>('/api/servers').catch(() => ({ servers: [] as UpstreamServer[] })),
      api.get<{ teams: Team[] }>('/api/teams').catch(() => ({ teams: [] as Team[] })),
    ]);
    tools.value = toolsRes.tools;
    resources.value = r.resources;
    prompts.value = p.prompts;
    localPrompts.value = lp.localPrompts;
    teams.value = tm.teams;
    // Group metadata: each origin server's human name + brand-icon id, plus the synthetic local-prompts group.
    serverMeta.value = {
      [LOCAL_GROUP]: { name: t('endpointEditView.kravnPromptsLocal') },
      ...Object.fromEntries(sv.servers.map((s) => [s.id, { name: s.name, iconId: serverIconId(s) }])),
    };

    if (!isNew.value) {
      const found = v.mcpEndpoints.find((x) => x.id === routeId.value);
      if (!found) {
        toast.error(t('endpointEditView.notFound'));
        router.replace('/mcp-endpoints');
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
      await api.patch(`/api/mcp-endpoints/${vsId.value}`, payload);
      toast.success(t('endpointEditView.updated'));
    } else {
      const created = await api.post<{ mcpEndpoint: McpEndpoint }>('/api/mcp-endpoints', payload);
      toast.success(t('endpointEditView.created'));
      // Navigate to the edit route so the pipeline editor (which needs an id) appears.
      router.replace(`/mcp-endpoints/${created.mcpEndpoint.id}`);
      vsId.value = created.mcpEndpoint.id;
    }
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('endpointEditView.saveFailed');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="topbar">
    <div class="row" style="gap: 0.6rem; align-items: center">
      <button class="btn" @click="router.push('/mcp-endpoints')">← {{ t('endpointEditView.back') }}</button>
      <h1 style="margin: 0">{{ isNew ? t('endpointEditView.newEndpoint') : form.name || t('endpointEditView.mcpEndpoint') }}</h1>
    </div>
  </div>

  <div v-if="loading" class="card"><p class="muted">{{ t('endpointEditView.loading') }}</p></div>

  <template v-else>
    <div class="card">
      <h3>{{ t('endpointEditView.configuration') }}</h3>
      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="field"><label>{{ t('endpointEditView.name') }}</label><input v-model="form.name" required :disabled="!canWrite" /></div>
      <div class="field"><label>{{ t('endpointEditView.description') }}</label><input v-model="form.description" :disabled="!canWrite" /></div>

      <div class="field">
        <label>{{ t('endpointEditView.tools') }}</label>
        <small class="muted picker-hint">{{ t('endpointEditView.toolsHint') }}</small>
        <GroupedSelect v-model="form.toolIds" :items="toolItems" :groups="serverMeta" :noun="t('grouped.nounTools')" :disabled="!canWrite" />
      </div>

      <div class="field">
        <label>{{ t('endpointEditView.resources') }}</label>
        <GroupedSelect v-model="form.resourceIds" :items="resourceItems" :groups="serverMeta" :noun="t('grouped.nounResources')" :disabled="!canWrite" />
      </div>

      <div class="field">
        <label>{{ t('endpointEditView.prompts') }}</label>
        <GroupedSelect v-model="form.promptIds" :items="promptItems" :groups="serverMeta" :noun="t('grouped.nounPrompts')" :disabled="!canWrite" />
      </div>

      <div class="field">
        <label>{{ t('endpointEditView.accessPolicy') }}</label>
        <select v-model="form.access" :disabled="!canWrite">
          <option value="public">{{ t('endpointEditView.accessPublic') }}</option>
          <option value="authenticated">{{ t('endpointEditView.accessAuthenticated') }}</option>
          <option value="restricted">{{ t('endpointEditView.accessRestricted') }}</option>
        </select>
        <small class="muted">
          {{ t('endpointEditView.accessNote') }}
        </small>
      </div>
      <div class="field" v-if="form.access === 'restricted'">
        <label>{{ t('endpointEditView.allowedTeams') }}</label>
        <div class="card picker">
          <div v-if="teams.length === 0" class="muted">{{ t('endpointEditView.noTeams') }}</div>
          <label v-for="t in teams" :key="t.id" class="checkbox" style="font-weight: 400">
            <input type="checkbox" :value="t.id" v-model="form.allowedTeams" :disabled="!canWrite" /> {{ t.name }}
          </label>
        </div>
      </div>

      <div class="field checkbox">
        <input id="vs-enabled" v-model="form.enabled" type="checkbox" :disabled="!canWrite" />
        <label for="vs-enabled" style="margin: 0">{{ t('endpointEditView.enabled') }}</label>
      </div>

      <div class="btn-row" style="justify-content: flex-end">
        <button v-if="canWrite" class="btn primary" :disabled="saving" @click="save">
          {{ saving ? t('endpointEditView.saving') : vsId ? t('endpointEditView.saveChanges') : t('endpointEditView.create') }}
        </button>
      </div>
    </div>

    <!-- Per-VS pipeline: only after the VS exists (needs an id). Global hooks show inherited (read-only). -->
    <div v-if="vsId" class="vs-pipeline">
      <h2>{{ t('endpointEditView.pipelineTitle') }}</h2>
      <i18n-t keypath="endpointEditView.pipelineHint" tag="p" class="muted">
        <template #only><strong>{{ t('endpointEditView.pipelineHintOnly') }}</strong></template>
      </i18n-t>
      <PipelineEditor :scope="vsId" />
    </div>
    <div v-else class="card muted">{{ t('endpointEditView.createFirst') }}</div>
  </template>
</template>

<style scoped>
.muted { color: var(--text-muted); }
.picker-hint { display: block; margin: -0.1rem 0 0.4rem; }
.picker { max-height: 160px; overflow: auto; margin: 0; background: var(--bg-page); }
.vs-pipeline { margin-top: 1.5rem; }
.vs-pipeline h2 { margin-bottom: 0.25rem; }
</style>
