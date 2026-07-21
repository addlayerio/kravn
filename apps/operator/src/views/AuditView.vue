<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import { RefreshCw, ShieldCheck, ChevronLeft, ChevronRight, X, Eye } from 'lucide-vue-next';

/** One row of the tamper-evident audit trail (mirrors the gateway's AuditRecord). */
interface AuditEvent {
  seq?: number;
  id: string;
  ts: string;
  category: string;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  ip: string | null;
  details: string;
  prevHash: string;
  hash: string;
}
interface VerifyResult {
  ok: boolean;
  checked: number;
  total: number;
  brokenAt?: string;
}

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

// Filter options come from the DATA (GET /api/audit/facets), not a hardcoded union: only a few of the
// declared categories are ever emitted, so a static list would offer filters that always return zero rows.
const OUTCOMES = ['success', 'failure'] as const;
const PAGE_SIZE = 100;
const facets = ref<{ categories: string[]; resourceTypes: string[] }>({ categories: [], resourceTypes: [] });

const events = ref<AuditEvent[]>([]);
const total = ref(0);
const offset = ref(0);
const loading = ref(false);
const expanded = ref<string | null>(null);
const verifying = ref(false);
const verdict = ref<VerifyResult | null>(null);

const f = reactive({ actor: '', actorMode: '', category: '', action: '', resource: '', resourceType: '', outcome: '', from: '', to: '' });

const hasFilters = computed(() => Object.values(f).some((v) => String(v).trim() !== ''));
const rangeLabel = computed(() => {
  if (!total.value) return '0';
  const first = offset.value + 1;
  const last = Math.min(offset.value + events.value.length, total.value);
  return `${first}–${last} / ${total.value}`;
});

// Dates are sent as plain YYYY-MM-DD and interpreted by the server as UTC days (the trail is UTC). The
// filter labels say UTC so an auditor is never shown a window shifted by their local offset.

async function load(): Promise<void> {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    if (f.actor.trim()) params.set('actor', f.actor.trim());
    if (f.actorMode) params.set('actorMode', f.actorMode);
    if (f.category) params.set('category', f.category);
    if (f.action.trim()) params.set('action', f.action.trim());
    if (f.resource.trim()) params.set('resource', f.resource.trim());
    if (f.resourceType) params.set('resourceType', f.resourceType);
    if (f.outcome) params.set('outcome', f.outcome);
    if (f.from.trim()) params.set('from', f.from.trim());
    if (f.to.trim()) params.set('to', f.to.trim());
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset.value));
    const res = await api.get<{ events: AuditEvent[]; total: number; limit: number; offset: number }>(`/api/audit?${params.toString()}`);
    events.value = res.events;
    total.value = res.total;
    offset.value = res.offset; // trust the server's clamped value
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('auditView.couldNotLoad'));
  } finally {
    loading.value = false;
  }
}

/** Any filter change resets to the first page — otherwise you can land on an empty offset. */
function applyFilters(): void {
  offset.value = 0;
  void load();
}
function clearFilters(): void {
  Object.assign(f, { actor: '', actorMode: '', category: '', action: '', resource: '', resourceType: '', outcome: '', from: '', to: '' });
  applyFilters();
}
function prevPage(): void {
  offset.value = Math.max(0, offset.value - PAGE_SIZE);
  void load();
}
function nextPage(): void {
  if (offset.value + PAGE_SIZE >= total.value) return;
  offset.value += PAGE_SIZE;
  void load();
}

async function verifyChain(): Promise<void> {
  verifying.value = true;
  verdict.value = null;
  try {
    verdict.value = await api.post<VerifyResult>('/api/audit/verify', { limit: 1000 });
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('auditView.couldNotVerify'));
  } finally {
    verifying.value = false;
  }
}

/** Pretty-print the redacted JSON details, falling back to the raw string if it isn't JSON. */
function prettyDetails(d: string): string {
  try {
    return JSON.stringify(JSON.parse(d), null, 2);
  } catch {
    return d;
  }
}

onMounted(async () => {
  await load();
  try {
    facets.value = await api.get<{ categories: string[]; resourceTypes: string[] }>('/api/audit/facets');
  } catch {
    // Facets are a convenience — the screen still works with free-text filters if they fail.
  }
});
</script>

