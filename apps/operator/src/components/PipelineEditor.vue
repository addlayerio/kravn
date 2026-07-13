<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PipelineView, PipelinePointView, PipelineStepView, PipelineTraceResult } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

// The pipeline is edited for ONE scope: 'global' (the base) or a mcpEndpointId (an overlay). Opt-in at
// every scope — a junction shows only the plugins explicitly added to it, plus an add picker.
const props = defineProps<{ scope: string }>();

const auth = useAuthStore();
const toast = useToastStore();
const { t } = useI18n();
const canWrite = auth.can('settings.write');

const view = ref<PipelineView | null>(null);
const loading = ref(true);
const activeScope = ref<string>('tools');
const saving = ref<string | null>(null);
const edited = reactive<Record<string, PipelineStepView[]>>({});

const scopes = computed(() => view.value?.scopes ?? []);
const scope = computed(() => scopes.value.find((s) => s.key === activeScope.value) ?? scopes.value[0] ?? null);

function rebuildEdited(v: PipelineView): void {
  for (const k of Object.keys(edited)) delete edited[k];
  for (const s of v.scopes) for (const p of s.points) edited[p.method] = p.steps.map((x) => ({ ...x }));
  if (!v.scopes.some((s) => s.key === activeScope.value)) activeScope.value = v.scopes[0]?.key ?? 'tools';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const v = await api.get<PipelineView>(`/api/pipeline?scope=${encodeURIComponent(props.scope)}`);
    view.value = v;
    rebuildEdited(v);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('pipelineEditor.couldNotLoad'));
  } finally {
    loading.value = false;
  }
}
watch(() => props.scope, load, { immediate: true });

function pointOf(method: string): PipelinePointView | undefined {
  for (const s of scopes.value) for (const p of s.points) if (p.method === method) return p;
  return undefined;
}
function serverSteps(method: string): PipelineStepView[] {
  return pointOf(method)?.steps ?? [];
}
function isDirty(method: string): boolean {
  return JSON.stringify(edited[method] ?? []) !== JSON.stringify(serverSteps(method));
}
function move(method: string, i: number, dir: -1 | 1): void {
  const arr = edited[method];
  const j = i + dir;
  if (!arr || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
function toggleStep(method: string, i: number): void {
  const s = edited[method]?.[i];
  if (s) s.enabled = !s.enabled;
}
function removeStep(method: string, i: number): void {
  edited[method]?.splice(i, 1);
}
function addStep(method: string, pluginId: string): void {
  if (!pluginId) return;
  const avail = pointOf(method)?.available?.find((a) => a.pluginId === pluginId);
  if (!avail || edited[method]?.some((s) => s.pluginId === pluginId)) return;
  edited[method].push({ pluginId, name: avail.name, description: '', enabled: true, pluginEnabled: true });
}
function availableToAdd(p: PipelinePointView): Array<{ pluginId: string; name: string }> {
  const inChain = new Set((edited[p.method] ?? []).map((s) => s.pluginId));
  return (p.available ?? []).filter((a) => !inChain.has(a.pluginId));
}
function resetPoint(method: string): void {
  edited[method] = serverSteps(method).map((x) => ({ ...x }));
}
async function save(method: string): Promise<void> {
  saving.value = method;
  try {
    const steps = (edited[method] ?? []).map((s) => ({ pluginId: s.pluginId, enabled: s.enabled }));
    const v = await api.put<PipelineView>(`/api/pipeline/${encodeURIComponent(props.scope)}/${method}`, { steps });
    view.value = v;
    rebuildEdited(v);
    toast.success(t('pipelineEditor.pipelineSaved'));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('pipelineEditor.couldNotSave'));
  } finally {
    saving.value = null;
  }
}

function caption(p: PipelinePointView): string {
  if (p.kind === 'list') return t('pipelineEditor.captionList');
  if (p.method === 'onResolveUser') return t('pipelineEditor.captionResolveUser');
  if (p.kind === 'pre') return t('pipelineEditor.captionPre');
  return t('pipelineEditor.captionPost');
}

// ─── Trace ───────────────────────────────────────────────────────────────────────────────────────
const traceFor = ref<string | null>(null);
const tracePayload = ref('');
const traceServer = ref('');
const traceTool = ref('');
const tracing = ref(false);
const traceResult = ref<PipelineTraceResult | null>(null);
const SAMPLE: Record<string, string> = {
  list: '[\n  { "name": "getDoc", "description": "Fetch a document" }\n]',
  pre: '{\n  "query": "BROU quarterly report"\n}',
  post: '{\n  "content": [{ "type": "text", "text": "BROU revenue was ..." }]\n}',
};
function openTrace(p: PipelinePointView): void {
  traceFor.value = traceFor.value === p.method ? null : p.method;
  traceResult.value = null;
  if (traceFor.value) tracePayload.value = SAMPLE[p.kind] ?? '{}';
}
async function runTrace(p: PipelinePointView): Promise<void> {
  tracing.value = true;
  traceResult.value = null;
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(tracePayload.value || 'null');
    } catch {
      toast.error(t('pipelineEditor.invalidJson'));
      return;
    }
    const body: Record<string, unknown> = { payload, server: traceServer.value || undefined, tool: traceTool.value || undefined };
    traceResult.value = await api.post<PipelineTraceResult>(`/api/pipeline/${encodeURIComponent(props.scope)}/${p.method}/trace`, body);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('pipelineEditor.traceFailed'));
  } finally {
    tracing.value = false;
  }
}
function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
</script>

