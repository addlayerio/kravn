<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { PluginView } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

const auth = useAuthStore();
const toast = useToastStore();
const canWrite = auth.can('settings.write');

const plugins = ref<PluginView[]>([]);
const loadErrors = ref<{ source: string; error: string }[]>([]);
const loading = ref(true);

const showImport = ref(false);
const importForm = reactive({ id: '', source: '' });
const importing = ref(false);
const importError = ref('');

const showConfig = ref(false);
const configPlugin = ref<PluginView | null>(null);
const configError = ref('');
const rawMode = ref(false);
const rawText = ref('{}');
// schema-driven model
const model = reactive<Record<string, any>>({});
const arrText = reactive<Record<string, string>>({});
const jsonText = reactive<Record<string, string>>({});

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

type SourceKind = 'tools' | 'resources' | 'prompts' | 'servers';

interface Field {
  key: string;
  label: string;
  help?: string;
  control: 'string' | 'number' | 'boolean' | 'enum' | 'string[]' | 'json' | 'pick-multi' | 'pick-one';
  options?: string[];
  /** When set, options come live from the registry (`x-kravn-source` in the schema). */
  source?: SourceKind;
  def?: unknown;
}

function fieldsFromSchema(schema: any): Field[] | null {
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') return null;
  const fields: Field[] = [];
  for (const [key, raw] of Object.entries<any>(schema.properties)) {
    const p = raw || {};
    const source: SourceKind | undefined = ['tools', 'resources', 'prompts', 'servers'].includes(p['x-kravn-source'])
      ? p['x-kravn-source']
      : undefined;
    let control: Field['control'] = 'string';
    let options: string[] | undefined;
    if (Array.isArray(p.enum)) {
      control = 'enum';
      options = p.enum.map(String);
    } else if (p.type === 'boolean') control = 'boolean';
    else if (p.type === 'number' || p.type === 'integer') control = 'number';
    else if (p.type === 'array') control = source ? 'pick-multi' : !p.items || p.items.type === 'string' ? 'string[]' : 'json';
    else if (p.type === 'object') control = 'json';
    else control = source ? 'pick-one' : 'string';
    fields.push({ key, label: p.title || key, help: p.description, control, options, source, def: p.default });
  }
  return fields;
}

const sources = reactive<Record<SourceKind, string[]>>({ tools: [], resources: [], prompts: [], servers: [] });

async function loadSources(needed: Set<SourceKind>): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (needed.has('tools')) tasks.push(api.get<{ tools: { name: string }[] }>('/api/tools').then((r) => { sources.tools = r.tools.map((t) => t.name); }));
  if (needed.has('resources')) tasks.push(api.get<{ resources: { uri: string }[] }>('/api/resources').then((r) => { sources.resources = r.resources.map((x) => x.uri); }));
  if (needed.has('prompts')) tasks.push(api.get<{ prompts: { name: string }[] }>('/api/prompts').then((r) => { sources.prompts = r.prompts.map((x) => x.name); }));
  if (needed.has('servers')) tasks.push(api.get<{ servers: { name: string }[] }>('/api/servers').then((r) => { sources.servers = r.servers.map((x) => x.name); }));
  await Promise.all(tasks);
}

function optionsFor(f: Field): string[] {
  const base = f.source ? sources[f.source] : [];
  const cur = model[f.key];
  const selected = Array.isArray(cur) ? cur.map(String) : cur ? [String(cur)] : [];
  return Array.from(new Set([...base, ...selected]));
}

const fields = computed(() => (configPlugin.value ? fieldsFromSchema(configPlugin.value.configSchema) : null));

function applyList(res: { plugins: PluginView[]; loadErrors: { source: string; error: string }[] }) {
  plugins.value = res.plugins;
  loadErrors.value = res.loadErrors ?? [];
}