<template>
  <div class="topbar">
    <h1>{{ t('auditView.title') }}</h1>
    <div class="btn-row">
      <button class="btn" :disabled="loading" @click="load">
        <RefreshCw :size="16" :stroke-width="2" /> {{ t('auditView.refresh') }}
      </button>
      <button v-if="auth.can('audit.read')" class="btn" :disabled="verifying" @click="verifyChain">
        <ShieldCheck :size="16" :stroke-width="2" /> {{ verifying ? t('auditView.verifying') : t('auditView.verifyChain') }}
      </button>
    </div>
  </div>

  <p class="muted">{{ t('auditView.subtitle') }}</p>

  <!-- Tamper-evidence verdict: recomputes the hash chain server-side over the recent window. -->
  <div v-if="verdict" class="card" :class="verdict.ok ? 'ok' : 'bad'" style="margin-bottom: 1rem">
    <strong>{{ verdict.ok ? t('auditView.chainIntact') : t('auditView.chainBroken') }}</strong>
    <small class="muted"> · {{ t('auditView.checkedEvents', { n: verdict.checked, total: verdict.total }) }}</small>
    <div v-if="!verdict.ok && verdict.brokenAt"><small class="muted">{{ t('auditView.brokenAt', { id: verdict.brokenAt }) }}</small></div>
  </div>

  <div class="card">
    <div class="filters">
      <input v-model="f.actor" :placeholder="t('auditView.filterActor')" @keydown.enter="applyFilters" />
      <!-- System events (rug-pull, budget breaches) carry no actor; without this they'd vanish behind an actor filter. -->
      <select v-model="f.actorMode">
        <option value="">{{ t('auditView.actorAny') }}</option>
        <option value="user">{{ t('auditView.actorUser') }}</option>
        <option value="system">{{ t('auditView.actorSystem') }}</option>
      </select>
      <select v-model="f.category">
        <option value="">{{ t('auditView.allCategories') }}</option>
        <option v-for="c in facets.categories" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-if="facets.resourceTypes.length" v-model="f.resourceType">
        <option value="">{{ t('auditView.allResourceTypes') }}</option>
        <option v-for="r in facets.resourceTypes" :key="r" :value="r">{{ r }}</option>
      </select>
      <input v-model="f.action" :placeholder="t('auditView.filterAction')" @keydown.enter="applyFilters" />
      <input v-model="f.resource" :placeholder="t('auditView.filterResource')" @keydown.enter="applyFilters" />
      <select v-model="f.outcome">
        <option value="">{{ t('auditView.allOutcomes') }}</option>
        <option v-for="o in OUTCOMES" :key="o" :value="o">{{ o }}</option>
      </select>
      <input v-model="f.from" type="date" :title="t('auditView.filterFrom')" />
      <input v-model="f.to" type="date" :title="t('auditView.filterTo')" />
      <small class="muted">{{ t('auditView.utcNote') }}</small>
      <button class="btn primary" @click="applyFilters">{{ t('auditView.apply') }}</button>
      <button v-if="hasFilters" class="btn icon" :title="t('auditView.clear')" :aria-label="t('auditView.clear')" @click="clearFilters">
        <X :size="16" :stroke-width="2" />
      </button>
    </div>

    <p v-if="loading" class="muted">{{ t('auditView.loading') }}</p>
    <div v-else-if="events.length === 0" class="empty">{{ hasFilters ? t('auditView.emptyFiltered') : t('auditView.empty') }}</div>
    <table v-else>
      <thead>
        <tr>
          <th>{{ t('auditView.colTime') }}</th>
          <th>{{ t('auditView.colActor') }}</th>
          <th>{{ t('auditView.colCategory') }}</th>
          <th>{{ t('auditView.colAction') }}</th>
          <th>{{ t('auditView.colResource') }}</th>
          <th>{{ t('auditView.colOutcome') }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="e in events" :key="e.id">
          <tr>
            <td><small class="muted" style="font-family: ui-monospace, monospace">{{ e.ts }}</small></td>
            <td>
              <div>{{ e.actorEmail || e.actorId || t('auditView.systemActor') }}</div>
              <small v-if="e.actorRole" class="muted">{{ e.actorRole }}</small>
            </td>
            <td><span class="badge">{{ e.category }}</span></td>
            <td>{{ e.action }}</td>
            <td>
              <small class="muted">{{ e.resourceType || '' }}</small>
              <div v-if="e.resourceId">{{ e.resourceId }}</div>
            </td>
            <td><span class="badge" :class="e.outcome === 'success' ? 'online' : 'error'">{{ e.outcome }}</span></td>
            <td class="actions-cell">
              <button class="btn icon" :title="t('auditView.details')" :aria-label="t('auditView.details')" @click="expanded = expanded === e.id ? null : e.id"><Eye :size="16" :stroke-width="2" /></button>
            </td>
          </tr>
          <tr v-if="expanded === e.id">
            <td colspan="7">
              <pre class="details">{{ prettyDetails(e.details) }}</pre>
              <small class="muted" style="font-family: ui-monospace, monospace">
                {{ t('auditView.detailIp', { ip: e.ip || '—' }) }} · {{ t('auditView.detailHash', { hash: e.hash.slice(0, 16) }) }}
              </small>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <div class="btn-row" style="justify-content: flex-end; align-items: center; margin-top: 0.75rem">
      <small class="muted">{{ rangeLabel }}</small>
      <button class="btn icon" :disabled="offset === 0 || loading" :title="t('auditView.prev')" :aria-label="t('auditView.prev')" @click="prevPage">
        <ChevronLeft :size="16" :stroke-width="2" />
      </button>
      <button class="btn icon" :disabled="offset + events.length >= total || loading" :title="t('auditView.next')" :aria-label="t('auditView.next')" @click="nextPage">
        <ChevronRight :size="16" :stroke-width="2" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 1rem;
}
.filters input[type='text'],
.filters input:not([type]),
.filters select {
  min-width: 150px;
}
.details {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
  font-size: 12px;
  margin: 0 0 0.4rem;
}
.card.ok {
  border-color: var(--success, var(--border));
}
.card.bad {
  border-color: var(--danger, var(--border));
}
</style>