<template>
  <div v-if="loading" class="card"><p class="muted">{{ t('pipelineEditor.loading') }}</p></div>
  <template v-else>
    <div class="btn-row" style="margin-bottom: 1rem">
      <button v-for="s in scopes" :key="s.key" class="btn" :class="{ primary: s.key === activeScope }" @click="activeScope = s.key">
        {{ s.label }}
      </button>
    </div>

    <div v-if="scope" class="scope-flow muted">
      <span v-for="(node, i) in scope.spine" :key="i">
        <span class="node">{{ node }}</span><span v-if="i < scope.spine.length - 1" class="arrow"> → </span>
      </span>
    </div>

    <div v-for="p in scope?.points ?? []" :key="p.method" class="card junction">
      <div class="junction-head">
        <div>
          <h3>
            {{ p.label }}
            <span class="badge kind" :class="p.kind">{{ p.kind }}</span>
            <span v-if="p.canDeny" class="badge deny">{{ t('pipelineEditor.canDeny') }}</span>
          </h3>
          <p class="muted small">{{ caption(p) }}</p>
        </div>
        <div class="btn-row">
          <button class="btn" @click="openTrace(p)">{{ traceFor === p.method ? t('pipelineEditor.closeTrace') : t('pipelineEditor.trace') }}</button>
          <button v-if="canWrite" class="btn" :disabled="!isDirty(p.method)" @click="resetPoint(p.method)">{{ t('pipelineEditor.reset') }}</button>
          <button v-if="canWrite" class="btn primary" :disabled="!isDirty(p.method) || saving === p.method" @click="save(p.method)">
            {{ saving === p.method ? t('pipelineEditor.saving') : t('pipelineEditor.save') }}
          </button>
        </div>
      </div>

      <!-- Inherited (global) steps, read-only, when editing a VS overlay -->
      <div v-if="p.inherited && p.inherited.length" class="inherited">
        <div class="muted small">{{ t('pipelineEditor.inheritedFromGlobal') }}</div>
        <ol class="steps">
          <li v-for="(step, i) in p.inherited" :key="'inh-' + step.pluginId" class="step inherited-step" :class="{ off: !step.enabled || !step.pluginEnabled }">
            <span class="pos muted">G{{ i + 1 }}</span>
            <div class="step-main"><div class="step-name">{{ step.name }}</div></div>
            <span class="badge" :class="step.enabled && step.pluginEnabled ? 'online' : 'disabled'">{{ step.enabled && step.pluginEnabled ? t('pipelineEditor.on') : t('pipelineEditor.off') }}</span>
          </li>
        </ol>
      </div>

      <div v-if="!(edited[p.method]?.length)" class="empty small">
        {{ t('pipelineEditor.noPluginsYet') }}
      </div>

      <ol v-else class="steps">
        <li v-for="(step, i) in edited[p.method]" :key="step.pluginId" class="step" :class="{ off: !step.enabled || !step.pluginEnabled }">
          <span class="pos">{{ i + 1 }}</span>
          <div class="reorder" v-if="canWrite">
            <button class="btn tiny" :disabled="i === 0" :title="t('pipelineEditor.moveUp')" @click="move(p.method, i, -1)">▲</button>
            <button class="btn tiny" :disabled="i === edited[p.method].length - 1" :title="t('pipelineEditor.moveDown')" @click="move(p.method, i, 1)">▼</button>
          </div>
          <div class="step-main">
            <div class="step-name">
              {{ step.name }}
              <span v-if="!step.pluginEnabled" class="badge disabled" :title="t('pipelineEditor.pluginOffTooltip')">{{ t('pipelineEditor.pluginOff') }}</span>
            </div>
            <div class="muted small" v-if="step.description">{{ step.description }}</div>
          </div>
          <label class="checkbox step-toggle">
            <input type="checkbox" :checked="step.enabled" :disabled="!canWrite" @change="toggleStep(p.method, i)" />
            <span>{{ step.enabled ? t('pipelineEditor.on') : t('pipelineEditor.off') }}</span>
          </label>
          <button v-if="canWrite" class="btn tiny danger" :title="t('pipelineEditor.removeFromJunction')" @click="removeStep(p.method, i)">✕</button>
        </li>
      </ol>

      <div v-if="canWrite && availableToAdd(p).length" class="add-step">
        <select @change="addStep(p.method, ($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
          <option value="">{{ t('pipelineEditor.addPluginOption') }}</option>
          <option v-for="a in availableToAdd(p)" :key="a.pluginId" :value="a.pluginId">{{ a.name }}</option>
        </select>
      </div>

      <!-- Trace panel -->
      <div v-if="traceFor === p.method" class="trace">
        <p class="muted small">
          {{ t('pipelineEditor.traceHelp') }}
        </p>
        <div class="trace-inputs">
          <textarea v-model="tracePayload" rows="4" spellcheck="false" :placeholder="t('pipelineEditor.samplePayloadPlaceholder')"></textarea>
          <div class="trace-hints" v-if="p.kind !== 'list' && p.method !== 'onResolveUser'">
            <input v-model="traceServer" :placeholder="t('pipelineEditor.serverPlaceholder')" />
            <input v-model="traceTool" :placeholder="t('pipelineEditor.toolPromptPlaceholder')" />
          </div>
          <button class="btn primary" :disabled="tracing" @click="runTrace(p)">{{ tracing ? t('pipelineEditor.running') : t('pipelineEditor.run') }}</button>
        </div>
        <div v-if="traceResult" class="trace-out">
          <div v-if="traceResult.denied" class="alert error small">
            {{ t('pipelineEditor.deniedBy') }} <strong>{{ traceResult.denied.pluginId }}</strong>: {{ traceResult.denied.reason }}
          </div>
          <div v-for="(ts, i) in traceResult.steps" :key="i" class="trace-step">
            <div class="trace-step-head">
              <span class="pos">{{ i + 1 }}</span>
              <strong>{{ ts.name }}</strong>
              <span v-if="ts.denied" class="badge error">{{ t('pipelineEditor.denied') }}</span>
              <span v-else-if="ts.error" class="badge error">{{ t('pipelineEditor.errorBadge') }}</span>
              <span v-else-if="ts.changed" class="badge online">{{ t('pipelineEditor.changed') }}</span>
              <span v-else class="badge disabled">{{ t('pipelineEditor.noChange') }}</span>
            </div>
            <div v-if="ts.error" class="muted small">{{ ts.error }}</div>
            <div v-else-if="ts.changed" class="diff">
              <div><span class="muted small">{{ t('pipelineEditor.before') }}</span><pre>{{ pretty(ts.before) }}</pre></div>
              <div><span class="muted small">{{ t('pipelineEditor.after') }}</span><pre>{{ pretty(ts.after) }}</pre></div>
            </div>
          </div>
          <div class="trace-final">
            <span class="muted small">{{ t('pipelineEditor.resultArrow', { target: scope?.spine?.slice(-1)[0] }) }}</span>
            <pre>{{ pretty(traceResult.output) }}</pre>
          </div>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.muted { color: var(--text-muted); }
