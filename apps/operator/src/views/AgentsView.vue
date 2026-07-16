<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatAgent, Tool, Team, User, LlmProvider, UpstreamServer } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import GroupedSelect, { type GroupedItem, type GroupMeta } from '../components/GroupedSelect.vue';
import { serverIconId } from '../lib/server-icon';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();
const canWrite = auth.can('settings.write');

const agents = ref<ChatAgent[]>([]);
const tools = ref<Tool[]>([]);
const teams = ref<Team[]>([]);
const users = ref<User[]>([]);
const providers = ref<LlmProvider[]>([]);
const serverMeta = ref<Record<string, GroupMeta>>({});
const loading = ref(true);

const showModal = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const error = ref('');

const blank = () => ({
  name: '',
  description: '',
  instructions: '',
  providerId: '',
  model: '',
  toolIds: [] as string[],
  access: 'restricted' as 'authenticated' | 'restricted',
  allowedTeams: [] as string[],
  allowedUsers: [] as string[],
  enabled: true,
});
const form = reactive(blank());

const toolItems = computed<GroupedItem[]>(() => tools.value.map((tl) => ({ id: tl.id, groupId: tl.serverId, label: tl.name, sublabel: tl.description })));
/** The models of the picked provider, keeping a custom/legacy value that isn't in the advertised list. */
const modelOptions = computed<string[]>(() => {
  const list = providers.value.find((p) => p.id === form.providerId)?.models ?? [];
  return form.model && !list.includes(form.model) ? [form.model, ...list] : list;
});

