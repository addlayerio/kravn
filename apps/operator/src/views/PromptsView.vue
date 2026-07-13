<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Prompt, LocalPrompt, LocalPromptArgument, UpstreamServer } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import GroupedList, { type GroupListMeta } from '../components/GroupedList.vue';
import { serverIconId } from '../lib/server-icon';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

const locals = ref<LocalPrompt[]>([]);
const discovered = ref<Prompt[]>([]);
const servers = ref<Record<string, UpstreamServer>>({});
const loading = ref(true);

const serverMeta = computed<Record<string, GroupListMeta>>(() =>
  Object.fromEntries(Object.values(servers.value).map((s) => [s.id, { name: s.name, iconId: serverIconId(s) }])),
);
const discoveredItems = computed(() => discovered.value.map((p) => ({ ...p, groupId: p.serverId })));

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
    previewError.value = e instanceof ApiError ? e.message : t('promptsView.previewFailed');
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
    toast.success(editingId.value ? t('promptsView.promptUpdated') : t('promptsView.promptCreated'));
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('promptsView.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function remove(p: LocalPrompt) {
  if (!confirm(t('promptsView.deleteConfirm', { name: p.name }))) return;
  await api.del(`/api/local-prompts/${p.id}`);
  toast.success(t('promptsView.promptDeleted'));
  await load();
}
</script>

<template>
  <div class="topbar">
    <h1>{{ t('promptsView.title') }}</h1>
    <button v-if="auth.can('registry.write')" data-tour="prompt-new" class="btn primary" @click="openCreate">{{ t('promptsView.newPrompt') }}</button>
  </div>

  <div class="card">
    <h3>{{ t('promptsView.kravnPrompts') }}</h3>
    <p class="muted" style="margin-top: -0.25rem">
      {{ t('promptsView.kravnPromptsIntro') }}
    </p>
    <p v-if="loading" class="muted">{{ t('promptsView.loading') }}</p>
    <div v-else-if="locals.length === 0" class="empty">{{ t('promptsView.noPromptsPre') }} <code>prompts/list</code>{{ t('promptsView.noPromptsPost') }}</div>
    <table v-else>
      <thead>
        <tr><th>{{ t('promptsView.colName') }}</th><th>{{ t('promptsView.colDescription') }}</th><th>{{ t('promptsView.colArgs') }}</th><th>{{ t('promptsView.colVer') }}</th><th>{{ t('promptsView.colEnabled') }}</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="p in locals" :key="p.id">
          <td style="font-weight: 600">{{ p.name }}</td>
          <td><small class="muted">{{ p.description }}</small></td>
          <td><small class="muted">{{ p.arguments.length }}</small></td>
          <td><small class="muted">v{{ p.version }}</small></td>
          <td><span class="badge" :class="p.enabled ? 'online' : 'disabled'">{{ p.enabled ? t('promptsView.on') : t('promptsView.off') }}</span></td>
          <td>
            <div class="btn-row" v-if="auth.can('registry.write')">
              <button class="btn" @click="openEdit(p)">{{ t('promptsView.edit') }}</button>
              <button class="btn danger" @click="remove(p)">{{ t('promptsView.delete') }}</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h3>{{ t('promptsView.discoveredPrompts') }}</h3>
    <p class="muted" style="margin-top: -0.25rem">{{ t('promptsView.discoveredIntro') }}</p>
    <div v-if="!loading && discovered.length === 0" class="empty">{{ t('promptsView.noDiscovered') }}</div>
    <GroupedList
      v-else-if="!loading"
      :items="discoveredItems"
      :groups="serverMeta"
      :noun="t('grouped.nounPrompts')"
      :search-text="(p) => `${p.name} ${p.description}`"
    >
      <template #row="{ item: p }">
        <div class="rl-main">
          <div class="rl-name">{{ p.name }}</div>
          <small v-if="p.description" class="muted">{{ p.description }}</small>
        </div>
      </template>
    </GroupedList>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal" style="max-width: 720px">
      <h2>{{ editingId ? t('promptsView.editPrompt') : t('promptsView.newPromptTitle') }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="row" style="gap: 1rem">
        <div class="field" style="flex: 2"><label>{{ t('promptsView.nameLabel') }}</label><input v-model="form.name" placeholder="summarize_ticket" /></div>
        <div class="field" style="flex: 1">
          <label>{{ t('promptsView.messageRole') }}</label>
          <select v-model="form.role"><option value="user">user</option><option value="assistant">assistant</option><option value="system">system</option></select>
        </div>
      </div>
      <div class="field"><label>{{ t('promptsView.descriptionLabel') }}</label><input v-model="form.description" /></div>

      <div class="field">
        <label>{{ t('promptsView.templateLabelUse') }} <code>{{ argExample }}</code> {{ t('promptsView.templateLabelVars') }} <code>if</code>/<code>for</code>{{ t('promptsView.templateLabelFilters') }}</label>
        <textarea v-model="form.template" rows="6" :placeholder="templatePlaceholder"></textarea>
      </div>

      <div class="field">
        <label>{{ t('promptsView.argumentsLabel') }}</label>
        <div v-for="(a, i) in form.arguments" :key="i" class="row" style="gap: 0.5rem; margin-bottom: 0.4rem">
          <input v-model="a.name" :placeholder="t('promptsView.argNamePlaceholder')" style="flex: 1" />
          <input v-model="a.description" :placeholder="t('promptsView.argDescPlaceholder')" style="flex: 2" />
          <label class="checkbox" style="white-space: nowrap"><input v-model="a.required" type="checkbox" /> {{ t('promptsView.required') }}</label>
          <button class="btn danger" @click="removeArg(i)">✕</button>
        </div>
        <button class="btn" @click="addArg">{{ t('promptsView.addArgument') }}</button>
      </div>

      <div class="field checkbox">
        <input id="lp-enabled" v-model="form.enabled" type="checkbox" />
        <label for="lp-enabled" style="margin: 0">{{ t('promptsView.enabledLabel') }}</label>
      </div>

      <div class="card" style="background: var(--bg)">
        <div class="row spread">
          <strong>{{ t('promptsView.preview') }}</strong>
          <button class="btn" @click="preview">{{ t('promptsView.renderPreview') }}</button>
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
        <button class="btn" @click="showModal = false">{{ t('promptsView.cancel') }}</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? t('promptsView.saving') : t('promptsView.save') }}</button>
      </div>
    </div>
  </div>
</template>
