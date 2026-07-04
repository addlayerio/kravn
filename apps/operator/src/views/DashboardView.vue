<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { UpstreamServer, Tool, McpEndpoint } from '@kravn/contracts';
import { api } from '../api/client';
import { useBootstrapStore } from '../stores/bootstrap';
import ArchitectureFlow from '../components/ArchitectureFlow.vue';

const bootstrap = useBootstrapStore();
const servers = ref<UpstreamServer[]>([]);
const tools = ref<Tool[]>([]);
const vservers = ref<McpEndpoint[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    const [s, t, v] = await Promise.all([
      api.get<{ servers: UpstreamServer[] }>('/api/servers'),
      api.get<{ tools: Tool[] }>('/api/tools'),
      api.get<{ mcpEndpoints: McpEndpoint[] }>('/api/mcp-endpoints'),
    ]);
    servers.value = s.servers;
    tools.value = t.tools;
    vservers.value = v.mcpEndpoints;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="topbar">
    <div>
      <h1>Dashboard</h1>
      <small class="muted">{{ bootstrap.info?.instanceName }} · v{{ bootstrap.info?.version }}</small>
    </div>
  </div>

  <ArchitectureFlow />

  <div class="grid cols-3">
    <RouterLink to="/servers" class="card">
      <small class="muted">MCP Servers</small>
      <div class="kpi">{{ servers.length }}</div>
      <small class="muted">{{ servers.filter((s) => s.status === 'online').length }} online</small>
    </RouterLink>
    <RouterLink to="/tools" class="card">
      <small class="muted">Tools</small>
      <div class="kpi">{{ tools.length }}</div>
    </RouterLink>
    <RouterLink to="/mcp-endpoints" class="card">
      <small class="muted">MCP Endpoints</small>
      <div class="kpi">{{ vservers.length }}</div>
    </RouterLink>
  </div>

  <div class="card">
    <h3>Server status</h3>
    <p v-if="loading" class="muted">Loading…</p>
    <div v-else-if="servers.length === 0" class="empty">
      No upstream servers yet. <RouterLink to="/servers">Add your first one →</RouterLink>
    </div>
    <table v-else>
      <thead>
        <tr><th>Name</th><th>Transport</th><th>Status</th><th>Last error</th></tr>
      </thead>
      <tbody>
        <tr v-for="s in servers" :key="s.id">
          <td>{{ s.name }}</td>
          <td><small class="muted">{{ s.transport }}</small></td>
          <td><span class="badge" :class="s.status">{{ s.status }}</span></td>
          <td><small class="muted">{{ s.lastError || '—' }}</small></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
