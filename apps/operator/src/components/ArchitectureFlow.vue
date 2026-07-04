<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { PlatformOverview } from '@kravn/contracts';
import { api } from '../api/client';
import { useThemeStore } from '../stores/theme';

/* ─────────────────────────────────────────────────────────────────────────
 * Hand-built architecture diagram (no charting lib).
 *
 * Robust responsive alignment technique:
 *   • A fixed VIRTUAL coordinate space of VW×VH units (1000×560).
 *   • The stage is aspect-locked to that ratio, so the virtual space maps to
 *     the on-screen box uniformly on BOTH axes.
 *   • Each node card is positioned absolutely with left/top expressed as a
 *     PERCENTAGE of that space and centered on its anchor via translate(-50%,-50%).
 *   • The SVG connector layer uses the SAME space (viewBox "0 0 1000 560")
 *     with preserveAspectRatio="none", so an (x,y) in virtual units maps to
 *     the identical on-screen point as a card anchored at the same (x,y).
 *   • Strokes use vector-effect="non-scaling-stroke" so line weight stays crisp
 *     and constant regardless of the (uniform) scale.
 * Result: connectors stay glued to card edges at any container width — no drift,
 * no ResizeObserver, no measure flash, no stale-viewBox failure mode.
 * ──────────────────────────────────────────────────────────────────────── */

const VW = 1000;
const VH = 560;

/* Column x-anchors in virtual units — single source of truth shared by the
 * cards AND the translucent rails, so the rails can never disagree with the
 * card centres. */
const COL_X = { input: 130, gateway: 500, output: 858 } as const;
/* Rail band half-widths (virtual units) around each column anchor. */
const RAIL_HALF = { input: 118, gateway: 165, output: 145 } as const;

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

/* Category accent hues (fixed — used only for borders / icons / edges).
 * Card background + text always come from theme CSS vars, so both themes work. */
const HUE = {
  blue: '#5b8def',
  violet: '#8b7cf6',
  green: '#3fb37f',
  red: '#e5705a',
  amber: '#d99a3a',
} as const;
type Hue = keyof typeof HUE;

/* Multi-stroke inline icon registry (richer than terse single glyphs).
 * Each entry is an array of path "d" strings, bound via :d — never v-html. */
const ICONS = {
  server: ['M3 4.5h18v6H3z', 'M3 13.5h18v6H3z', 'M6.5 7.5h.01', 'M6.5 16.5h.01'],
  gate: ['M12 2.5 4 6v6c0 4.4 3.2 7.6 8 9 4.8-1.4 8-4.6 8-9V6z', 'M9 12l2 2 4-4.5'],
  db: [
    'M12 2.5c4.4 0 7 1.4 7 3s-2.6 3-7 3-7-1.4-7-3 2.6-3 7-3z',
    'M5 5.5v13c0 1.6 2.6 3 7 3s7-1.4 7-3v-13',
    'M5 12c0 1.6 2.6 3 7 3s7-1.4 7-3',
  ],
  cloud: ['M7 18.5a4.2 4.2 0 0 1 .4-8.4 5.6 5.6 0 0 1 10.8 1.5A3.7 3.7 0 0 1 17.5 18.5z'],
  tool: [
    'M14.8 6.2a4 4 0 0 0-5.4 5.2L3.8 17l3.2 3.2 5.6-5.6a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.5-.5-2.4z',
  ],
  prompt: ['M4 5h16v10H8l-4 4z', 'M8 9h8', 'M8 12h5'],
  doc: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 13h6', 'M9 16.5h6'],
} as const;
type IconName = keyof typeof ICONS;

interface NodeModel {
  id: string;
  /** anchor centre + box width, in virtual units */
  cx: number;
  cy: number;
  w: number;
  hue: Hue;
  icon: IconName;
  title: string;
  /** big metric value */
  value: string;
  /** secondary unit / status label */
  unit: string;
  /** ok: true=healthy dot, false=danger dot, null=no dot (binary not meaningful) */
  ok: boolean | null;
  /** smaller metric font (for long text values like the db engine name) */
  textMetric?: boolean;
  tip: string;
}

