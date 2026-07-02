<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type {
  PipelineView,
  PipelinePointView,
  PipelineStepView,
  PipelineTraceResult,
} from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

const auth = useAuthStore();
const toast = useToastStore();
const canWrite = auth.can('settings.write');

const view = ref<PipelineView | null>(null);
const loading = ref(true);
const activeScope = ref<string>('tools');
const saving = ref<string | null>(null);

// Local editable copy of each junction's ordered steps, keyed by hook method. Persisted on Save.
const edited = reactive<Record<string, PipelineStepView[]>>({});

const scopes = computed(() => view.value?.scopes ?? []);
const scope = computed(() => scopes.value.find((s) => s.key === activeScope.value) ?? null);

function rebuildEdited(v: PipelineView): void {
  for (const k of Object.keys(edited)) delete edited[k];
  for (const s of v.scopes) for (const p of s.points) edited[p.method] = p.steps.map((x) => ({ ...x }));
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const v = await api.get<PipelineView>('/api/pipeline');
    view.value = v;
    rebuildEdited(v);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : 'Could not load pipelines.');
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function serverSteps(method: string): PipelineStepView[] {
  for (const s of scopes.value) for (const p of s.points) if (p.method === method) return p.steps;
  return [];
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
function resetPoint(method: string): void {
  edited[method] = serverSteps(method).map((x) => ({ ...x }));
}
async function save(method: string): Promise<void> {
  saving.value = method;
  try {
    const steps = (edited[method] ?? []).map((s) => ({ pluginId: s.pluginId, enabled: s.enabled }));
    const v = await api.put<PipelineView>(`/api/pipeline/${method}`, { steps });
    view.value = v;
    rebuildEdited(v);
    toast.success('Pipeline saved.');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : 'Could not save pipeline.');
  } finally {
    saving.value = null;
  }
}

function caption(p: PipelinePointView): string {
  if (p.kind === 'list') return 'When a client lists what is available — steps can filter or annotate the list.';
  if (p.method === 'onResolveUser') return 'Right after sign-in — steps can remap the user or deny access.';
  if (p.kind === 'pre') return 'Before the request reaches the upstream — steps can transform inputs or deny the call.';
  return 'After the upstream responds — steps can transform what the client / LLM receives.';
}

// ─── Trace ───────────────────────────────────────────────────────────────────────────────────────
const traceFor = ref<string | null>(null);
const tracePayload = ref('');
const traceServer = ref('');
const traceTool = ref('');
const tracing = ref(false);
const traceResult = ref<PipelineTraceResult | null>(null);

