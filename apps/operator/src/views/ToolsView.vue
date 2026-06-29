<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { Tool, UpstreamServer } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

const auth = useAuthStore();
const toast = useToastStore();
const tools = ref<Tool[]>([]);
const servers = ref<Record<string, UpstreamServer>>({});
const loading = ref(true);

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

async function toggle(t: Tool) {
  await api.patch(`/api/tools/${t.id}`, { enabled: !t.enabled });
  toast.success(`Tool "${t.name}" ${t.enabled ? 'disabled' : 'enabled'}.`);
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
    invokeError.value = e instanceof ApiError ? e.message : (e as Error).message || 'Invocation failed.';
  } finally {
    invoking.value = false;
  }
}
</script>

<template>
  <div class="topbar"><h1>Tools</h1></div>

  <div class="card">
    <p v-if="loading" class="muted">Loading…</p>
    <div v-else-if="tools.length === 0" class="empty">No tools discovered yet. Add and sync a server first.</div>
    <table v-else>
      <thead>
        <tr><th>Tool</th><th>Server</th><th>Description</th><th>Enabled</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="t in tools" :key="t.id">
          <td style="font-weight: 600">{{ t.name }}</td>
          <td><small class="muted">{{ servers[t.serverId]?.name || t.serverId }}</small></td>
          <td><small class="muted">{{ t.description }}</small></td>
          <td>
            <span class="badge" :class="t.enabled ? 'online' : 'disabled'">{{ t.enabled ? 'on' : 'off' }}</span>
          </td>
          <td>
            <div class="btn-row">
              <button class="btn" @click="openPlayground(t)">Test</button>
              <button v-if="auth.can('registry.write')" class="btn" @click="toggle(t)">
                {{ t.enabled ? 'Disable' : 'Enable' }}
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="playground" class="modal-backdrop" @click.self="playground = null">
    <div class="modal">
      <h2>Test: {{ playground.name }}</h2>
      <p class="muted">{{ playground.description }}</p>

      <div class="field">
        <label>Input schema</label>
        <pre class="code">{{ JSON.stringify(playground.inputSchema, null, 2) }}</pre>
      </div>
      <div class="field">
        <label>Arguments (JSON)</label>
        <textarea v-model="argsText" rows="5"></textarea>
      </div>

      <div v-if="invokeError" class="alert error">{{ invokeError }}</div>
      <div v-if="result" class="field">
        <label>Result</label>
        <pre class="code">{{ result }}</pre>
      </div>

      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="playground = null">Close</button>
        <button class="btn primary" :disabled="invoking" @click="invoke">{{ invoking ? 'Running…' : 'Run' }}</button>
      </div>
    </div>
  </div>
</template>