const nodes = computed<NodeModel[]>(() => {
  const d = data.value;
  if (!d) return [];

  const dbOk = d.database.connected;

  return [
    {
      id: 'vservers',
      cx: COL_X.input,
      cy: 280,
      w: 196,
      hue: 'blue',
      icon: 'server',
      title: 'MCP Endpoints',
      value: `${d.mcpEndpoints.active}`,
      unit: `/ ${d.mcpEndpoints.total} active`,
      ok: d.mcpEndpoints.active > 0 ? true : null,
      tip:
        `MCP Endpoints (inputs)\n` +
        `Active: ${d.mcpEndpoints.active} of ${d.mcpEndpoints.total}`,
    },
    {
      id: 'gateway',
      cx: COL_X.gateway,
      cy: 212,
      w: 288,
      hue: 'violet',
      icon: 'gate',
      title: d.instanceName || 'Kravn',
      value: `${d.plugins.enabled}`,
      unit: `/ ${d.plugins.total} plugins enabled`,
      ok: null,
      tip:
        `Gateway middleware — v${d.version}\n` +
        `Plugins enabled: ${d.plugins.enabled} of ${d.plugins.total}\n\n` +
        `Hook breakdown:\n` +
        (d.plugins.byHook.length
          ? d.plugins.byHook.map((h) => `  • ${h.hook}: ${h.count}`).join('\n')
          : '  • no hook plugins'),
    },
    {
      id: 'database',
      cx: COL_X.gateway,
      cy: 452,
      w: 236,
      hue: dbOk ? 'green' : 'red',
      icon: 'db',
      title: 'Database',
      value: d.database.kind,
      unit: dbOk ? 'connected' : 'disconnected',
      ok: dbOk,
      textMetric: true,
      tip:
        `Infrastructure\n` +
        `Engine: ${d.database.kind}\n` +
        `Status: ${dbOk ? 'connected' : 'disconnected'}`,
    },
    {
      id: 'servers',
      cx: COL_X.output,
      cy: 95,
      w: 228,
      hue: 'green',
      icon: 'cloud',
      title: 'MCP Servers',
      value: `${d.servers.online}`,
      unit: `/ ${d.servers.total} online`,
      ok: d.servers.total === 0 ? null : d.servers.online === d.servers.total,
      tip: `Upstream MCP servers\nOnline: ${d.servers.online} of ${d.servers.total}`,
    },
    {
      id: 'tools',
      cx: COL_X.output,
      cy: 215,
      w: 228,
      hue: 'red',
      icon: 'tool',
      title: 'Tools',
      value: `${d.tools.enabled}`,
      unit: `/ ${d.tools.total} enabled`,
      ok: null,
      tip: `Tools\nEnabled: ${d.tools.enabled} of ${d.tools.total}`,
    },
    {
      id: 'prompts',
      cx: COL_X.output,
      cy: 335,
      w: 228,
      hue: 'blue',
      icon: 'prompt',
      title: 'Prompts',
      value: `${d.prompts.enabled}`,
      unit: `/ ${d.prompts.total} enabled`,
      ok: null,
      tip: `Prompts\nEnabled: ${d.prompts.enabled} of ${d.prompts.total}`,
    },
    {
      id: 'resources',
      cx: COL_X.output,
      cy: 455,
      w: 228,
      hue: 'amber',
      icon: 'doc',
      title: 'Resources',
      value: `${d.resources.enabled}`,
      unit: `/ ${d.resources.total} enabled`,
      ok: null,
      tip: `Resources\nEnabled: ${d.resources.enabled} of ${d.resources.total}`,
    },
  ];
});

/* ── Gateway plugins meter (P1 graft) ─────────────────────────────────────── */
const pluginPct = computed(() => {
  const p = data.value?.plugins;
  if (!p || p.total === 0) return 0;
  return Math.round((p.enabled / p.total) * 100);
});

/** First few hook pills shown directly on the gateway card (clamped to 1 row). */
const gatewayHooks = computed(() => {
  const d = data.value;
  if (!d) return [];
  return d.plugins.byHook.slice(0, 3);
});
const gatewayHooksMore = computed(() => {
  const d = data.value;
  if (!d) return 0;
  return Math.max(0, d.plugins.byHook.length - gatewayHooks.value.length);
});

