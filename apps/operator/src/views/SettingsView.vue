<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppSettings, SettingGroupMeta, SettingFieldMeta } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useBootstrapStore } from '../stores/bootstrap';

const { t } = useI18n();
const auth = useAuthStore();
const bootstrap = useBootstrapStore();
const model = ref<AppSettings | null>(null);
const ui = ref<SettingGroupMeta[]>([]);
const loading = ref(true);
const saving = ref(false);
const message = ref('');
const error = ref('');

const canWrite = auth.can('settings.write');

const SESSIONS_KEY = '__sessions__';
const activeKey = ref<string>('');
const search = ref('');

interface SessionInfo {
  jti: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
  current: boolean;
}
const sessions = ref<SessionInfo[]>([]);
async function loadSessions() {
  sessions.value = (await api.get<{ sessions: SessionInfo[] }>('/api/auth/sessions')).sessions;
}
async function revokeSession(jti: string) {
  await api.del(`/api/auth/sessions/${jti}`);
  await loadSessions();
}
async function revokeOthers() {
  await api.post('/api/auth/sessions/revoke-others', {});
  await loadSessions();
}
const fmtTime = (s: string) => (s ? new Date(s).toLocaleString() : '—');

onMounted(async () => {
  try {
    const res = await api.get<{ settings: AppSettings; ui: SettingGroupMeta[] }>('/api/settings');
    model.value = res.settings;
    ui.value = res.ui;
    activeKey.value = res.ui[0]?.key ?? '';
    await loadSessions();
  } finally {
    loading.value = false;
  }
});

// ── Search across every field (label/help) + group name, so a setting is findable without knowing its section.
const q = computed(() => search.value.trim().toLowerCase());
const matches = (g: SettingGroupMeta, f: SettingFieldMeta): boolean => {
  const s = q.value;
  return !s || f.label.toLowerCase().includes(s) || (f.help ?? '').toLowerCase().includes(s) || g.label.toLowerCase().includes(s);
};
/** Groups shown in the content pane: the active group normally, or every group with a matching field while searching. */
const shownGroups = computed<Array<SettingGroupMeta>>(() => {
  if (q.value) {
    return ui.value
      .map((g) => ({ ...g, fields: g.fields.filter((f) => matches(g, f)) }))
      .filter((g) => g.fields.length > 0);
  }
  if (activeKey.value === SESSIONS_KEY) return [];
  const g = ui.value.find((x) => x.key === activeKey.value);
  return g ? [g] : [];
});
const showSessions = computed(() => !q.value && activeKey.value === SESSIONS_KEY);

function pick(key: string) {
  activeKey.value = key;
  search.value = '';
}

// ── SETTINGS_UI metadata (labels/help) is English; translate it via 'settingsUi' keys, English as fallback.
const groupLabel = (g: SettingGroupMeta): string => t('settingsUi.group_' + g.key, g.label);
const groupDesc = (g: SettingGroupMeta): string => (g.description ? t('settingsUi.group_' + g.key + '_desc', g.description) : '');
const fieldKey = (f: SettingFieldMeta): string => f.path.replace(/\./g, '_');
const fieldLabel = (f: SettingFieldMeta): string => t('settingsUi.' + fieldKey(f), f.label);
const fieldHelp = (f: SettingFieldMeta): string => (f.help ? t('settingsUi.' + fieldKey(f) + '_help', f.help) : '');

function getVal(path: string): any {
  return path.split('.').reduce((acc: any, k) => (acc == null ? acc : acc[k]), model.value);
}
function setVal(path: string, value: any): void {
  const keys = path.split('.');
  let obj: any = model.value;
  for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
  obj[keys[keys.length - 1]] = value;
}
function arrText(path: string): string {
  const v = getVal(path);
  return Array.isArray(v) ? v.join('\n') : '';
}
function setArr(path: string, text: string): void {
  setVal(path, text.split('\n').map((s) => s.trim()).filter(Boolean));
}

