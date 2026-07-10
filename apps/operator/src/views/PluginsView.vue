<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { PluginView } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import PluginConfigModal from '../components/PluginConfigModal.vue';

const auth = useAuthStore();
const toast = useToastStore();
const canWrite = auth.can('settings.write');

// The Plugins page is focused on GOVERNANCE HOOKS. mcp-server (integration) plugins live in the
// unified Catalog on the MCP Servers page, alongside the remote catalog.
const allPlugins = ref<PluginView[]>([]);
const plugins = computed(() => allPlugins.value.filter((p) => p.type === 'hook'));
const loadErrors = ref<{ source: string; error: string }[]>([]);
const loading = ref(true);

const showImport = ref(false);
const importForm = reactive({ id: '', source: '' });
const importing = ref(false);
const importError = ref('');

const showDetail = ref(false);
const detailPlugin = ref<PluginView | null>(null);
const configPlugin = ref<PluginView | null>(null);

const STARTER = `export default {
  manifest: {
    id: 'my-plugin',
    name: 'My Plugin',
    version: '0.1.0',
    type: 'hook', // or 'mcp-server'
    description: '',
    // Declare configSchema so the UI renders a config form:
    configSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', title: 'Message', default: 'hi' },
      },
    },
  },
  hooks: {
    onToolCall(ctx) {
      ctx.log(ctx.config.message || 'called ' + ctx.tool);
      // ctx.deny('nope'); // to block
    },
  },
};`;

function applyList(res: { plugins: PluginView[]; loadErrors: { source: string; error: string }[] }) {
  allPlugins.value = res.plugins;
  loadErrors.value = res.loadErrors ?? [];
}

// ─── Marketplace: search + hook-point filter ────────────────────────────────────────────────────
const search = ref('');
const filterHook = ref('all');
const tab = ref<'catalog' | 'installed'>('catalog');

const hookOptions = computed(() => {
  const s = new Set<string>();
  for (const p of plugins.value) for (const hp of p.hookPoints ?? []) s.add(hp);
  return [...s].sort();
});
const enabledCount = computed(() => plugins.value.filter((p) => p.enabled).length);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return plugins.value.filter((p) => {
    if (tab.value === 'installed' && !p.enabled) return false;
    if (filterHook.value !== 'all' && !(p.hookPoints ?? []).includes(filterHook.value)) return false;
    if (q && !`${p.name} ${p.description} ${p.author} ${p.id}`.toLowerCase().includes(q)) return false;
    return true;
  });
});
function resetFilters() {
  search.value = '';
  filterHook.value = 'all';
}

