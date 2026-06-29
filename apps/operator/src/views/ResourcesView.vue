<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { Resource } from '@kravn/contracts';
import { api } from '../api/client';

const resources = ref<Resource[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    resources.value = (await api.get<{ resources: Resource[] }>('/api/resources')).resources;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="topbar"><h1>Resources</h1></div>
  <div class="card">
    <p v-if="loading" class="muted">Loading…</p>
    <div v-else-if="resources.length === 0" class="empty">No resources discovered yet.</div>
    <table v-else>
      <thead>
        <tr><th>URI</th><th>Name</th><th>MIME</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in resources" :key="r.id">
          <td style="font-family: ui-monospace, monospace; font-size: 0.82rem">{{ r.uri }}</td>
          <td>{{ r.name }}</td>
          <td><small class="muted">{{ r.mimeType || '—' }}</small></td>
          <td><small class="muted">{{ r.description }}</small></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
