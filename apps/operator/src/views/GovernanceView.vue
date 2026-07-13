<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api/client';
import { useEventStream } from '../lib/events';
import { useAuthStore } from '../stores/auth';

type Tab = 'approvals' | 'changes' | 'usage';
const { t } = useI18n();
const tab = ref<Tab>('approvals');
const auth = useAuthStore();

interface Approval {
  id: string;
  serverName: string;
  toolName: string;
  actorEmail: string | null;
  argsPreview: string;
  createdAt: string;
  mcpEndpointId: string | null;
}
interface ToolChange {
  id: string;
  serverId: string;
  toolName: string;
  approvedBy: string;
  approvedAt: string;
  approvedDesc: string;
  pendingDesc: string | null;
  updatedAt: string;
}
interface UsageRow {
  scopeType: 'global' | 'user' | 'endpoint' | 'model';
  scopeId: string;
  name?: string; // resolved display name (user email / endpoint name) when available
  calls: number;
  inputTokens: number;
  outputTokens: number;
}
interface Budgets {
  dailyTokenBudget: number;
  dailyCallBudget: number;
  budgetAction: string;
}

const approvals = ref<Approval[]>([]);
const changes = ref<ToolChange[]>([]);
const usage = ref<UsageRow[]>([]);
const budgets = ref<Budgets>({ dailyTokenBudget: 0, dailyCallBudget: 0, budgetAction: 'warn' });
const error = ref('');
const busy = ref<string>('');

const canWrite = computed(() => auth.can('servers.write'));

async function loadApprovals() {
  try {
    approvals.value = (await api.get<{ approvals: Approval[] }>('/api/approvals')).approvals;
  } catch (e) {
    if (e instanceof ApiError && e.status !== 403) error.value = e.message;
  }
}
async function loadChanges() {
  try {
    changes.value = (await api.get<{ changes: ToolChange[] }>('/api/tool-changes')).changes;
  } catch (e) {
    if (e instanceof ApiError && e.status !== 403) error.value = e.message;
  }
}
async function loadUsage() {
  try {
    const r = await api.get<{ usage: UsageRow[]; budgets: Budgets }>('/api/usage');
    usage.value = r.usage;
    budgets.value = r.budgets;
  } catch (e) {
    if (e instanceof ApiError && e.status !== 403) error.value = e.message;
  }
}

async function decide(a: Approval, approve: boolean) {
  error.value = '';
  let reason = '';
  if (!approve) reason = window.prompt(t('governanceView.denialReasonPrompt')) ?? '';
  busy.value = a.id;
  try {
    await api.post(`/api/approvals/${encodeURIComponent(a.id)}/decision`, { approve, reason });
    await loadApprovals();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('governanceView.errResolveRequest');
  } finally {
    busy.value = '';
  }
}

async function approveChange(c: ToolChange) {
  error.value = '';
  if (!window.confirm(t('governanceView.reapproveConfirm', { tool: c.toolName }))) return;
  busy.value = c.id;
  try {
    await api.post(`/api/tool-changes/${encodeURIComponent(c.id)}/approve`);
    await loadChanges();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('governanceView.errApproveChange');
  } finally {
    busy.value = '';
  }
}

function ago(iso: string): string {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return t('governanceView.agoSeconds', { n: s });
  if (s < 3600) return t('governanceView.agoMinutes', { n: Math.floor(s / 60) });
  if (s < 86400) return t('governanceView.agoHours', { n: Math.floor(s / 3600) });
  return t('governanceView.agoDays', { n: Math.floor(s / 86400) });
}
const fmt = (n: number) => n.toLocaleString();
const scopeLabel = computed<Record<string, string>>(() => ({
  global: t('governanceView.scopeGlobal'),
  user: t('governanceView.scopeUser'),
  endpoint: t('governanceView.scopeEndpoint'),
  model: t('governanceView.scopeModel'),
}));