async function load() {
  loading.value = true;
  try {
    applyList(await api.get('/api/plugins'));
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function toggle(p: PluginView) {
  try {
    applyList(await api.patch(`/api/plugins/${p.id}`, { enabled: !p.enabled }));
    toast.success(`${p.name} ${p.enabled ? 'disabled' : 'enabled'}.`);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : 'Could not update plugin.');
  }
}
async function rescan() {
  applyList(await api.post('/api/plugins/rescan'));
  toast.success('Plugins re-scanned.');
}
async function remove(p: PluginView) {
  if (!confirm(`Delete plugin "${p.name}"? This removes its file from the plugins directory.`)) return;
  await api.del(`/api/plugins/${p.id}`);
  toast.success('Plugin removed.');
  await load();
}

function openImport() {
  importForm.id = '';
  importForm.source = STARTER;
  importError.value = '';
  showImport.value = true;
}
async function doImport() {
  importError.value = '';
  importing.value = true;
  try {
    await api.post('/api/plugins/import', { id: importForm.id, source: importForm.source });
    showImport.value = false;
    toast.success('Plugin imported.');
    await load();
  } catch (e) {
    importError.value = e instanceof ApiError ? e.message : 'Import failed.';
  } finally {
    importing.value = false;
  }
}

function openDetail(p: PluginView) {
  detailPlugin.value = p;
  showDetail.value = true;
}
function configFromDetail() {
  const p = detailPlugin.value;
  showDetail.value = false;
  if (p) configPlugin.value = p;
}
</script>

<template>
  <div class="topbar">
    <div>
      <h1>Plugins</h1>
      <small class="muted">Governance hooks — transform tool-call requests, results and the advertised tool list.</small>
    </div>
    <div class="btn-row">
      <button class="btn" @click="rescan">Rescan</button>
      <button v-if="canWrite" class="btn primary" @click="openImport">+ Import plugin</button>
    </div>
  </div>

  <div class="alert" style="border-color: var(--warning); background: var(--warning-bg); color: var(--warning)">
    Plugins run in-process with the gateway's privileges. Only enable plugins you trust. Looking for
    integrations (Jira, Notion, Stripe…)? They live in the <strong>Catalog</strong> on the MCP Servers page.
  </div>

  <div v-if="loadErrors.length" class="alert error">
    <strong>Some plugin files failed to load:</strong>
    <div v-for="(e, i) in loadErrors" :key="i"><code>{{ e.source }}</code>: {{ e.error }}</div>
  </div>

  <div class="seg">
    <button class="seg-btn" :class="{ active: tab === 'catalog' }" @click="tab = 'catalog'">Catalog · {{ plugins.length }}</button>
    <button class="seg-btn" :class="{ active: tab === 'installed' }" @click="tab = 'installed'">Enabled · {{ enabledCount }}</button>
  </div>

  <div class="card filter-bar">
    <input class="search" v-model="search" placeholder="Search hooks by name, description, author…" />
    <select v-model="filterHook">
      <option value="all">All hook points</option>
      <option v-for="h in hookOptions" :key="h" :value="h">{{ h }}</option>
    </select>
  </div>

  <div v-if="loading" class="card"><p class="muted">Loading…</p></div>
  <div v-else-if="plugins.length === 0" class="card empty">No hook plugins installed yet. Import one to get started.</div>
  <div v-else-if="filtered.length === 0" class="card empty">
    No plugins match your filters. <button class="btn" @click="resetFilters">Clear filters</button>
  </div>
  <div v-else class="plugin-grid">
    <div v-for="p in filtered" :key="p.id" class="plugin-card" :class="{ off: !p.enabled }">
      <div class="pc-body" role="button" tabindex="0" title="View details" @click="openDetail(p)" @keydown.enter="openDetail(p)">
        <div class="pc-head">
          <div class="pc-title">
            <span class="pc-name">{{ p.name }}</span>
            <span class="badge" :class="p.enabled ? 'online' : 'disabled'">{{ p.enabled ? 'on' : 'off' }}</span>
          </div>
          <div class="pc-meta">
            <span class="badge type hook">Hook</span>
            <small class="muted">v{{ p.version }}</small>
            <small class="muted" v-if="p.author">· {{ p.author }}</small>
            <span v-if="p.source === 'native'" class="badge" title="Built-in plugin">built-in</span>
          </div>
        </div>
        <p class="pc-desc muted">{{ p.description }}</p>
        <div v-if="p.hookPoints && p.hookPoints.length" class="pc-hooks">
          <span v-for="hp in p.hookPoints" :key="hp" class="badge hook">{{ hp }}</span>
        </div>
        <div v-if="p.error" class="pc-err"><small>{{ p.error }}</small></div>
        <div class="pc-detail-hint muted"><small>Details →</small></div>
      </div>
      <div class="pc-actions btn-row" v-if="canWrite">
        <button class="btn" @click="configPlugin = p">Config</button>
        <button class="btn" :class="{ primary: !p.enabled }" @click="toggle(p)">{{ p.enabled ? 'Disable' : 'Enable' }}</button>
        <button v-if="p.source !== 'native'" class="btn danger" @click="remove(p)">Delete</button>
      </div>
    </div>
  </div>

  <!-- Import modal -->
  <div v-if="showImport" class="modal-backdrop" @click.self="showImport = false">
    <div class="modal" style="max-width: 720px">
      <h2>Import plugin</h2>
      <p class="muted" style="margin-top: -0.5rem">Paste a plugin module. The id must match the manifest id.</p>
      <div v-if="importError" class="alert error">{{ importError }}</div>
      <div class="field"><label>Plugin id (slug)</label><input v-model="importForm.id" placeholder="my-plugin" /></div>
      <div class="field"><label>Source (ES module)</label><textarea v-model="importForm.source" rows="16" spellcheck="false"></textarea></div>
      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="showImport = false">Cancel</button>
        <button class="btn primary" :disabled="importing" @click="doImport">{{ importing ? 'Importing…' : 'Import' }}</button>
      </div>
    </div>
  </div>

  <!-- Detail modal -->
  <div v-if="showDetail" class="modal-backdrop" @click.self="showDetail = false">
    <div class="modal" style="max-width: 660px">
      <div class="row spread">
        <h2 style="margin: 0">{{ detailPlugin?.name }}</h2>
        <span class="badge" :class="detailPlugin?.enabled ? 'online' : 'disabled'">{{ detailPlugin?.enabled ? 'on' : 'off' }}</span>
      </div>
      <div class="pc-meta" style="margin-top: 0.6rem">
        <span class="badge type hook">Hook</span>
        <small class="muted">v{{ detailPlugin?.version }}</small>
        <small class="muted" v-if="detailPlugin?.author">· {{ detailPlugin?.author }}</small>
        <span v-if="detailPlugin?.source === 'native'" class="badge" title="Built-in plugin">built-in</span>
      </div>
      <p style="margin-top: 1rem">{{ detailPlugin?.description }}</p>
      <div v-if="detailPlugin?.hookPoints && detailPlugin.hookPoints.length" class="pc-hooks" style="margin-top: 0.5rem">
        <span v-for="hp in detailPlugin.hookPoints" :key="hp" class="badge hook">{{ hp }}</span>
      </div>
      <div v-if="detailPlugin?.setup" class="setup-note" style="margin-top: 1.25rem">
        <div class="setup-title">Setup &amp; required permissions</div>
        {{ detailPlugin.setup }}
      </div>
      <div v-if="detailPlugin?.error" class="alert error" style="margin-top: 1rem">{{ detailPlugin.error }}</div>
      <div class="btn-row" style="justify-content: flex-end; margin-top: 1.5rem">
        <button class="btn" @click="showDetail = false">Close</button>
        <button v-if="canWrite" class="btn primary" @click="configFromDetail()">Configure</button>
      </div>
    </div>
  </div>

  <!-- Config modal (shared component) -->
  <PluginConfigModal
    v-if="configPlugin"
    :plugin="configPlugin"
    @close="configPlugin = null"
    @saved="(res) => { if (res) applyList(res); toast.success('Plugin configuration saved.'); }"
  />
</template>

<style scoped>
.muted { color: var(--text-muted); }
.seg { display: inline-flex; gap: 2px; padding: 3px; background: var(--hover); border: 1px solid var(--border); border-radius: var(--radius-md); margin-bottom: 1rem; }
.seg-btn { border: 0; background: transparent; color: var(--text-muted); padding: 0.35rem 0.9rem; border-radius: var(--radius-sm); cursor: pointer; font: inherit; }
.seg-btn.active { background: var(--bg-surface); color: var(--text); box-shadow: var(--shadow-sm); }

.filter-bar { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
.filter-bar .search { flex: 1; min-width: 220px; padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text); }
.filter-bar select { padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text); }