interface EdgeModel {
  id: string;
  d: string;
  hue: Hue;
}

/** Horizontal-flow cubic bezier between two anchor points (in virtual units). */
function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

const edges = computed<EdgeModel[]>(() => {
  const map = new Map(nodes.value.map((n) => [n.id, n] as const));
  const get = (id: string): NodeModel | undefined => map.get(id);

  /** edge from source's right-edge anchor → target's left-edge anchor */
  function rightToLeft(sid: string, tid: string): string | null {
    const s = get(sid);
    const t = get(tid);
    if (!s || !t) return null;
    return bezier(s.cx + s.w / 2, s.cy, t.cx - t.w / 2, t.cy);
  }
  /** vertical edge from the gateway band down to the database card */
  function gatewayToDb(): string | null {
    const s = get('gateway');
    const t = get('database');
    if (!s || !t) return null;
    /* The gateway and database boxes never overlap; anchor on the virtual gap
     * between their bands so the curve is stable regardless of card height. */
    const x = s.cx;
    const y1 = 308;
    const y2 = t.cy - 58;
    const dy = Math.max(24, (y2 - y1) * 0.5);
    return `M ${x} ${y1} C ${x} ${y1 + dy}, ${x} ${y2 - dy}, ${x} ${y2}`;
  }

  const defs: { id: string; d: string | null; hue: Hue }[] = [
    { id: 'vservers-gateway', d: rightToLeft('vservers', 'gateway'), hue: 'blue' },
    { id: 'gateway-servers', d: rightToLeft('gateway', 'servers'), hue: 'green' },
    { id: 'gateway-tools', d: rightToLeft('gateway', 'tools'), hue: 'red' },
    { id: 'gateway-prompts', d: rightToLeft('gateway', 'prompts'), hue: 'blue' },
    { id: 'gateway-resources', d: rightToLeft('gateway', 'resources'), hue: 'amber' },
    { id: 'gateway-database', d: gatewayToDb(), hue: get('database')?.hue ?? 'green' },
  ];

  return defs
    .filter((x): x is { id: string; d: string; hue: Hue } => x.d !== null)
    .map((x) => ({ id: x.id, d: x.d, hue: x.hue }));
});

/* Edge stroke colour resolves the category hue, but the gateway→database edge
 * follows the live success/danger theme colour. Re-reads on theme toggle. */
const edgeColor = computed(() => {
  void theme.dark; // dependency so colours refresh when the theme flips
  return (e: EdgeModel): string => {
    if (e.id === 'gateway-database') {
      return data.value?.database.connected ? 'var(--success)' : 'var(--danger)';
    }
    return HUE[e.hue];
  };
});

/* ── Column rails derived from COL_X / RAIL_HALF (no hardcoded % split) ────── */
interface RailModel {
  key: string;
  label: string;
  left: string;
  width: string;
  tint: string;
}
function rail(key: keyof typeof COL_X, label: string, hue: string): RailModel {
  const half = RAIL_HALF[key];
  return {
    key,
    label,
    left: pct(COL_X[key] - half, VW),
    width: pct(half * 2, VW),
    tint: hue,
  };
}
const rails = computed<RailModel[]>(() => [
  rail('input', 'Inputs', HUE.blue),
  rail('gateway', 'Gateway', HUE.violet),
  rail('output', 'Outputs', HUE.green),
]);

function pct(v: number, total: number): string {
  return `${(v / total) * 100}%`;
}
</script>

