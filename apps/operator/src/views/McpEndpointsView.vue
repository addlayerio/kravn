<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { McpEndpoint } from '@kravn/contracts';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import { copyText } from '../lib/clipboard';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();
const router = useRouter();
const vservers = ref<McpEndpoint[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    vservers.value = (await api.get<{ mcpEndpoints: McpEndpoint[] }>('/api/mcp-endpoints')).mcpEndpoints;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openCreate() {
  router.push('/mcp-endpoints/new');
}
function openEdit(v: McpEndpoint) {
  router.push(`/mcp-endpoints/${v.id}`);
}
async function remove(v: McpEndpoint) {
  if (!confirm(t('endpointsView.confirmDelete', { name: v.name }))) return;
  await api.del(`/api/mcp-endpoints/${v.id}`);
  toast.success(t('endpointsView.deleted'));
  await load();
}

function endpoint(slug: string): string {
  return `${location.origin}/endpoints/${slug}/mcp`;
}
async function copyUrl(slug: string): Promise<void> {
  const ok = await copyText(endpoint(slug));
  if (ok) toast.success(t('endpointsView.urlCopied'));
  else toast.error(t('endpointsView.copyFailed', { url: endpoint(slug) }));
}
</script>

<template>
  <div class="topbar">
    <h1>{{ t('endpointsView.title') }}</h1>
    <button v-if="auth.can('endpoints.write')" class="btn primary" @click="openCreate">{{ t('endpointsView.newEndpoint') }}</button>
  </div>

  <p class="muted" style="margin-top: -0.5rem">
    {{ t('endpointsView.subtitle') }}
  </p>

  <div class="card">
    <p v-if="loading" class="muted">{{ t('endpointsView.loading') }}</p>
    <div v-else-if="vservers.length === 0" class="empty">{{ t('endpointsView.empty') }}</div>
    <table v-else>
      <thead>
        <tr><th>{{ t('endpointsView.colName') }}</th><th>{{ t('endpointsView.colContents') }}</th><th>{{ t('endpointsView.colEndpoint') }}</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="v in vservers" :key="v.id">
          <td>
            <div style="font-weight: 600; cursor: pointer" @click="openEdit(v)">{{ v.name }}</div>
            <small class="muted">{{ v.description }}</small>
          </td>
          <td>
            <small class="muted">{{ t('endpointsView.contentsSummary', { tools: v.toolIds.length, resources: v.resourceIds.length, prompts: v.promptIds.length }) }}</small>
            <div><span class="badge" style="margin-top: 0.25rem">{{ v.access }}</span></div>
          </td>
          <td><small style="font-family: ui-monospace, monospace">/endpoints/{{ v.slug }}/mcp</small></td>
          <td>
            <div class="btn-row">
              <button class="btn" @click="copyUrl(v.slug)">{{ t('endpointsView.copyUrl') }}</button>
              <button v-if="auth.can('endpoints.write')" class="btn" @click="openEdit(v)">{{ t('endpointsView.edit') }}</button>
              <button v-if="auth.can('endpoints.delete')" class="btn danger" @click="remove(v)">{{ t('endpointsView.delete') }}</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