function onProvider() {
  const p = providers.value.find((x) => x.id === form.providerId);
  form.model = p?.defaultModel || p?.models[0] || '';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    // Fetch everything up front so there is no await between populating the tool list and the selection
    // (GroupedSelect seeds its expanded groups on a length watcher — see McpEndpointEditView).
    const [ag, tl, tm, us, pr, sv] = await Promise.all([
      api.get<{ agents: ChatAgent[] }>('/api/agents'),
      api.get<{ tools: Tool[] }>('/api/tools'),
      api.get<{ teams: Team[] }>('/api/teams').catch(() => ({ teams: [] as Team[] })),
      api.get<{ users: User[] }>('/api/users').catch(() => ({ users: [] as User[] })),
      api.get<{ providers: LlmProvider[] }>('/api/llm/providers').catch(() => ({ providers: [] as LlmProvider[] })),
      api.get<{ servers: UpstreamServer[] }>('/api/servers').catch(() => ({ servers: [] as UpstreamServer[] })),
    ]);
    agents.value = ag.agents;
    tools.value = tl.tools;
    teams.value = tm.teams;
    users.value = us.users;
    providers.value = pr.providers;
    serverMeta.value = Object.fromEntries(sv.servers.map((s) => [s.id, { name: s.name, iconId: serverIconId(s) }]));
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
function openEdit(a: ChatAgent) {
  Object.assign(form, {
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    providerId: a.providerId,
    model: a.model,
    toolIds: [...a.toolIds],
    access: a.access,
    allowedTeams: [...a.allowedTeams],
    allowedUsers: [...a.allowedUsers],
    enabled: a.enabled,
  });
  editingId.value = a.id;
  error.value = '';
  showModal.value = true;
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    const payload = { ...form };
    if (editingId.value) await api.put(`/api/agents/${editingId.value}`, payload);
    else await api.post('/api/agents', payload);
    showModal.value = false;
    toast.success(editingId.value ? t('agentsView.updated') : t('agentsView.created'));
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('agentsView.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function remove(a: ChatAgent) {
  if (!confirm(t('agentsView.deleteConfirm', { name: a.name }))) return;
  await api.del(`/api/agents/${a.id}`);
  toast.success(t('agentsView.deleted'));
  await load();
}

function accessLabel(a: ChatAgent): string {
  if (a.access === 'authenticated') return t('agentsView.accessAllUsers');
  const parts: string[] = [];
  if (a.allowedTeams.length) parts.push(t('agentsView.nTeams', { n: a.allowedTeams.length }));
  if (a.allowedUsers.length) parts.push(t('agentsView.nUsers', { n: a.allowedUsers.length }));
  return parts.length ? parts.join(' · ') : t('agentsView.accessNobody');
}
</script>

<template>
  <div class="topbar">
    <h1>{{ t('agentsView.title') }}</h1>
    <button v-if="canWrite" class="btn primary" @click="openCreate">{{ t('agentsView.newAgent') }}</button>
  </div>

  <div class="card">
    <p class="muted" style="margin-top: 0">{{ t('agentsView.intro') }}</p>
    <p v-if="loading" class="muted">{{ t('agentsView.loading') }}</p>
    <div v-else-if="agents.length === 0" class="empty">{{ t('agentsView.empty') }}</div>
    <table v-else>
      <thead>
        <tr><th>{{ t('agentsView.colName') }}</th><th>{{ t('agentsView.colModel') }}</th><th>{{ t('agentsView.colTools') }}</th><th>{{ t('agentsView.colAccess') }}</th><th>{{ t('agentsView.colEnabled') }}</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="a in agents" :key="a.id">
          <td>
            <div style="font-weight: 600">{{ a.name }}</div>
            <small v-if="a.description" class="muted">{{ a.description }}</small>
          </td>
          <td><small class="muted">{{ a.model || '—' }}</small></td>
          <td><small class="muted">{{ a.toolIds.length }}</small></td>
          <td><small class="muted">{{ accessLabel(a) }}</small></td>
          <td><span class="badge" :class="a.enabled ? 'online' : 'disabled'">{{ a.enabled ? t('agentsView.on') : t('agentsView.off') }}</span></td>
          <td>
            <div class="btn-row" v-if="canWrite">
              <button class="btn" @click="openEdit(a)">{{ t('agentsView.edit') }}</button>
              <button class="btn danger" @click="remove(a)">{{ t('agentsView.delete') }}</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal" style="max-width: 760px">
      <h2>{{ editingId ? t('agentsView.editAgent') : t('agentsView.newAgentTitle') }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="field"><label>{{ t('agentsView.nameLabel') }}</label><input v-model="form.name" :placeholder="t('agentsView.namePlaceholder')" /></div>
      <div class="field"><label>{{ t('agentsView.descriptionLabel') }}</label><input v-model="form.description" /></div>

      <div class="field">
        <label>{{ t('agentsView.instructionsLabel') }}</label>
        <textarea v-model="form.instructions" rows="6" :placeholder="t('agentsView.instructionsPlaceholder')"></textarea>
      </div>

      <div class="row" style="gap: 1rem">
        <div class="field" style="flex: 1">
          <label>{{ t('agentsView.providerLabel') }}</label>
          <select v-model="form.providerId" @change="onProvider">
            <option value="">{{ t('agentsView.noProvider') }}</option>
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <div class="field" style="flex: 1">
          <label>{{ t('agentsView.modelLabel') }}</label>
          <select v-if="modelOptions.length" v-model="form.model">
            <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
          </select>
          <input v-else v-model="form.model" :placeholder="t('agentsView.modelPlaceholder')" />
        </div>
      </div>

      <div class="field">
        <label>{{ t('agentsView.toolsLabel') }}</label>
        <small class="muted picker-hint">{{ t('agentsView.toolsHint') }}</small>
        <GroupedSelect v-model="form.toolIds" :items="toolItems" :groups="serverMeta" :noun="t('grouped.nounTools')" :disabled="!canWrite" />
      </div>

      <div class="field">
        <label>{{ t('agentsView.accessLabel') }}</label>
        <select v-model="form.access">
          <option value="authenticated">{{ t('agentsView.accessAllUsers') }}</option>
          <option value="restricted">{{ t('agentsView.accessRestricted') }}</option>
        </select>
        <small class="muted">{{ t('agentsView.accessNote') }}</small>
      </div>

      <div v-if="form.access === 'restricted'" class="row" style="gap: 1rem">
        <div class="field" style="flex: 1">
          <label>{{ t('agentsView.allowedTeams') }}</label>
          <div class="card picker">
            <div v-if="teams.length === 0" class="muted">{{ t('agentsView.noTeams') }}</div>
            <label v-for="tm in teams" :key="tm.id" class="checkbox" style="font-weight: 400">
              <input type="checkbox" :value="tm.id" v-model="form.allowedTeams" /> {{ tm.name }}
            </label>
          </div>
        </div>
        <div class="field" style="flex: 1">
          <label>{{ t('agentsView.allowedUsers') }}</label>
          <div class="card picker">
            <div v-if="users.length === 0" class="muted">{{ t('agentsView.noUsers') }}</div>
            <label v-for="us in users" :key="us.id" class="checkbox" style="font-weight: 400">
              <input type="checkbox" :value="us.id" v-model="form.allowedUsers" /> {{ us.name || us.email }}
            </label>
          </div>
        </div>
      </div>

      <div class="field checkbox">
        <input id="agent-enabled" v-model="form.enabled" type="checkbox" />
        <label for="agent-enabled" style="margin: 0">{{ t('agentsView.enabledLabel') }}</label>
      </div>

      <div class="btn-row" style="justify-content: flex-end; margin-top: 1rem">
        <button class="btn" @click="showModal = false">{{ t('agentsView.cancel') }}</button>
        <button v-if="canWrite" class="btn primary" :disabled="saving" @click="save">{{ saving ? t('agentsView.saving') : t('agentsView.save') }}</button>
      </div>
    </div>
  </div>
</template>