<template>
  <div class="card arch-flow">
    <div class="arch-head">
      <div class="arch-title">
        <span class="arch-dot" aria-hidden="true"></span>
        <h3>Architecture Flow</h3>
        <small v-if="data" class="muted">{{ data.instanceName }} · v{{ data.version }}</small>
      </div>
      <button
        class="arch-refresh"
        :disabled="loading"
        title="Refresh"
        aria-label="Refresh"
        @click="load"
      >
        <svg viewBox="0 0 20 20" width="15" height="15" :class="{ spin: loading }" aria-hidden="true">
          <path
            d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5V6.5H13"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <p v-if="error" class="empty">{{ error }}</p>
    <p v-else-if="loading && !data" class="muted arch-loading">Loading platform topology…</p>

    <div v-else-if="data" class="arch-stage">
      <!-- Translucent column rails (backdrop), aligned to the same virtual x-anchors -->
      <div class="rails" aria-hidden="true">
        <div
          v-for="r in rails"
          :key="r.key"
          class="rail"
          :style="{ left: r.left, width: r.width, ['--tint']: r.tint }"
        >
          <span class="rail-chip">{{ r.label }}</span>
        </div>
      </div>

      <!-- Connector layer: same virtual space as the cards -->
      <svg
        class="arch-edges"
        :viewBox="`0 0 ${VW} ${VH}`"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          v-for="e in edges"
          :key="e.id"
          :d="e.d"
          class="edge"
          :stroke="edgeColor(e)"
        />
      </svg>

      <!-- Node cards: absolutely positioned by percentage anchors -->
      <div
        v-for="n in nodes"
        :key="n.id"
        class="node"
        :class="[`node-${n.id}`, { 'node-gateway': n.id === 'gateway' }]"
        :style="{
          left: pct(n.cx, VW),
          top: pct(n.cy, VH),
          width: pct(n.w, VW),
          ['--hue']: HUE[n.hue],
        }"
        :title="n.tip"
      >
        <div class="node-head">
          <span class="node-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                v-for="(p, i) in ICONS[n.icon]"
                :key="i"
                :d="p"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
            </svg>
          </span>
          <span class="node-name">{{ n.title }}</span>
          <span v-if="n.id === 'gateway' && data" class="node-ver">v{{ data.version }}</span>
          <span
            v-else-if="n.ok !== null"
            class="node-dot"
            :class="{ off: !n.ok }"
            aria-hidden="true"
          ></span>
        </div>

        <div class="node-body">
          <span class="node-value" :class="{ 'node-value-sm': n.textMetric }">{{ n.value }}</span>
          <span class="node-unit">{{ n.unit }}</span>
        </div>

        <!-- Gateway-only: plugins meter + hook breakdown pills -->
        <template v-if="n.id === 'gateway'">
          <div class="gw-meter">
            <div class="gw-meter-top">
              <span class="gw-pct">{{ pluginPct }}%</span>
              <span class="gw-meter-label">enabled</span>
            </div>
            <div class="gw-track">
              <div class="gw-fill" :style="{ width: pluginPct + '%' }"></div>
            </div>
          </div>

          <div class="node-pills">
            <span
              v-for="h in gatewayHooks"
              :key="h.hook"
              class="pill"
              :title="`${h.hook}: ${h.count}`"
            >
              {{ h.hook }}<b>{{ h.count }}</b>
            </span>
            <span v-if="gatewayHooksMore > 0" class="pill pill-more">+{{ gatewayHooksMore }}</span>
            <span v-if="gatewayHooks.length === 0" class="pill pill-empty">no hooks</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.arch-flow {
  padding-bottom: 18px;
}
.arch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.arch-title {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.arch-title h3 {
  margin: 0;
}
.arch-title small {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11.5px;
}
.arch-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
}
.arch-refresh {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}
.arch-refresh:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
  background: var(--hover);
}
.arch-refresh:disabled {
  opacity: 0.5;
  cursor: progress;
}
.arch-refresh .spin {
  animation: arch-spin 0.85s linear infinite;
  transform-origin: 50% 50%;
}
@keyframes arch-spin {
  to {
    transform: rotate(360deg);
  }
}

.arch-loading {
  padding: 3rem 0;
  text-align: center;
}

/* The stage: fixed aspect ratio defines on-screen height; width is fluid. */
.arch-stage {
  position: relative;
  width: 100%;
  /* virtual 1000×560 → keep the same ratio so anchors map perfectly */
  aspect-ratio: 1000 / 560;
  max-height: 520px;
  min-height: 400px;
  margin-top: 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background-color: var(--bg-page);
  /* subtle dotted blueprint grid (1px dots stay visible in both themes) */
  background-image: radial-gradient(
    circle at center,
    var(--border-strong) 1px,
    transparent 1.4px
  );
  background-size: 22px 22px;
  background-position: 11px 11px;
  overflow: hidden;
}

