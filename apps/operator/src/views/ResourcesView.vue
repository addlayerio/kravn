<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Resource, UpstreamServer } from '@kravn/contracts';
import { api } from '../api/client';
import GroupedList, { type GroupListMeta } from '../components/GroupedList.vue';
import { serverIconId } from '../lib/server-icon';

const { t } = useI18n();
const resources = ref<Resource[]>([]);
const servers = ref<Record<string, UpstreamServer>>({});
const loading = ref(true);

const serverMeta = computed<Record<string, GroupListMeta>>(() =>
  Object.fromEntries(Object.values(servers.value).map((s) => [s.id, { name: s.name, iconId: serverIconId(s) }])),
);
const resourceItems = computed(() => resources.value.map((r) => ({ ...r, groupId: r.serverId })));

onMounted(async () => {
  try {
    const [r, s] = await Promise.all([
      api.get<{ resources: Resource[] }>('/api/resources'),
      api.get<{ servers: UpstreamServer[] }>('/api/servers').catch(() => ({ servers: [] as UpstreamServer[] })),
    ]);
    resources.value = r.resources;
    servers.value = Object.fromEntries(s.servers.map((x) => [x.id, x]));
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="topbar"><h1>{{ t('resourcesView.title') }}</h1></div>
  <div class="card">
    <p v-if="loading" class="muted">{{ t('resourcesView.loading') }}</p>
    <div v-else-if="resources.length === 0" class="empty">{{ t('resourcesView.empty') }}</div>
    <GroupedList
      v-else
      :items="resourceItems"
      :groups="serverMeta"
      :noun="t('grouped.nounResources')"
      :search-text="(r) => `${r.uri} ${r.name} ${r.mimeType} ${r.description}`"
    >
      <template #row="{ item: r }">
        <div class="rl-main">
          <div class="rl-mono">{{ r.uri }}</div>
          <small class="muted">
            <template v-if="r.name">{{ r.name }} · </template>{{ r.mimeType || '—' }}<template v-if="r.description"> · {{ r.description }}</template>
          </small>
        </div>
      </template>
    </GroupedList>
  </div>
</template>
