<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api/client';
import { useI18n } from 'vue-i18n';
import { RefreshCw, Waypoints } from 'lucide-vue-next';
import type { AgentCard, A2aTaskSummary } from '@kravn/contracts';

const { t } = useI18n();

const loading = ref(true);
const enabled = ref(false);
const card = ref<AgentCard | null>(null);
const tasks = ref<A2aTaskSummary[]>([]);

async function load() {
  loading.value = true;
  try {
    const [c, tk] = await Promise.all([
      api.get<{ card: AgentCard; enabled: boolean }>('/api/a2a/card'),
      api.get<{ tasks: A2aTaskSummary[] }>('/api/a2a/tasks'),
    ]);
    card.value = c.card;
    enabled.value = c.enabled;
    tasks.value = tk.tasks;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function fmt(ts: string): string {
  return ts ? ts.replace('T', ' ').slice(0, 16) : '';
}
// Terminal-failure states get a danger tint; the rest are neutral.
function stateClass(state: string): string {
  if (state === 'failed' || state === 'rejected') return 'error';
  if (state === 'completed') return 'online';
  if (state === 'canceled') return 'offline';
  return 'connecting';
}
</script>

<template>
  <div>
    <div class="topbar">
      <h1><Waypoints :size="22" :stroke-width="2" style="vertical-align: -4px; margin-right: 0.4rem" />{{ t('a2aView.title') }}</h1>
      <div class="btn-row">
        <button class="btn icon" :title="t('a2aView.refresh')" :aria-label="t('a2aView.refresh')" @click="load">
          <RefreshCw :size="16" :stroke-width="2" />
        </button>
      </div>
    </div>

    <p class="muted" style="max-width: 60rem; margin-top: -0.4rem">{{ t('a2aView.intro') }}</p>

    <!-- Server status -->
    <div class="card">
      <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap">
        <span class="badge" :class="enabled ? 'online' : 'offline'">
          {{ enabled ? t('a2aView.statusEnabled') : t('a2aView.statusDisabled') }}
        </span>
        <span v-if="card" class="muted"><code>{{ card.url }}</code></span>
        <RouterLink to="/settings" class="btn" style="margin-left: auto">{{ t('a2aView.openSettings') }}</RouterLink>
      </div>
      <p v-if="!enabled" class="muted" style="margin: 0.75rem 0 0">{{ t('a2aView.enableHint') }}</p>
      <div v-if="card" class="muted" style="margin-top: 0.75rem; font-size: 0.85rem">
        {{ t('a2aView.protocol') }} <code>{{ card.protocolVersion }}</code> ·
        {{ t('a2aView.capabilities') }}:
        <span v-if="card.capabilities.streaming">streaming</span>
        <span v-if="card.capabilities.pushNotifications"> · push</span>
        <span v-if="card.capabilities.stateTransitionHistory"> · history</span>
      </div>
    </div>

    <!-- Published skills -->
    <div class="card">
      <h2 style="margin-top: 0">{{ t('a2aView.cardTitle') }}</h2>
      <p class="muted">{{ t('a2aView.cardIntro') }}</p>
      <p v-if="loading" class="muted">{{ t('a2aView.loading') }}</p>
      <div v-else-if="!card || card.skills.length === 0" class="empty">{{ t('a2aView.noSkills') }}</div>
      <table v-else>
        <thead>
          <tr><th>{{ t('a2aView.colSkill') }}</th><th>{{ t('a2aView.colId') }}</th><th>{{ t('a2aView.colTags') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="sk in card.skills" :key="sk.id">
            <td>
              <div style="font-weight: 600">{{ sk.name }}</div>
              <small class="muted">{{ sk.description }}</small>
            </td>
            <td><small class="muted"><code>{{ sk.id }}</code></small></td>
            <td>
              <span v-for="tag in sk.tags" :key="tag" class="badge" style="margin-right: 0.25rem">{{ tag }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Recent tasks -->
    <div class="card">
      <h2 style="margin-top: 0">{{ t('a2aView.tasksTitle') }}</h2>
      <p class="muted">{{ t('a2aView.tasksIntro') }}</p>
      <p v-if="loading" class="muted">{{ t('a2aView.loading') }}</p>
      <div v-else-if="tasks.length === 0" class="empty">{{ t('a2aView.noTasks') }}</div>
      <table v-else>
        <thead>
          <tr>
            <th>{{ t('a2aView.colState') }}</th>
            <th>{{ t('a2aView.colSkillId') }}</th>
            <th>{{ t('a2aView.colActor') }}</th>
            <th>{{ t('a2aView.colCreated') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in tasks" :key="task.id">
            <td><span class="badge" :class="stateClass(task.state)">{{ task.state }}</span></td>
            <td>
              <small class="muted"><code>{{ task.skillId }}</code></small>
              <div v-if="task.error"><small class="muted" style="color: var(--danger, #c0392b)">{{ task.error }}</small></div>
            </td>
            <td><small class="muted">{{ task.actorEmail || '—' }}</small></td>
            <td><small class="muted">{{ fmt(task.createdAt) }}</small></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
