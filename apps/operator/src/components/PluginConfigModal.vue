<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { PluginView } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import MarkdownText from './MarkdownText.vue';

/**
 * Schema-driven plugin configuration modal, extracted from PluginsView so BOTH the Plugins page (hooks) and
 * the unified integrations Catalog (native mcp-server plugins) configure a plugin with the same UX.
 */
const props = defineProps<{ plugin: PluginView }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', res: { plugins: PluginView[]; loadErrors: { source: string; error: string }[] }): void;
}>();

type SourceKind = 'tools' | 'resources' | 'prompts' | 'servers';
interface Field {
  key: string;
  label: string;
  help?: string;
  control: 'string' | 'number' | 'boolean' | 'enum' | 'string[]' | 'json' | 'pick-multi' | 'pick-one' | 'secret';
  options?: string[];
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
    if (p.secret === true) control = 'secret';
    else if (Array.isArray(p.enum)) {
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

const fields = computed(() => fieldsFromSchema(props.plugin.configSchema));
const configError = ref('');
const rawMode = ref(false);
const rawText = ref('{}');
const model = reactive<Record<string, any>>({});
const arrText = reactive<Record<string, string>>({});
const jsonText = reactive<Record<string, string>>({});

async function init() {
  const p = props.plugin;
  configError.value = '';
  const cfg = p.config ?? {};
  const f = fieldsFromSchema(p.configSchema);
  for (const k of Object.keys(model)) delete model[k];
  for (const k of Object.keys(arrText)) delete arrText[k];
  for (const k of Object.keys(jsonText)) delete jsonText[k];
  rawText.value = JSON.stringify(cfg, null, 2);
  if (!f) {
    rawMode.value = true;
    return;
  }
  rawMode.value = false;
  const needed = new Set(f.filter((x) => x.source).map((x) => x.source!));
  if (needed.size) await loadSources(needed).catch(() => {});
  for (const field of f) {
    const cur = (cfg as any)[field.key] ?? field.def;
    if (field.control === 'string[]') arrText[field.key] = Array.isArray(cur) ? cur.join('\n') : '';
    else if (field.control === 'pick-multi') model[field.key] = Array.isArray(cur) ? [...cur] : [];
    else if (field.control === 'json') jsonText[field.key] = cur === undefined ? '' : JSON.stringify(cur, null, 2);
    else if (field.control === 'boolean') model[field.key] = !!cur;
    else model[field.key] = cur ?? '';
  }
}
watch(() => props.plugin.id, init, { immediate: true });

async function saveConfig() {
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
    config = { ...(props.plugin.config ?? {}) };
    for (const f of fields.value) {
      if (f.control === 'string[]') config[f.key] = (arrText[f.key] ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
      else if (f.control === 'pick-multi') config[f.key] = Array.isArray(model[f.key]) ? model[f.key] : [];
      else if (f.control === 'json') {
        const t = (jsonText[f.key] ?? '').trim();
        if (!t) delete config[f.key];
        else {
          try {
            config[f.key] = JSON.parse(t);
          } catch {
            configError.value = `Field "${f.label}" must be valid JSON.`;
            return;
          }
        }
      } else if (f.control === 'number') config[f.key] = Number(model[f.key]);
      else config[f.key] = model[f.key];
    }
  }
  try {
    const res = await api.patch<{ plugins: PluginView[]; loadErrors: { source: string; error: string }[] }>(
      `/api/plugins/${props.plugin.id}`,
      { config },
    );
    emit('saved', res);
    emit('close');
  } catch (e) {
    configError.value = e instanceof ApiError ? e.message : 'Could not save config.';
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="row spread">
        <h2 style="margin: 0">Configure: {{ plugin.name }}</h2>
        <button v-if="fields" class="btn" @click="rawMode = !rawMode">{{ rawMode ? 'Form' : 'Edit as JSON' }}</button>
      </div>

      <div v-if="plugin.setup" class="setup-note">
        <div class="setup-title">Setup &amp; required permissions</div>
        <MarkdownText :text="plugin.setup" />
      </div>

      <div v-if="configError" class="alert error" style="margin-top: 0.75rem">{{ configError }}</div>

      <p v-if="!fields && !rawMode" class="muted" style="margin-top: 0.5rem">
        This plugin doesn't declare a <code>configSchema</code>, so there are no known fields. Edit the raw config below.
      </p>

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
          <input
            v-else-if="f.control === 'secret'"
            type="password"
            autocomplete="new-password"
            v-model="model[f.key]"
            :placeholder="plugin.configSecretsSet?.[f.key] ? '•••••• (set — leave blank to keep)' : ''"
          />
          <input v-else v-model="model[f.key]" />
          <MarkdownText v-if="f.help" :text="f.help" inline class="field-help" />
        </div>
      </template>

      <template v-if="!fields || rawMode">
        <div class="field" style="margin-top: 1rem">
          <label>Config (JSON)</label>
          <textarea v-model="rawText" rows="8" spellcheck="false"></textarea>
        </div>
      </template>

      <div class="btn-row" style="justify-content: flex-end; margin-top: 1rem">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn primary" @click="saveConfig">Save</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.muted { color: var(--text-muted); }
.setup-note {
  margin-top: 0.75rem;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  background: var(--bg-page);
  color: var(--text-muted);
  font-size: 0.85rem;
  line-height: 1.5;
}
.setup-note .setup-title { font-weight: 600; color: var(--text); margin-bottom: 0.3rem; }
.field-help { display: block; margin-top: 0.3rem; font-size: 0.8rem; color: var(--text-muted); }
.field-help :deep(code) { font-size: 0.85em; }
</style>