.small { font-size: 0.85rem; }
.scope-flow { margin: 0 0 1rem; display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; }
.scope-flow .node { padding: 0.15rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--text); }
.scope-flow .arrow { opacity: 0.6; }
.junction { margin-bottom: 1rem; }
.junction-head { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; flex-wrap: wrap; }
.junction-head h3 { margin: 0 0 0.25rem; display: flex; align-items: center; gap: 0.4rem; color: var(--text); }
.badge.kind { text-transform: capitalize; }
.badge.kind.pre { background: var(--warning-bg); color: var(--warning); }
.badge.kind.post { background: var(--info-bg); color: var(--info); }
.badge.deny { background: var(--danger-bg); color: var(--danger); }
.inherited { margin: 0.5rem 0; padding: 0.5rem; border: 1px dashed var(--border-strong); border-radius: var(--radius-md); background: var(--hover); }
.inherited-step { background: transparent; border-style: dashed; }
.steps { list-style: none; margin: 0.5rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.step { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0.6rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--hover); color: var(--text); }
.step.off { opacity: 0.55; }
.step .pos { min-width: 1.6rem; height: 1.4rem; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-pill); background: var(--brand); color: var(--brand-fg); font-size: 0.75rem; }
.step .pos.muted { background: var(--border-strong); color: var(--text); }
.reorder { display: flex; flex-direction: column; gap: 2px; }
.btn.tiny { padding: 0 0.4rem; line-height: 1.2; font-size: 0.75rem; }
.step-main { flex: 1; min-width: 0; }
.step-name { font-weight: 600; display: flex; align-items: center; gap: 0.4rem; color: var(--text); }
.step-toggle { margin: 0; white-space: nowrap; }
.add-step { margin-top: 0.5rem; }
.add-step select { padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text); }
.trace { margin-top: 1rem; border-top: 1px dashed var(--border-strong); padding-top: 0.75rem; }
.trace-inputs { display: flex; flex-direction: column; gap: 0.5rem; }
.trace-inputs textarea, .trace-hints input { width: 100%; font-family: var(--font-mono); font-size: 0.8rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text); padding: 0.4rem; }
.trace-hints { display: flex; gap: 0.5rem; }
.trace-hints input { flex: 1; }
.trace-out { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
.trace-step { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0.5rem; }
.trace-step-head { display: flex; align-items: center; gap: 0.4rem; }
.diff { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.4rem; }
.diff pre, .trace-final pre { margin: 0.2rem 0 0; padding: 0.5rem; background: var(--code-bg); color: var(--text); border-radius: var(--radius-md); overflow: auto; font-size: 0.75rem; max-height: 220px; }
</style>
