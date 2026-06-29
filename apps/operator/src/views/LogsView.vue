<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from 'vue';
import { getToken } from '../api/client';

interface LogEntry {
  ts: string;
  level: string;
  msg: string;
  context?: Record<string, unknown>;
}

const logs = ref<LogEntry[]>([]);
const connected = ref(false);
const autoscroll = ref(true);
const filter = ref('');
let source: EventSource | null = null;
const container = ref<HTMLElement | null>(null);

function matches(e: LogEntry): boolean {
  if (!filter.value) return true;
  const q = filter.value.toLowerCase();
  return e.msg.toLowerCase().includes(q) || e.level.toLowerCase().includes(q);
}

async function scrollToBottom() {
  if (!autoscroll.value) return;
  await nextTick();
  if (container.value) container.value.scrollTop = container.value.scrollHeight;
}

onMounted(() => {
  const token = getToken();
  source = new EventSource(`/api/logs/stream?token=${encodeURIComponent(token ?? '')}`);
  source.onopen = () => (connected.value = true);
  source.onerror = () => (connected.value = false);
  source.onmessage = (ev) => {
    try {
      const entry = JSON.parse(ev.data) as LogEntry;
      if (entry && entry.msg) {
        logs.value.push(entry);
        if (logs.value.length > 1000) logs.value.shift();
        void scrollToBottom();
      }
    } catch {
      /* keepalive or non-JSON */
    }
  };
});

onBeforeUnmount(() => {
  source?.close();
});
</script>

<template>
  <div class="topbar">
    <h1>Logs</h1>
    <span class="badge" :class="connected ? 'online' : 'offline'">{{ connected ? 'live' : 'disconnected' }}</span>
  </div>

  <div class="card">
    <div class="row spread" style="margin-bottom: 0.75rem">
      <input v-model="filter" placeholder="Filter…" style="max-width: 280px" />
      <label class="checkbox"><input v-model="autoscroll" type="checkbox" /> Auto-scroll</label>
    </div>
    <div ref="container" style="max-height: 60vh; overflow: auto">
      <div v-if="logs.length === 0" class="empty">Waiting for activity…</div>
      <div v-for="(e, i) in logs.filter(matches)" :key="i" class="log-line">
        <span class="muted">{{ new Date(e.ts).toLocaleTimeString() }}</span>
        <span class="lvl" :class="e.level">{{ e.level.toUpperCase() }}</span>
        {{ e.msg }}
      </div>
    </div>
  </div>
</template>
