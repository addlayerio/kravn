<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { use } from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import VChart from 'vue-echarts';
import type { PlatformOverview } from '@kravn/contracts';
import { api } from '../api/client';
import { useThemeStore } from '../stores/theme';

use([GraphChart, TooltipComponent, CanvasRenderer]);

const theme = useThemeStore();
const data = ref<PlatformOverview | null>(null);
const loading = ref(true);
const error = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.get<PlatformOverview>('/api/overview');
  } catch (e) {
    error.value = (e as Error).message || 'Failed to load overview.';
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

interface NodeOpts {
  title: string;
  big: string;
  sub: string;
  color: string;
  w?: number;
  h?: number;
  fill?: string;
  tip?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const option = computed((): any => {
  const d = data.value;
  if (!d) return {};
  // Reference theme.dark so the option recomputes (and re-reads CSS vars) when the theme toggles.
  void theme.dark;
  const text = cssVar('--text', '#e8e6e1');
  const muted = cssVar('--text-muted', '#a8aeb6');
  const surface = cssVar('--bg-surface-elev', '#181b23');
  const border = cssVar('--border-strong', 'rgba(255,255,255,0.16)');
  const accent = cssVar('--accent', '#e8b36f');
  const success = cssVar('--success', '#4ade80');
  const danger = cssVar('--danger', '#f87171');
  const info = '#5b8def';
  const violet = '#8b7cf6';

  const node = (id: string, x: number, y: number, o: NodeOpts) => {
    const w = o.w ?? 156;
    const h = o.h ?? 66;
    return {
      id,
      name: o.title,
      x,
      y,
      fixed: true,
      symbol: 'roundRect',
      symbolSize: [w, h],
      itemStyle: { color: o.fill ?? surface, borderColor: o.color, borderWidth: 2 },
      tip: o.tip ?? '',
      label: {
        show: true,
        position: 'inside',
        formatter: () => `{t|${o.title}}\n{b|${o.big}}\n{s|${o.sub}}`,
        rich: {
          t: { fontSize: 12, fontWeight: 600, color: muted, lineHeight: 19, padding: [4, 0, 0, 0] },
          b: { fontSize: 22, fontWeight: 800, color: o.color, lineHeight: 30 },
          s: { fontSize: 11, color: muted, lineHeight: 16, padding: [0, 0, 4, 0] },
        },
      },
    };
  };

  const topHooks = d.plugins.byHook
    .slice(0, 3)
    .map((h) => `${h.hook}:${h.count}`)
    .join('  ');
  const allHooks = d.plugins.byHook.map((h) => `${h.hook}: ${h.count}`).join('\n') || 'no hook plugins';

  // Coordinates in a ~900×440 virtual space (3 columns). ECharts fits this box to the canvas.
  const nodes = [
    node('vservers', 90, 210, {
      title: 'Virtual Servers',
      big: `${d.virtualServers.active}/${d.virtualServers.total}`,
      sub: 'active',
      color: info,
      tip: `Virtual servers\nActive: ${d.virtualServers.active} of ${d.virtualServers.total}`,
    }),
    node('gateway', 430, 175, {
      title: d.instanceName || 'Kravn',
      big: `${d.plugins.enabled}/${d.plugins.total} plugins`,
      sub: topHooks || `v${d.version}`,
      color: violet,
      fill: cssVar('--accent-bg', 'rgba(139,124,246,0.14)'),
      w: 240,
      h: 118,
      tip: `Gateway middleware (plugins)\nEnabled: ${d.plugins.enabled} of ${d.plugins.total}\n\nHook points:\n${allHooks}`,
    }),
    node('database', 430, 380, {
      title: 'Database',
      big: d.database.kind,
      sub: d.database.connected ? 'connected' : 'disconnected',
      color: d.database.connected ? success : danger,
      w: 170,
      h: 62,
      tip: `Infrastructure\nEngine: ${d.database.kind}\nStatus: ${d.database.connected ? 'connected' : 'disconnected'}`,
    }),
    node('servers', 810, 50, {
      title: 'MCP Servers',
      big: `${d.servers.online}/${d.servers.total}`,
      sub: 'online',
      color: success,
      tip: `Upstream MCP servers\nOnline: ${d.servers.online} of ${d.servers.total}`,
    }),
    node('tools', 810, 160, {
      title: 'Tools',
      big: `${d.tools.enabled}/${d.tools.total}`,
      sub: 'enabled',
      color: danger,
      tip: `Tools\nEnabled: ${d.tools.enabled} of ${d.tools.total}`,
    }),
    node('prompts', 810, 270, {
      title: 'Prompts',
      big: `${d.prompts.enabled}/${d.prompts.total}`,
      sub: 'enabled',
      color: info,
      tip: `Prompts\nEnabled: ${d.prompts.enabled} of ${d.prompts.total}`,
    }),
    node('resources', 810, 380, {
      title: 'Resources',
      big: `${d.resources.enabled}/${d.resources.total}`,
      sub: 'enabled',
      color: accent,
      tip: `Resources\nEnabled: ${d.resources.enabled} of ${d.resources.total}`,
    }),
  ];

  const edge = (source: string, target: string) => ({
    source,
    target,
    lineStyle: { color: border, width: 1.5, type: 'dashed', curveness: 0 },
  });
  const links = [
    edge('vservers', 'gateway'),
    edge('gateway', 'servers'),
    edge('gateway', 'tools'),
    edge('gateway', 'prompts'),
    edge('gateway', 'resources'),
    edge('gateway', 'database'),
  ];

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: surface,
      borderColor: border,
      textStyle: { color: text, fontSize: 12 },
      formatter: (p: { dataType?: string; data?: { tip?: string }; name?: string }) =>
        p.dataType === 'node' ? (p.data?.tip || p.name || '').replace(/\n/g, '<br/>') : '',
    },
    series: [
      {
        type: 'graph',
        layout: 'none',
        roam: false,
        nodeScaleRatio: 0,
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: 9,
        emphasis: { scale: false, focus: 'adjacency', lineStyle: { width: 2.5 } },
        data: nodes,
        links,
      },
    ],
  };
});
</script>

<template>
  <div class="card arch-flow">
    <div class="arch-head">
      <h3>Architecture Flow</h3>
      <button class="btn-ghost" :disabled="loading" title="Refresh" @click="load">↻</button>
    </div>

    <p v-if="error" class="empty">{{ error }}</p>
    <p v-else-if="loading && !data" class="muted">Loading…</p>

    <template v-else>
      <div class="arch-cols">
        <span>INPUTS</span>
        <span>GATEWAY</span>
        <span>OUTPUTS</span>
      </div>
      <VChart class="arch-chart" :option="option" autoresize />
    </template>
  </div>
</template>

<style scoped>
.arch-flow {
  padding-bottom: 0.5rem;
}
.arch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.arch-head h3 {
  margin: 0;
}
.btn-ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  border-radius: 6px;
  width: 28px;
  height: 28px;
  cursor: pointer;
  font-size: 14px;
}
.btn-ghost:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.arch-cols {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  margin-top: 0.5rem;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}
.arch-cols span {
  text-align: center;
}
.arch-chart {
  width: 100%;
  height: 440px;
}
</style>