const global = computed(() => usage.value.find((u) => u.scopeType === 'global'));
const byScope = computed(() => usage.value.filter((u) => u.scopeType !== 'global'));

onMounted(() => {
  loadApprovals();
  loadChanges();
  loadUsage();
});
// Live-refresh the approvals queue as calls are held/resolved anywhere in the cluster.
useEventStream((type) => {
  if (type === 'approvals') loadApprovals();
  if (type === 'registry') loadChanges();
});
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>{{ t('governanceView.title') }}</h1>
        <p class="muted">{{ t('governanceView.subtitle') }}</p>
      </div>
    </header>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'approvals' }" @click="tab = 'approvals'">
        {{ t('governanceView.tabApprovals') }} <span v-if="approvals.length" class="pill">{{ approvals.length }}</span>
      </button>
      <button class="tab" :class="{ active: tab === 'changes' }" @click="tab = 'changes'">
        {{ t('governanceView.tabChanges') }} <span v-if="changes.length" class="pill warn">{{ changes.length }}</span>
      </button>
      <button class="tab" :class="{ active: tab === 'usage' }" @click="tab = 'usage'">{{ t('governanceView.tabUsage') }}</button>
    </div>

    <div v-if="error" class="alert error">{{ error }}</div>

    <!-- ── Approvals ── -->
    <section v-if="tab === 'approvals'">
      <p class="muted small">{{ t('governanceView.approvalsIntro') }}</p>
      <table v-if="approvals.length" class="tbl">
        <thead>
          <tr><th>{{ t('governanceView.colTool') }}</th><th>{{ t('governanceView.colServer') }}</th><th>{{ t('governanceView.colRequestedBy') }}</th><th>{{ t('governanceView.colArguments') }}</th><th>{{ t('governanceView.colAge') }}</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="a in approvals" :key="a.id">
            <td class="mono">{{ a.toolName }}</td>
            <td>{{ a.serverName }}</td>
            <td>{{ a.actorEmail || '—' }}</td>
            <td><code class="args">{{ a.argsPreview }}</code></td>
            <td class="muted">{{ ago(a.createdAt) }}</td>
            <td class="right nowrap">
              <button class="btn sm" :disabled="!canWrite || busy === a.id" @click="decide(a, true)">{{ t('governanceView.btnApprove') }}</button>
              <button class="btn sm danger" :disabled="!canWrite || busy === a.id" @click="decide(a, false)">{{ t('governanceView.btnDeny') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">{{ t('governanceView.emptyApprovals') }}</p>
    </section>

    <!-- ── Tool changes (rug-pull) ── -->
    <section v-if="tab === 'changes'">
      <p class="muted small">{{ t('governanceView.changesIntroBefore') }}<code>enforce</code>{{ t('governanceView.changesIntroAfter') }}</p>
      <table v-if="changes.length" class="tbl">
        <thead>
          <tr><th>{{ t('governanceView.colTool') }}</th><th>{{ t('governanceView.colApprovedDef') }}</th><th>{{ t('governanceView.colNewDef') }}</th><th>{{ t('governanceView.colBaselined') }}</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="c in changes" :key="c.id">
            <td class="mono">{{ c.toolName }}</td>
            <td><code class="args">{{ c.approvedDesc || '—' }}</code></td>
            <td><code class="args new">{{ c.pendingDesc || '—' }}</code></td>
            <td class="muted small">{{ c.approvedBy }}<br />{{ ago(c.approvedAt) }}</td>
            <td class="right nowrap">
              <button class="btn sm" :disabled="!canWrite || busy === c.id" @click="approveChange(c)">{{ t('governanceView.btnReapprove') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">{{ t('governanceView.emptyChanges') }}</p>
    </section>

    <!-- ── Usage / cost ── -->
    <section v-if="tab === 'usage'">
      <div class="cards">
        <div class="kpi">
          <div class="kpi-label">{{ t('governanceView.kpiCallsToday') }}</div>
          <div class="kpi-val">{{ fmt(global?.calls ?? 0) }}<span v-if="budgets.dailyCallBudget" class="kpi-of"> / {{ fmt(budgets.dailyCallBudget) }}</span></div>
        </div>
        <div class="kpi">
          <div class="kpi-label">{{ t('governanceView.kpiTokensToday') }}</div>
          <div class="kpi-val">{{ fmt((global?.inputTokens ?? 0) + (global?.outputTokens ?? 0)) }}<span v-if="budgets.dailyTokenBudget" class="kpi-of"> / {{ fmt(budgets.dailyTokenBudget) }}</span></div>
        </div>
        <div class="kpi">
          <div class="kpi-label">{{ t('governanceView.kpiOnBudgetExceed') }}</div>
          <div class="kpi-val cap">{{ budgets.budgetAction }}</div>
        </div>
      </div>
      <p class="muted small">{{ t('governanceView.usageNoteBefore') }}<RouterLink to="/settings">{{ t('governanceView.usageSettingsLink') }}</RouterLink>.</p>
      <table v-if="byScope.length" class="tbl">
        <thead>
          <tr><th>{{ t('governanceView.colScope') }}</th><th>{{ t('governanceView.colName') }}</th><th class="right">{{ t('governanceView.colCalls') }}</th><th class="right">{{ t('governanceView.colInputTokens') }}</th><th class="right">{{ t('governanceView.colOutputTokens') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in byScope" :key="u.scopeType + u.scopeId">
            <td>{{ scopeLabel[u.scopeType] }}</td>
            <td>
              <span v-if="u.name">{{ u.name }}</span>
              <span v-else class="mono small" :title="u.scopeId">{{ u.scopeId }}</span>
            </td>
            <td class="right">{{ fmt(u.calls) }}</td>
            <td class="right">{{ fmt(u.inputTokens) }}</td>
            <td class="right">{{ fmt(u.outputTokens) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">{{ t('governanceView.emptyUsage') }}</p>
    </section>
  </div>
</template>

<style scoped>
.page-head {
  margin-bottom: 1rem;
}
.tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid var(--border, #e5e7eb);
  margin-bottom: 1rem;
}
.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0.55rem 0.9rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-2, #6b7280);
  cursor: pointer;
}
.tab.active {
  color: var(--brand, #c9892c);
  border-bottom-color: var(--brand, #c9892c);
}
.pill {
  display: inline-block;
  min-width: 1.1rem;
  text-align: center;
  font-size: 0.7rem;
  font-weight: 700;
  border-radius: 999px;
  padding: 0 0.35rem;
  background: var(--brand, #c9892c);
  color: #fff;
}
.pill.warn {
  background: #d97706;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.tbl th,
.tbl td {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--border, #e5e7eb);
  vertical-align: top;
}
.tbl th {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3, #9ca3af);
}
.right {
  text-align: right;
}
.nowrap {
  white-space: nowrap;
}
.mono {
  font-family: ui-monospace, monospace;
}
.small {
  font-size: 0.78rem;
}
.args {
  display: inline-block;
  max-width: 30ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.76rem;
  color: var(--text-2, #6b7280);
}
.args.new {
  color: #b45309;
}
.btn.sm {
  padding: 0.25rem 0.6rem;
  font-size: 0.78rem;
  margin-left: 0.3rem;
}
.btn.danger {
  color: #b91c1c;
}
.empty {
  color: var(--text-3, #9ca3af);
  text-align: center;
  padding: 2rem;
}
.cards {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}
.kpi {
  flex: 1 1 180px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  padding: 0.75rem 0.9rem;
}
.kpi-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3, #9ca3af);
}
.kpi-val {
  font-size: 1.4rem;
  font-weight: 700;
  margin-top: 0.2rem;
}
.kpi-of {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-3, #9ca3af);
}
.cap {
  text-transform: capitalize;
}
</style>