const hookSummary = computed(() => {
  const m: Record<string, number> = {};
  for (const p of plugins.value) for (const hp of p.hookPoints ?? []) m[hp] = (m[hp] || 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
});

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

async function openConfig(p: PluginView) {
  configPlugin.value = p;
  configError.value = '';
  const cfg = p.config ?? {};
  const f = fieldsFromSchema(p.configSchema);
  // reset buffers
  for (const k of Object.keys(model)) delete model[k];
  for (const k of Object.keys(arrText)) delete arrText[k];
  for (const k of Object.keys(jsonText)) delete jsonText[k];

  rawText.value = JSON.stringify(cfg, null, 2);
  showConfig.value = true;

  if (!f) {
    rawMode.value = true;
    return;
  }
  rawMode.value = false;

  const needed = new Set(f.filter((x) => x.source).map((x) => x.source!));
  if (needed.size) await loadSources(needed).catch(() => {});

  for (const field of f) {
    const cur = (cfg as any)[field.key] ?? field.def;
    if (field.control === 'string[]') {
      arrText[field.key] = Array.isArray(cur) ? cur.join('\n') : '';
    } else if (field.control === 'pick-multi') {
      model[field.key] = Array.isArray(cur) ? [...cur] : [];
    } else if (field.control === 'json') {
      jsonText[field.key] = cur === undefined ? '' : JSON.stringify(cur, null, 2);
    } else if (field.control === 'boolean') {
      model[field.key] = !!cur;
    } else {
      model[field.key] = cur ?? '';
    }
  }
}

async function saveConfig() {
  if (!configPlugin.value) return;
  configError.value = '';
  let config: Record<string, unknown>;

  if (rawMode.value || !fields.value) {
    try {
      config = rawText.value.trim() ? JSON.parse(rawText.value) : {};
    } catch {
      configError.value = 'Config must be valid JSON.';
      return;
    }
  } else {
    config = { ...(configPlugin.value.config ?? {}) };
    for (const f of fields.value) {
      if (f.control === 'string[]') {
        config[f.key] = (arrText[f.key] ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
      } else if (f.control === 'pick-multi') {
        config[f.key] = Array.isArray(model[f.key]) ? model[f.key] : [];
      } else if (f.control === 'json') {
        const t = (jsonText[f.key] ?? '').trim();
        if (!t) {
          delete config[f.key];
        } else {
          try {
            config[f.key] = JSON.parse(t);
          } catch {
            configError.value = `Field "${f.label}" must be valid JSON.`;
            return;
          }
        }
      } else if (f.control === 'number') {
        config[f.key] = Number(model[f.key]);
      } else {
        config[f.key] = model[f.key];
      }
    }
  }

  try {
    applyList(await api.patch(`/api/plugins/${configPlugin.value.id}`, { config }));
    showConfig.value = false;
    toast.success('Plugin configuration saved.');
  } catch (e) {
    configError.value = e instanceof ApiError ? e.message : 'Could not save config.';
  }
}
</script>

<template>
  <div class="topbar">
    <div>
      <h1>Plugins</h1>
      <small class="muted">Extend Kravn with request/response hooks and in-process MCP servers.</small>
    </div>
    <div class="btn-row">
      <button class="btn" @click="rescan">Rescan</button>
      <button v-if="canWrite" class="btn primary" @click="openImport">+ Import plugin</button>
    </div>
  </div>

  <div class="alert" style="border-color: var(--warning); background: var(--warning-bg); color: var(--warning)">
    Plugins run in-process with the gateway's privileges. Only enable plugins you trust. See <code>PLUGINS.md</code> to build your own.
  </div>

  <div v-if="loadErrors.length" class="alert error">
    <strong>Some plugin files failed to load:</strong>
    <div v-for="(e, i) in loadErrors" :key="i"><code>{{ e.source }}</code>: {{ e.error }}</div>
  </div>

  <div v-if="hookSummary.length" class="card">
    <h3>Hook points</h3>
    <div class="btn-row">
      <span v-for="[hp, n] in hookSummary" :key="hp" class="badge online" style="text-transform: none">{{ hp }} · {{ n }}</span>
    </div>
  </div>

  <div class="card">
    <p v-if="loading" class="muted">Loading…</p>
    <div v-else-if="plugins.length === 0" class="empty">No plugins installed yet. Import one to get started.</div>
    <table v-else>
      <thead>
        <tr><th>Plugin</th><th>Type</th><th>Version</th><th>Enabled</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="p in plugins" :key="p.id">
          <td>
            <div style="font-weight: 600">{{ p.name }}</div>
            <small class="muted">{{ p.description }}</small>
            <div v-if="p.error"><small style="color: var(--danger)">{{ p.error }}</small></div>
            <div v-if="p.hookPoints && p.hookPoints.length" style="margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap">
              <span v-for="hp in p.hookPoints" :key="hp" class="badge" style="text-transform: none">{{ hp }}</span>
            </div>
          </td>
          <td><span class="badge">{{ p.type }}</span></td>
          <td><small class="muted">{{ p.version }}</small></td>
          <td><span class="badge" :class="p.enabled ? 'online' : 'disabled'">{{ p.enabled ? 'on' : 'off' }}</span></td>
          <td>
            <div class="btn-row" v-if="canWrite">
              <button class="btn" @click="openConfig(p)">Config</button>
              <button class="btn" @click="toggle(p)">{{ p.enabled ? 'Disable' : 'Enable' }}</button>
              <!-- Built-in (native) plugins can't be removed — only disabled. -->
              <button v-if="p.source !== 'native'" class="btn danger" @click="remove(p)">Delete</button>
              <span v-else class="badge" title="Built-in plugin">built-in</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
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

  <!-- Config modal -->
  <div v-if="showConfig" class="modal-backdrop" @click.self="showConfig = false">
    <div class="modal">
      <div class="row spread">
        <h2 style="margin: 0">Configure: {{ configPlugin?.name }}</h2>
        <button v-if="fields" class="btn" @click="rawMode = !rawMode">{{ rawMode ? 'Form' : 'Edit as JSON' }}</button>
      </div>

      <div v-if="configError" class="alert error" style="margin-top: 0.75rem">{{ configError }}</div>

      <!-- No schema declared -->
      <p v-if="!fields && !rawMode" class="muted" style="margin-top: 0.5rem">
        This plugin doesn't declare a <code>configSchema</code>, so there are no known fields. Add a
        <code>configSchema</code> to its manifest to get a form here, or edit the raw config below.
      </p>

      <!-- Schema-driven form -->
      <template v-if="fields && !rawMode">
        <div v-if="fields.length === 0" class="empty">This plugin has an empty config schema.</div>
        <div v-for="f in fields" :key="f.key" class="field" style="margin-top: 1rem">
          <label>{{ f.label }}</label>

          <div v-if="f.control === 'boolean'" class="checkbox">
            <input type="checkbox" v-model="model[f.key]" />
            <span class="muted">{{ model[f.key] ? 'Enabled' : 'Disabled' }}</span>
          </div>
          <input v-else-if="f.control === 'number'" type="number" v-model="model[f.key]" />
          <select v-else-if="f.control === 'enum'" v-model="model[f.key]">
            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <div v-else-if="f.control === 'pick-multi'" class="card" style="max-height: 170px; overflow: auto; margin: 0; background: var(--bg-page)">
            <div v-if="optionsFor(f).length === 0" class="muted">No {{ f.source }} available — add/sync some first.</div>
            <label v-for="o in optionsFor(f)" :key="o" class="checkbox" style="font-weight: 400">
              <input type="checkbox" :value="o" v-model="model[f.key]" /> {{ o }}
            </label>
          </div>
          <select v-else-if="f.control === 'pick-one'" v-model="model[f.key]">
            <option value="">(none)</option>
            <option v-for="o in optionsFor(f)" :key="o" :value="o">{{ o }}</option>
          </select>
          <textarea v-else-if="f.control === 'string[]'" rows="3" v-model="arrText[f.key]" placeholder="One per line"></textarea>
          <textarea v-else-if="f.control === 'json'" rows="4" spellcheck="false" v-model="jsonText[f.key]" placeholder="JSON value"></textarea>
          <input v-else v-model="model[f.key]" />

          <small v-if="f.help" class="muted">{{ f.help }}</small>
        </div>
      </template>

      <!-- Raw JSON editor (fallback / advanced) -->
      <template v-if="!fields || rawMode">
        <div class="field" style="margin-top: 1rem">
          <label>Config (JSON)</label>
          <textarea v-model="rawText" rows="8" spellcheck="false"></textarea>
        </div>
      </template>

      <div class="btn-row" style="justify-content: flex-end; margin-top: 1rem">
        <button class="btn" @click="showConfig = false">Cancel</button>
        <button class="btn primary" @click="saveConfig">Save</button>
      </div>
    </div>
  </div>
</template>