// The sample is the RAW payload at that junction (the value the hook mutates): the list array for `list`,
// the arguments object for `pre`, the tool/resource/prompt result for `post`.
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
      toast.error('Sample payload is not valid JSON.');
      return;
    }
    // Unwrap the key the hook mutates so the sample maps to the right slot.
    const body: Record<string, unknown> = { payload, server: traceServer.value || undefined, tool: traceTool.value || undefined };
    traceResult.value = await api.post<PipelineTraceResult>(`/api/pipeline/${p.method}/trace`, body);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : 'Trace failed.');
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
  <div>
    <div class="topbar">
      <div>
        <h1>Pipelines</h1>
        <p class="muted">
          Compose the order in which hook plugins run at each MCP lifecycle junction. A request flows through
          these steps top-to-bottom; each can transform the payload or (where allowed) deny it.
        </p>
      </div>
    </div>

    <div v-if="loading" class="card"><p class="muted">Loading…</p></div>

    <template v-else>
      <!-- Scope tabs -->
      <div class="btn-row" style="margin-bottom: 1rem">
        <button
          v-for="s in scopes"
          :key="s.key"
          class="btn"
          :class="{ primary: s.key === activeScope }"
          @click="activeScope = s.key"
        >
          {{ s.label }}
        </button>
      </div>

      <div v-if="scope" class="scope-flow muted">
        <span v-for="(node, i) in scope.spine" :key="i">
          <span class="node">{{ node }}</span><span v-if="i < scope.spine.length - 1" class="arrow"> → </span>
        </span>
      </div>

      <!-- One card per junction -->
      <div v-for="p in scope?.points ?? []" :key="p.method" class="card junction">
        <div class="junction-head">
          <div>
            <h3>
              {{ p.label }}
              <span class="badge kind" :class="p.kind">{{ p.kind }}</span>
              <span v-if="p.canDeny" class="badge deny">can deny</span>
            </h3>
            <p class="muted small">{{ caption(p) }}</p>
          </div>
          <div class="btn-row">
            <button class="btn" @click="openTrace(p)">{{ traceFor === p.method ? 'Close trace' : 'Trace' }}</button>
            <button v-if="canWrite" class="btn" :disabled="!isDirty(p.method)" @click="resetPoint(p.method)">Reset</button>
            <button
              v-if="canWrite"
              class="btn primary"
              :disabled="!isDirty(p.method) || saving === p.method"
              @click="save(p.method)"
            >
              {{ saving === p.method ? 'Saving…' : 'Save order' }}
            </button>
          </div>
        </div>

        <div v-if="!(edited[p.method]?.length)" class="empty small">
          No plugin implements this hook yet. Install or enable a hook plugin to add steps here.
        </div>

        <ol v-else class="steps">
          <li v-for="(step, i) in edited[p.method]" :key="step.pluginId" class="step" :class="{ off: !step.enabled || !step.pluginEnabled }">
            <span class="pos">{{ i + 1 }}</span>
            <div class="reorder" v-if="canWrite">
              <button class="btn tiny" :disabled="i === 0" title="Move up" @click="move(p.method, i, -1)">▲</button>
              <button class="btn tiny" :disabled="i === edited[p.method].length - 1" title="Move down" @click="move(p.method, i, 1)">▼</button>
            </div>
            <div class="step-main">
              <div class="step-name">
                {{ step.name }}
                <span v-if="!step.pluginEnabled" class="badge disabled" title="This plugin is turned off on the Plugins screen">plugin off</span>
              </div>
              <div class="muted small" v-if="step.description">{{ step.description }}</div>
            </div>
            <label class="checkbox step-toggle" :title="'Run this plugin at this junction'">
              <input type="checkbox" :checked="step.enabled" :disabled="!canWrite" @change="toggleStep(p.method, i)" />
              <span>{{ step.enabled ? 'On' : 'Off' }}</span>
            </label>
          </li>
        </ol>

        <!-- Trace panel -->
        <div v-if="traceFor === p.method" class="trace">
          <p class="muted small">
            Runs the actual enabled steps on a sample payload you paste (synthetic input, admin-only). Note: a
            step may have side effects if the plugin does I/O.
          </p>
          <div class="trace-inputs">
            <textarea v-model="tracePayload" rows="4" spellcheck="false" placeholder="Sample payload (JSON)"></textarea>
            <div class="trace-hints" v-if="p.kind !== 'list' && p.method !== 'onResolveUser'">
              <input v-model="traceServer" placeholder="server (optional)" />
              <input v-model="traceTool" placeholder="tool/prompt (optional)" />
            </div>
            <button class="btn primary" :disabled="tracing" @click="runTrace(p)">{{ tracing ? 'Running…' : 'Run' }}</button>
          </div>

          <div v-if="traceResult" class="trace-out">
            <div v-if="traceResult.denied" class="alert error small">
              Denied by <strong>{{ traceResult.denied.pluginId }}</strong>: {{ traceResult.denied.reason }}
            </div>
            <div v-for="(t, i) in traceResult.steps" :key="i" class="trace-step">
              <div class="trace-step-head">
                <span class="pos">{{ i + 1 }}</span>
                <strong>{{ t.name }}</strong>
                <span v-if="t.denied" class="badge error">denied</span>
                <span v-else-if="t.error" class="badge error">error</span>
                <span v-else-if="t.changed" class="badge online">changed</span>
                <span v-else class="badge disabled">no change</span>
              </div>
              <div v-if="t.error" class="muted small">{{ t.error }}</div>
              <div v-else-if="t.changed" class="diff">
                <div><span class="muted small">before</span><pre>{{ pretty(t.before) }}</pre></div>
                <div><span class="muted small">after</span><pre>{{ pretty(t.after) }}</pre></div>
              </div>
            </div>
            <div class="trace-final">
              <span class="muted small">Result → {{ scope?.spine?.slice(-1)[0] }}</span>
              <pre>{{ pretty(traceResult.output) }}</pre>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.muted { color: var(--text-muted, #6b7280); }
.small { font-size: 0.85rem; }
.scope-flow { margin: 0 0 1rem; display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; }
.scope-flow .node { padding: 0.15rem 0.5rem; border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius, 6px); }
.scope-flow .arrow { opacity: 0.6; }

.junction { margin-bottom: 1rem; }
.junction-head { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; flex-wrap: wrap; }
.junction-head h3 { margin: 0 0 0.25rem; display: flex; align-items: center; gap: 0.4rem; }

.badge.kind { text-transform: capitalize; }
.badge.kind.pre { background: var(--warning-bg, #fef3c7); }
.badge.kind.post { background: var(--brand-bg, #e0e7ff); }
.badge.deny { background: var(--danger-bg, #fee2e2); }

.steps { list-style: none; margin: 0.75rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.step { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0.6rem; border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius, 6px); background: var(--surface-2, #fafafa); }
.step.off { opacity: 0.55; }
.step .pos { min-width: 1.4rem; height: 1.4rem; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: var(--brand, #4f46e5); color: #fff; font-size: 0.8rem; }
.reorder { display: flex; flex-direction: column; gap: 2px; }
.btn.tiny { padding: 0 0.4rem; line-height: 1.2; font-size: 0.75rem; }
.step-main { flex: 1; min-width: 0; }
.step-name { font-weight: 600; display: flex; align-items: center; gap: 0.4rem; }
.step-toggle { margin: 0; white-space: nowrap; }

.trace { margin-top: 1rem; border-top: 1px dashed var(--border, #e5e7eb); padding-top: 0.75rem; }
.trace-inputs { display: flex; flex-direction: column; gap: 0.5rem; }
.trace-inputs textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 0.8rem; }
.trace-hints { display: flex; gap: 0.5rem; }
.trace-hints input { flex: 1; }
.trace-out { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
.trace-step { border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius, 6px); padding: 0.5rem; }
.trace-step-head { display: flex; align-items: center; gap: 0.4rem; }
.diff { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.4rem; }
.diff pre, .trace-final pre { margin: 0.2rem 0 0; padding: 0.5rem; background: var(--surface-2, #f6f6f6); border-radius: var(--radius, 6px); overflow: auto; font-size: 0.75rem; max-height: 220px; }
</style>
