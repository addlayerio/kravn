<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Tool, UpstreamServer } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import GroupedList, { type GroupListMeta } from '../components/GroupedList.vue';
import { serverIconId } from '../lib/server-icon';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();
const tools = ref<Tool[]>([]);
const servers = ref<Record<string, UpstreamServer>>({});
const loading = ref(true);

const serverMeta = computed<Record<string, GroupListMeta>>(() =>
  Object.fromEntries(Object.values(servers.value).map((s) => [s.id, { name: s.name, iconId: serverIconId(s) }])),
);
const toolItems = computed(() => tools.value.map((t) => ({ ...t, groupId: t.serverId })));

const playground = ref<Tool | null>(null);
const argsText = ref('{}');
const result = ref('');
const invokeError = ref('');
const invoking = ref(false);

async function load() {
  loading.value = true;
  try {
    const [t, s] = await Promise.all([
      api.get<{ tools: Tool[] }>('/api/tools'),
      api.get<{ servers: UpstreamServer[] }>('/api/servers'),
    ]);
    tools.value = t.tools;
    servers.value = Object.fromEntries(s.servers.map((x) => [x.id, x]));
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function toggle(tool: Tool) {
  await api.patch(`/api/tools/${tool.id}`, { enabled: !tool.enabled });
  toast.success(tool.enabled ? t('toolsView.toolDisabled', { name: tool.name }) : t('toolsView.toolEnabled', { name: tool.name }));
  await load();
}

function openPlayground(t: Tool) {
  playground.value = t;
  argsText.value = '{}';
  result.value = '';
  invokeError.value = '';
}

async function invoke() {
  if (!playground.value) return;
  invokeError.value = '';
  result.value = '';
  invoking.value = true;
  try {
    let args: Record<string, unknown> = {};
    if (argsText.value.trim()) args = JSON.parse(argsText.value);
    const res = await api.post<{ result: unknown }>(`/api/tools/${playground.value.id}/invoke`, { arguments: args });
    result.value = JSON.stringify(res.result, null, 2);
  } catch (e) {
    invokeError.value = e instanceof ApiError ? e.message : (e as Error).message || t('toolsView.invocationFailed');
  } finally {
    invoking.value = false;
  }
}
</script>

<template>
  <div class="topbar"><h1>{{ t('toolsView.title') }}</h1></div>

  <div class="card">
    <p v-if="loading" class="muted">{{ t('toolsView.loading') }}</p>
    <div v-else-if="tools.length === 0" class="empty">{{ t('toolsView.empty') }}</div>
    <GroupedList v-else :items="toolItems" :groups="serverMeta" :noun="t('grouped.nounTools')" :search-text="(tool) => `${tool.name} ${tool.description}`">
      <template #row="{ item: tool }">
        <div class="rl-row">
          <div class="rl-main">
            <div class="rl-name">{{ tool.name }}</div>
            <small v-if="tool.description" class="muted">{{ tool.description }}</small>
          </div>
          <span class="badge" :class="tool.enabled ? 'online' : 'disabled'">{{ tool.enabled ? t('toolsView.badgeOn') : t('toolsView.badgeOff') }}</span>
          <div class="btn-row">
            <button v-if="auth.user?.role === 'admin'" class="btn" @click="openPlayground(tool)">{{ t('toolsView.test') }}</button>
            <button v-if="auth.can('registry.write')" class="btn" @click="toggle(tool)">
              {{ tool.enabled ? t('toolsView.disable') : t('toolsView.enable') }}
            </button>
          </div>
        </div>
      </template>
    </GroupedList>
  </div>

  <div v-if="playground" class="modal-backdrop" @click.self="playground = null">
    <div class="modal">
      <h2>{{ t('toolsView.testTitle', { name: playground.name }) }}</h2>
      <p class="muted">{{ playground.description }}</p>

      <div class="field">
        <label>{{ t('toolsView.inputSchema') }}</label>
        <pre class="code">{{ JSON.stringify(playground.inputSchema, null, 2) }}</pre>
      </div>
      <div class="field">
        <label>{{ t('toolsView.argumentsJson') }}</label>
        <textarea v-model="argsText" rows="5"></textarea>
      </div>

      <div v-if="invokeError" class="alert error">{{ invokeError }}</div>
      <div v-if="result" class="field">
        <label>{{ t('toolsView.result') }}</label>
        <pre class="code">{{ result }}</pre>
      </div>

      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="playground = null">{{ t('toolsView.close') }}</button>
        <button class="btn primary" :disabled="invoking" @click="invoke">{{ invoking ? t('toolsView.running') : t('toolsView.run') }}</button>
      </div>
    </div>
  </div>
</template>