/* Column rails: translucent bands behind the cards. */
.rails {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}
.rail {
  position: absolute;
  top: 14px;
  bottom: 14px;
  border-radius: var(--radius-md);
  border: 1px dashed color-mix(in srgb, var(--tint) 26%, var(--border));
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--tint) 7%, transparent),
    color-mix(in srgb, var(--tint) 2%, transparent)
  );
}
.rail-chip {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-faint);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 2px 11px;
  white-space: nowrap;
}

/* Connector layer fills the stage and shares its coordinate space. */
.arch-edges {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
  z-index: 1;
}
.edge {
  fill: none;
  stroke-width: 1.6;
  stroke-dasharray: 5 6;
  stroke-linecap: round;
  opacity: 0.85;
  vector-effect: non-scaling-stroke;
}
/* Subtle "live flow" — only when the user hasn't asked for reduced motion. */
@media (prefers-reduced-motion: no-preference) {
  .edge {
    animation: dash-flow 1.6s linear infinite;
  }
}
@keyframes dash-flow {
  to {
    stroke-dashoffset: -22;
  }
}

/* Node card */
.node {
  position: absolute;
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  padding: 11px 13px 12px;
  border-radius: 10px;
  background: var(--bg-surface-elev);
  border: 1px solid var(--border-strong);
  border-top: 2px solid var(--hue);
  box-shadow: var(--shadow);
  cursor: default;
  z-index: 2;
  transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
}
.node:hover {
  transform: translate(-50%, -50%) translateY(-1px);
  box-shadow: var(--shadow-lg);
  border-color: var(--hue);
  z-index: 4;
}

.node-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.node-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 7px;
  color: var(--hue);
  background: color-mix(in srgb, var(--hue) 16%, transparent);
}
.node-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.node-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-bg);
}
.node-dot.off {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-bg);
}
.node-ver {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  color: var(--text-faint);
  background: var(--hover);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 1px 7px;
}

.node-body {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin-top: 9px;
}
.node-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--hue);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
/* Long text metrics (e.g. database engine name) read cleaner at a smaller size. */
.node-value-sm {
  font-size: 17px;
  font-weight: 600;
  font-family: var(--font-mono);
}
.node-unit {
  font-size: 11.5px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Gateway: the visual focal point ──────────────────────────────────────── */
.node-gateway {
  border-top-width: 3px;
  z-index: 3;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--hue) 8%, var(--bg-surface-elev)),
    var(--bg-surface-elev)
  );
  box-shadow: var(--shadow-lg);
}
.gw-meter {
  margin-top: 11px;
}
.gw-meter-top {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.gw-pct {
  font-size: 13px;
  font-weight: 700;
  color: var(--hue);
}
.gw-meter-label {
  font-size: 10.5px;
  color: var(--text-faint);
}
.gw-track {
  margin-top: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--hover-strong);
  overflow: hidden;
}
.gw-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  background: linear-gradient(90deg, var(--hue), #5b8def);
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Gateway hook pills (clamped to a single row + overflow chip) */
.node-pills {
  display: flex;
  flex-wrap: nowrap;
  gap: 5px;
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-strong);
  overflow: hidden;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 500;
  font-family: var(--font-mono);
  color: var(--text-muted);
  background: var(--hover);
  border: 1px solid var(--border);
  white-space: nowrap;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pill b {
  font-weight: 700;
  color: var(--hue);
}
.pill-more {
  color: var(--text-faint);
}
.pill-empty {
  font-style: italic;
  font-family: var(--font-sans);
  color: var(--text-faint);
}

@media (prefers-reduced-motion: reduce) {
  .gw-fill,
  .node {
    transition: none;
  }
  .arch-refresh .spin {
    animation: none;
  }
}

/* On narrow widths shrink the typography a touch so cards don't clip. */
@media (max-width: 720px) {
  .node {
    padding: 8px 10px 9px;
  }
  .node-value {
    font-size: 21px;
  }
  .node-value-sm {
    font-size: 14px;
  }
  .node-name {
    font-size: 11.5px;
  }
  .arch-stage {
    min-height: 360px;
  }
  .rail-chip {
    font-size: 9px;
    padding: 2px 8px;
  }
}
</style>