.plugin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
.plugin-card { display: flex; flex-direction: column; gap: 0.5rem; padding: 1rem; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-surface); box-shadow: var(--shadow-sm); }
.plugin-card.off { opacity: 0.72; }
.pc-head { display: flex; flex-direction: column; gap: 0.3rem; }
.pc-title { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.pc-name { font-weight: 600; color: var(--text); }
.pc-meta { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.badge.type { text-transform: none; }
.badge.type.hook { background: var(--info-bg); color: var(--info); }
.pc-desc { margin: 0; font-size: 0.88rem; line-height: 1.4; min-height: 2.4em; }
.pc-hooks { display: flex; flex-wrap: wrap; gap: 4px; }
.pc-hooks .badge.hook { text-transform: none; background: var(--hover); color: var(--text-muted); }
.pc-err { color: var(--danger); }
.pc-actions { margin-top: auto; padding-top: 0.25rem; }
.pc-body { display: flex; flex-direction: column; gap: 0.5rem; cursor: pointer; border-radius: var(--radius-md); }
.pc-body:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.pc-body:hover .pc-name { color: var(--accent); }
.pc-detail-hint { opacity: 0; transition: opacity 0.15s ease; color: var(--accent); }
.pc-body:hover .pc-detail-hint,
.pc-body:focus-visible .pc-detail-hint { opacity: 1; }
.setup-note {
  margin-top: 0.75rem; padding: 0.7rem 0.85rem; border: 1px solid var(--border); border-left: 3px solid var(--accent);
  border-radius: var(--radius-md); background: var(--bg-page); color: var(--text-muted); font-size: 0.85rem; line-height: 1.5; white-space: pre-line;
}
.setup-note .setup-title { font-weight: 600; color: var(--text); margin-bottom: 0.3rem; white-space: normal; }
</style>
