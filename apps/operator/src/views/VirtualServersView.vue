<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { VirtualServer } from '@kravn/contracts';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import { copyText } from '../lib/clipboard';

const auth = useAuthStore();
const toast = useToastStore();
const router = useRouter();
const vservers = ref<VirtualServer[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    vservers.value = (await api.get<{ virtualServers: VirtualServer[] }>('/api/virtual-servers')).virtualServers;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openCreate() {
  router.push('/virtual-servers/new');
}
function openEdit(v: VirtualServer) {
  router.push(`/virtual-servers/${v.id}`);
}
async function remove(v: VirtualServer) {
  if (!confirm(`Delete MCP endpoint "${v.name}"?`)) return;
  await api.del(`/api/virtual-servers/${v.id}`);
  toast.success('MCP endpoint deleted.');
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
    <h1>MCP Endpoints</h1>
    <button v-if="auth.can('virtualservers.write')" class="btn primary" @click="openCreate">+ New MCP endpoint</button>
  </div>

  <p class="muted" style="margin-top: -0.5rem">
    Compose tools, resources and prompts from multiple upstreams into a single MCP endpoint — each with its
    own access policy and its own pipeline.
  </p>

  <div class="card">
    <p v-if="loading" class="muted">Loading…</p>
    <div v-else-if="vservers.length === 0" class="empty">No MCP endpoints yet.</div>
    <table v-else>
      <thead>
        <tr><th>Name</th><th>Contents</th><th>MCP endpoint</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="v in vservers" :key="v.id">
          <td>
            <div style="font-weight: 600; cursor: pointer" @click="openEdit(v)">{{ v.name }}</div>
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
</template>