async function save() {
  if (!model.value) return;
  saving.value = true;
  message.value = '';
  error.value = '';
  try {
    const res = await api.put<{ settings: AppSettings }>('/api/settings', model.value);
    model.value = res.settings;
    message.value = t('settingsView.settingsSaved');
    await bootstrap.load(true);
    setTimeout(() => (message.value = ''), 3000);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('settingsView.saveError');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="topbar">
    <h1>{{ t('settingsView.title') }}</h1>
    <button v-if="canWrite" class="btn primary" :disabled="saving" @click="save">
      {{ saving ? t('settingsView.saving') : t('settingsView.saveChanges') }}
    </button>
  </div>
  <p class="muted intro">{{ t('settingsView.intro') }}</p>

  <div v-if="message" class="alert success">{{ message }}</div>
  <div v-if="error" class="alert error">{{ error }}</div>

  <p v-if="loading" class="muted">{{ t('settingsView.loading') }}</p>

  <div v-else-if="model" class="settings">
    <!-- ── Section nav ── -->
    <aside class="settings-nav">
      <input v-model="search" class="nav-search" :placeholder="t('settingsView.searchPlaceholder')" />
      <nav>
        <button
          v-for="g in ui"
          :key="g.key"
          class="nav-item"
          :class="{ active: !search && activeKey === g.key }"
          @click="pick(g.key)"
        >
          {{ groupLabel(g) }}
        </button>
        <button class="nav-item" :class="{ active: !search && activeKey === SESSIONS_KEY }" @click="pick(SESSIONS_KEY)">
          {{ t('settingsView.yourSessions') }}
        </button>
      </nav>
    </aside>

    <!-- ── Content pane ── -->
    <div class="settings-pane">
      <p v-if="search && shownGroups.length === 0" class="muted empty">{{ t('settingsView.noMatch', { query: search }) }}</p>

      <section v-for="group in shownGroups" :key="group.key" class="pane-section">
        <header class="pane-head">
          <h3>{{ groupLabel(group) }}</h3>
          <p v-if="group.description && !search" class="muted">{{ groupDesc(group) }}</p>
        </header>

        <div v-for="f in group.fields" :key="f.path" class="field">
          <label>{{ fieldLabel(f) }}</label>

          <div v-if="f.control === 'boolean'" class="checkbox">
            <input
              type="checkbox"
              :checked="getVal(f.path)"
              :disabled="!canWrite"
              @change="setVal(f.path, ($event.target as HTMLInputElement).checked)"
            />
            <span class="muted">{{ getVal(f.path) ? t('settingsView.enabled') : t('settingsView.disabled') }}</span>
          </div>

          <input
            v-else-if="f.control === 'number'"
            type="number"
            :value="getVal(f.path)"
            :disabled="!canWrite"
            @input="setVal(f.path, Number(($event.target as HTMLInputElement).value))"
          />

          <select
            v-else-if="f.control === 'enum'"
            :value="getVal(f.path)"
            :disabled="!canWrite"
            @change="setVal(f.path, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="opt in f.options" :key="opt" :value="opt">{{ opt }}</option>
          </select>

          <textarea
            v-else-if="f.control === 'string[]'"
            rows="3"
            :value="arrText(f.path)"
            :disabled="!canWrite"
            :placeholder="t('settingsView.onePerLine')"
            @input="setArr(f.path, ($event.target as HTMLTextAreaElement).value)"
          ></textarea>

          <input
            v-else
            :type="f.secret ? 'password' : 'text'"
            :value="getVal(f.path)"
            :disabled="!canWrite"
            @input="setVal(f.path, ($event.target as HTMLInputElement).value)"
          />

          <small v-if="f.help" class="muted field-help">{{ fieldHelp(f) }}</small>
        </div>
      </section>

      <!-- ── Sessions section ── -->
      <section v-if="showSessions" class="pane-section">
        <header class="pane-head row spread">
          <h3>{{ t('settingsView.activeSessions') }}</h3>
          <button v-if="sessions.length > 1" class="btn" @click="revokeOthers">{{ t('settingsView.logOutOthers') }}</button>
        </header>
        <p class="muted">{{ t('settingsView.sessionsHelp') }}</p>
        <table v-if="sessions.length">
          <thead>
            <tr><th>{{ t('settingsView.colDevice') }}</th><th>{{ t('settingsView.colIp') }}</th><th>{{ t('settingsView.colLastActive') }}</th><th>{{ t('settingsView.colSignedIn') }}</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="ss in sessions" :key="ss.jti">
              <td>
                <small>{{ ss.userAgent || t('settingsView.unknownDevice') }}</small>
                <span v-if="ss.current" class="badge online" style="margin-left: 0.4rem">{{ t('settingsView.thisDevice') }}</span>
              </td>
              <td><small class="muted">{{ ss.ip || '—' }}</small></td>
              <td><small class="muted">{{ fmtTime(ss.lastSeenAt) }}</small></td>
              <td><small class="muted">{{ fmtTime(ss.createdAt) }}</small></td>
              <td>
                <button v-if="!ss.current" class="btn danger" @click="revokeSession(ss.jti)">{{ t('settingsView.revoke') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.intro {
  margin-top: -0.5rem;
}
.settings {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 1.25rem;
  align-items: start;
  margin-top: 1rem;
}
.settings-nav {
  position: sticky;
  top: 1rem;
}
.nav-search {
  width: 100%;
  margin-bottom: 0.6rem;
}
.settings-nav nav {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.nav-item {
  text-align: left;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  padding: 0.45rem 0.7rem;
  border-radius: var(--radius-md, 8px);
  color: var(--text-muted);
  font-size: 0.9rem;
  cursor: pointer;
}
.nav-item:hover {
  background: var(--hover);
  color: var(--text);
}
.nav-item.active {
  background: var(--brand-soft, var(--hover));
  color: var(--brand, var(--accent));
  border-left-color: var(--brand, var(--accent));
  font-weight: 600;
}
.settings-pane {
  min-width: 0;
}
.pane-section {
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px);
  background: var(--bg-surface);
  padding: 1.1rem 1.25rem;
  margin-bottom: 1rem;
}
.pane-section:last-child {
  margin-bottom: 0;
}
.pane-head {
  margin-bottom: 0.75rem;
}
.pane-head h3 {
  margin: 0;
}
.pane-head p {
  margin: 0.25rem 0 0;
  font-size: 0.85rem;
}
.field-help {
  display: block;
  margin-top: 0.3rem;
}
.empty {
  padding: 2rem;
  text-align: center;
}

@media (max-width: 760px) {
  .settings {
    grid-template-columns: 1fr;
  }
  .settings-nav {
    position: static;
  }
  .settings-nav nav {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
}
</style>
