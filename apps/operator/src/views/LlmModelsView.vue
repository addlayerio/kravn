<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { LLM_MODEL_CATALOG, type LlmProvider, type LlmProviderType, type LlmTestResult, type LlmModelsResult } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();
const canWrite = auth.can('settings.write');

const providers = ref<LlmProvider[]>([]);
const loading = ref(true);
const testing = ref<string | null>(null);

const showModal = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const error = ref('');

const TYPES: { value: LlmProviderType; label: string; base: string }[] = [
  { value: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: 'Anthropic', base: 'https://api.anthropic.com' },
  { value: 'gemini', label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com' },
  { value: 'azure-openai', label: 'Azure OpenAI', base: 'https://<resource>.openai.azure.com' },
  { value: 'ollama', label: 'Ollama (local)', base: 'http://localhost:11434/v1' },
  { value: 'openai-compatible', label: 'OpenAI-compatible', base: 'https://...' },
];

const blank = () => ({
  name: '',
  type: 'openai' as LlmProviderType,
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
  enabled: true,
  selected: [] as string[],
});
const form = reactive(blank());

// Candidate model ids shown as a multiselect (catalog ∪ discovered ∪ already-selected ∪ custom).
const candidates = ref<string[]>([]);
const discovering = ref(false);
const discoverNote = ref('');
const customModel = ref('');

function baseHint(t: LlmProviderType): string {
  return TYPES.find((x) => x.value === t)?.base ?? '';
}
function uniqSort(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))].sort();
}

async function load() {
  loading.value = true;
  try {
    providers.value = (await api.get<{ providers: LlmProvider[] }>('/api/llm/providers')).providers;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openCreate() {
  Object.assign(form, blank());
  candidates.value = uniqSort([...(LLM_MODEL_CATALOG[form.type] ?? [])]);
  discoverNote.value = '';
  customModel.value = '';
  editingId.value = null;
  error.value = '';
  showModal.value = true;
}
function openEdit(p: LlmProvider) {
  Object.assign(form, {
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    apiKey: '',
    defaultModel: p.defaultModel,
    enabled: p.enabled,
    selected: [...p.models],
  });
  candidates.value = uniqSort([...(LLM_MODEL_CATALOG[p.type] ?? []), ...p.models]);
  discoverNote.value = '';
  customModel.value = '';
  editingId.value = p.id;
  error.value = '';
  showModal.value = true;
}

// Native cloud providers have a built-in default base URL (see the gateway's DEFAULT_BASE); only
// custom/self-hosted types (Azure, Ollama/vLLM, OpenAI-compatible) need an endpoint entered.
const NATIVE_TYPES: LlmProviderType[] = ['openai', 'anthropic', 'gemini'];
function onTypeChange() {
  candidates.value = uniqSort([...(LLM_MODEL_CATALOG[form.type] ?? [])]);
  form.selected = [];
  form.defaultModel = '';
  discoverNote.value = '';
  if (NATIVE_TYPES.includes(form.type)) form.baseUrl = ''; // use the built-in default; the field is hidden
}

function toggleModel(m: string) {
  const i = form.selected.indexOf(m);
  if (i >= 0) {
    form.selected.splice(i, 1);
    if (form.defaultModel === m) form.defaultModel = ''; // keep the default-model select in sync
  } else {
    form.selected.push(m);
  }
}

function addCustom() {
  const m = customModel.value.trim();
  if (!m) return;
  candidates.value = uniqSort([...candidates.value, m]);
  if (!form.selected.includes(m)) form.selected.push(m);
  customModel.value = '';
}

async function fetchModels() {
  discovering.value = true;
  discoverNote.value = '';
  try {
    const body: Record<string, unknown> = { type: form.type, baseUrl: form.baseUrl };
    if (editingId.value) body.providerId = editingId.value;
    if (form.apiKey) body.apiKey = form.apiKey;
    const { result } = await api.post<{ result: LlmModelsResult }>('/api/llm/discover', body);
    candidates.value = uniqSort([...candidates.value, ...result.models]);
    discoverNote.value = result.message;
    if (result.source === 'live') toast.success(t('llmModelsView.foundModels', { count: result.models.length }));
  } catch (e) {
    discoverNote.value = e instanceof ApiError ? e.message : t('llmModelsView.couldNotFetchModels');
  } finally {
    discovering.value = false;
  }
}

async function save() {
  error.value = '';
  if (form.selected.length === 0) {
    error.value = t('llmModelsView.selectAtLeastOneModel');
    return;
  }
  saving.value = true;
  try {
    const models = uniqSort(form.selected);
    const defaultModel = models.includes(form.defaultModel) ? form.defaultModel : models[0] ?? '';
    const base = { name: form.name, baseUrl: form.baseUrl, defaultModel, models, enabled: form.enabled };
    if (editingId.value) {
      const patch: Record<string, unknown> = { ...base };
      if (form.apiKey) patch.apiKey = form.apiKey;
      await api.patch(`/api/llm/providers/${editingId.value}`, patch);
    } else {
      await api.post('/api/llm/providers', { ...base, type: form.type, apiKey: form.apiKey });
    }
    showModal.value = false;
    toast.success(editingId.value ? t('llmModelsView.providerUpdated') : t('llmModelsView.providerAdded'));
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('llmModelsView.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function test(p: LlmProvider) {
  testing.value = p.id;
  try {
    const { result } = await api.post<{ result: LlmTestResult }>(`/api/llm/providers/${p.id}/test`, {});
    if (result.ok) toast.success(t('llmModelsView.testOk', { name: p.name, model: result.model, latency: result.latencyMs }));
    else toast.error(t('llmModelsView.testResultMessage', { name: p.name, message: result.message }));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('llmModelsView.testFailed'));
  } finally {
    testing.value = null;
    await load();
  }
}

async function remove(p: LlmProvider) {
  if (!confirm(t('llmModelsView.confirmDelete', { name: p.name }))) return;
  await api.del(`/api/llm/providers/${p.id}`);
  toast.success(t('llmModelsView.providerDeleted'));
  await load();
}
</script>

<template>
  <div class="topbar">
    <div>
      <h1>{{ t('llmModelsView.title') }}</h1>
      <small class="muted">{{ t('llmModelsView.subtitle') }}</small>
    </div>
    <button v-if="canWrite" class="btn primary" @click="openCreate">{{ t('llmModelsView.addProvider') }}</button>
  </div>

  <div class="card">
    <p v-if="loading" class="muted">{{ t('llmModelsView.loading') }}</p>
    <div v-else-if="providers.length === 0" class="empty">{{ t('llmModelsView.noProviders') }}</div>
    <table v-else>
      <thead>
        <tr><th>{{ t('llmModelsView.colProvider') }}</th><th>{{ t('llmModelsView.colType') }}</th><th>{{ t('llmModelsView.colDefaultModel') }}</th><th>{{ t('llmModelsView.colModels') }}</th><th>{{ t('llmModelsView.colStatus') }}</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="p in providers" :key="p.id">
          <td>
            <div style="font-weight: 600">{{ p.name }}</div>
            <small class="muted">{{ p.baseUrl || baseHint(p.type) }}</small>
          </td>
          <td><span class="badge">{{ p.type }}</span></td>
          <td><small class="muted">{{ p.defaultModel || '—' }}</small></td>
          <td><small class="muted">{{ p.models.length }}</small></td>
          <td>
            <span class="badge" :class="p.status === 'ok' ? 'online' : p.status === 'error' ? 'error' : 'unknown'">{{ p.status }}</span>
            <div v-if="p.lastError"><small class="muted">{{ p.lastError }}</small></div>
          </td>
          <td>
            <div class="btn-row">
              <button class="btn" :disabled="testing === p.id" @click="test(p)">{{ testing === p.id ? t('llmModelsView.testing') : t('llmModelsView.test') }}</button>
              <button v-if="canWrite" class="btn" @click="openEdit(p)">{{ t('llmModelsView.edit') }}</button>
              <button v-if="canWrite" class="btn danger" @click="remove(p)">{{ t('llmModelsView.delete') }}</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal">
      <h2>{{ editingId ? t('llmModelsView.editProvider') : t('llmModelsView.addProviderTitle') }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="field"><label>{{ t('llmModelsView.name') }}</label><input v-model="form.name" :placeholder="t('llmModelsView.namePlaceholder')" /></div>
      <div class="field" v-if="!editingId">
        <label>{{ t('llmModelsView.type') }}</label>
        <select v-model="form.type" @change="onTypeChange">
          <option v-for="t in TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
      </div>
      <div class="field" v-if="!NATIVE_TYPES.includes(form.type)">
        <label>{{ t('llmModelsView.baseUrl') }}</label>
        <input v-model="form.baseUrl" :placeholder="baseHint(form.type)" />
        <small class="muted">{{ t('llmModelsView.baseUrlHint') }}</small>
      </div>
      <div class="field">
        <label>{{ editingId ? t('llmModelsView.apiKeyEditing') : t('llmModelsView.apiKey') }}</label>
        <input v-model="form.apiKey" type="password" :placeholder="form.type === 'ollama' ? t('llmModelsView.notRequired') : ''" />
      </div>

      <!-- Models multiselect -->
      <div class="field">
        <div class="row" style="justify-content: space-between; align-items: center">
          <label style="margin: 0">{{ t('llmModelsView.models') }} <small class="muted">{{ t('llmModelsView.selectedCount', { count: form.selected.length }) }}</small></label>
          <button class="btn" type="button" :disabled="discovering" @click="fetchModels">
            {{ discovering ? t('llmModelsView.fetching') : t('llmModelsView.fetchFromProvider') }}
          </button>
        </div>
        <small v-if="discoverNote" class="muted">{{ discoverNote }}</small>
        <div class="model-list">
          <label v-for="m in candidates" :key="m" class="model-opt">
            <input type="checkbox" :checked="form.selected.includes(m)" @change="toggleModel(m)" />
            <span>{{ m }}</span>
          </label>
          <p v-if="candidates.length === 0" class="muted" style="padding: 0.4rem">
            {{ t('llmModelsView.noKnownModels') }}
          </p>
        </div>
        <div class="row" style="gap: 0.4rem; margin-top: 0.4rem">
          <input v-model="customModel" :placeholder="t('llmModelsView.customModelPlaceholder')" @keydown.enter.prevent="addCustom" style="flex: 1" />
          <button class="btn" type="button" @click="addCustom">{{ t('llmModelsView.add') }}</button>
        </div>
      </div>

      <div class="field">
        <label>{{ t('llmModelsView.defaultModel') }}</label>
        <select v-model="form.defaultModel" :disabled="form.selected.length === 0">
          <option value="">{{ form.selected.length ? t('llmModelsView.firstSelected') : t('llmModelsView.selectModelsFirst') }}</option>
          <option v-for="m in form.selected" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>

      <div class="field checkbox">
        <input id="llm-enabled" v-model="form.enabled" type="checkbox" />
        <label for="llm-enabled" style="margin: 0">{{ t('llmModelsView.enabled') }}</label>
      </div>

      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="showModal = false">{{ t('llmModelsView.cancel') }}</button>
        <button class="btn primary" :disabled="saving || form.selected.length === 0" @click="save">{{ saving ? t('llmModelsView.saving') : t('llmModelsView.save') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-list {
  max-height: 200px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.model-opt {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.4rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13.5px;
}
.model-opt:hover {
  background: var(--hover);
}
.model-opt input {
  width: auto;
  margin: 0;
}
</style>
