<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Team, TeamMember, User } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import { Users, KeyRound, Pencil, Trash2, X } from 'lucide-vue-next';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();
const canWrite = auth.can('teams.write');

const teams = ref<Team[]>([]);
const loading = ref(true);

const showTeam = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({ name: '', description: '' });
const saving = ref(false);
const error = ref('');

const showMembers = ref(false);
const membersTeam = ref<Team | null>(null);
const members = ref<TeamMember[]>([]);
const allUsers = ref<User[]>([]);
const addUserId = ref('');
const addRole = ref<'owner' | 'member'>('member');

async function load() {
  loading.value = true;
  try {
    teams.value = (await api.get<{ teams: Team[] }>('/api/teams')).teams;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openCreate() {
  form.name = '';
  form.description = '';
  editingId.value = null;
  error.value = '';
  showTeam.value = true;
}
function openEdit(team: Team) {
  form.name = team.name;
  form.description = team.description;
  editingId.value = team.id;
  error.value = '';
  showTeam.value = true;
}
async function save() {
  error.value = '';
  saving.value = true;
  try {
    if (editingId.value) await api.patch(`/api/teams/${editingId.value}`, { ...form });
    else await api.post('/api/teams', { ...form });
    showTeam.value = false;
    toast.success(editingId.value ? t('teamsView.teamUpdated') : t('teamsView.teamCreated'));
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('teamsView.saveFailed');
  } finally {
    saving.value = false;
  }
}
async function remove(team: Team) {
  if (!confirm(t('teamsView.deleteTeamConfirm', { name: team.name }))) return;
  await api.del(`/api/teams/${team.id}`);
  toast.success(t('teamsView.teamDeleted'));
  await load();
}

async function openMembers(team: Team) {
  membersTeam.value = team;
  addUserId.value = '';
  addRole.value = 'member';
  showMembers.value = true;
  const [m, u] = await Promise.all([
    api.get<{ members: TeamMember[] }>(`/api/teams/${team.id}/members`),
    api.get<{ users: User[] }>('/api/users').catch(() => ({ users: [] })),
  ]);
  members.value = m.members;
  allUsers.value = u.users;
}
async function addMember() {
  if (!membersTeam.value || !addUserId.value) return;
  try {
    const res = await api.post<{ members: TeamMember[] }>(`/api/teams/${membersTeam.value.id}/members`, {
      userId: addUserId.value,
      role: addRole.value,
    });
    members.value = res.members;
    addUserId.value = '';
    toast.success(t('teamsView.memberAdded'));
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('teamsView.memberAddFailed'));
  }
}
async function removeMember(m: TeamMember) {
  if (!membersTeam.value) return;
  await api.del(`/api/teams/${membersTeam.value.id}/members/${m.userId}`);
  members.value = members.value.filter((x) => x.userId !== m.userId);
  toast.success(t('teamsView.memberRemoved'));
  await load();
}

// ─── MCP access (which MCP endpoints + which of their tools this team may use) ───────────────────
interface ToolLite { id: string; name: string; serverId: string }
interface ServerAccess {
  id: string; name: string; slug: string; access: string; enabled: boolean;
  granted: boolean; allTools: boolean; toolIds: string[]; tools: ToolLite[];
}

const showAccess = ref(false);
const accessTeam = ref<Team | null>(null);
const accessServers = ref<ServerAccess[]>([]);
const accessLoading = ref(false);
const accessBusy = ref<string | null>(null); // id of the server currently saving
// UI-only view mode per server: 'subset' lets the user open the tool list and pick tools even before any
// are selected (an empty subset persists server-side as "all", so we can't derive the mode from that alone).
const toolMode = reactive<Record<string, 'all' | 'subset'>>({});
function displayMode(vs: ServerAccess): 'all' | 'subset' {
  return toolMode[vs.id] ?? (vs.allTools ? 'all' : 'subset');
}

async function openAccess(team: Team) {
  accessTeam.value = team;
  showAccess.value = true;
  accessServers.value = [];
  Object.keys(toolMode).forEach((k) => delete toolMode[k]); // derive mode from freshly-loaded state
  accessLoading.value = true;
  try {
    accessServers.value = (await api.get<{ servers: ServerAccess[] }>(`/api/teams/${team.id}/servers`)).servers;
  } finally {
    accessLoading.value = false;
  }
}

async function saveAccess(vs: ServerAccess, body: { granted: boolean; toolIds?: string[] | null }) {
  if (!accessTeam.value) return;
  accessBusy.value = vs.id;
  try {
    const res = await api.put<{ server: ServerAccess }>(`/api/teams/${accessTeam.value.id}/servers/${vs.id}`, body);
    const i = accessServers.value.findIndex((x) => x.id === vs.id);
    if (i >= 0 && res.server) accessServers.value[i] = res.server;
    toast.success(t('teamsView.accessUpdated'));
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('teamsView.accessUpdateFailed'));
  } finally {
    accessBusy.value = null;
  }
}

function toggleGrant(vs: ServerAccess) {
  delete toolMode[vs.id]; // reset override so a fresh grant derives its mode from the server response
  saveAccess(vs, vs.granted ? { granted: false } : { granted: true, toolIds: null });
}
function setMode(vs: ServerAccess, mode: 'all' | 'subset') {
  toolMode[vs.id] = mode;
  // 'all' persists immediately; 'subset' just reveals the tool list — the subset is saved as tools are ticked.
  if (mode === 'all') saveAccess(vs, { granted: true, toolIds: null });
}
function toggleTool(vs: ServerAccess, toolId: string) {
  toolMode[vs.id] = 'subset'; // stay in subset mode even if the last tool is unticked (server would read it as "all")
  const next = vs.toolIds.includes(toolId) ? vs.toolIds.filter((x) => x !== toolId) : [...vs.toolIds, toolId];
  saveAccess(vs, { granted: true, toolIds: next });
}
</script>

<template>
  <div class="topbar">
    <div>
      <h1>{{ t('teamsView.title') }}</h1>
      <small class="muted">{{ t('teamsView.subtitle') }}</small>
    </div>
    <button v-if="canWrite" class="btn primary" @click="openCreate">{{ t('teamsView.newTeam') }}</button>
  </div>

  <div class="card">
    <p v-if="loading" class="muted">{{ t('teamsView.loading') }}</p>
    <div v-else-if="teams.length === 0" class="empty">{{ t('teamsView.noTeams') }}</div>
    <table v-else>
      <thead>
        <tr><th>{{ t('teamsView.colName') }}</th><th>{{ t('teamsView.colMembers') }}</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="team in teams" :key="team.id">
          <td>
            <div style="font-weight: 600">{{ team.name }}</div>
            <small class="muted">{{ team.description }}</small>
          </td>
          <td><span class="badge">{{ team.memberCount }}</span></td>
          <td class="actions-cell">
            <div class="btn-row" style="flex-wrap: nowrap">
              <button class="btn icon" :title="t('teamsView.members')" :aria-label="t('teamsView.members')" @click="openMembers(team)"><Users :size="16" :stroke-width="2" /></button>
              <button v-if="canWrite" class="btn icon" :title="t('teamsView.mcpAccess')" :aria-label="t('teamsView.mcpAccess')" @click="openAccess(team)"><KeyRound :size="16" :stroke-width="2" /></button>
              <button v-if="canWrite" class="btn icon" :title="t('teamsView.edit')" :aria-label="t('teamsView.edit')" @click="openEdit(team)"><Pencil :size="16" :stroke-width="2" /></button>
              <button v-if="canWrite" class="btn danger icon" :title="t('teamsView.delete')" :aria-label="t('teamsView.delete')" @click="remove(team)"><Trash2 :size="16" :stroke-width="2" /></button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Create/edit team -->
  <div v-if="showTeam" class="modal-backdrop" @click.self="showTeam = false">
    <div class="modal">
      <h2>{{ editingId ? t('teamsView.editTeam') : t('teamsView.newTeamTitle') }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div class="field"><label>{{ t('teamsView.nameLabel') }}</label><input v-model="form.name" /></div>
      <div class="field"><label>{{ t('teamsView.descriptionLabel') }}</label><input v-model="form.description" /></div>
      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="showTeam = false">{{ t('teamsView.cancel') }}</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? t('teamsView.saving') : t('teamsView.save') }}</button>
      </div>
    </div>
  </div>

  <!-- Members -->
  <div v-if="showMembers" class="modal-backdrop" @click.self="showMembers = false">
    <div class="modal">
      <h2>{{ t('teamsView.membersTitle', { name: membersTeam?.name }) }}</h2>

      <table v-if="members.length">
        <thead><tr><th>{{ t('teamsView.colUser') }}</th><th>{{ t('teamsView.colRole') }}</th><th></th></tr></thead>
        <tbody>
          <tr v-for="m in members" :key="m.userId">
            <td><div style="font-weight: 600">{{ m.email }}</div><small class="muted">{{ m.name }}</small></td>
            <td><span class="badge">{{ m.role }}</span></td>
            <td class="actions-cell"><button v-if="canWrite" class="btn danger icon" :title="t('teamsView.remove')" :aria-label="t('teamsView.remove')" @click="removeMember(m)"><X :size="16" :stroke-width="2" /></button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">{{ t('teamsView.noMembers') }}</div>

      <div v-if="canWrite" class="card" style="background: var(--bg-page); margin-top: 1rem">
        <label>{{ t('teamsView.addMember') }}</label>
        <div class="row" style="gap: 0.5rem">
          <select v-model="addUserId" style="flex: 2">
            <option value="">{{ t('teamsView.selectUser') }}</option>
            <option v-for="u in allUsers" :key="u.id" :value="u.id">{{ u.email }}</option>
          </select>
          <select v-model="addRole" style="flex: 1">
            <option value="member">{{ t('teamsView.roleMember') }}</option>
            <option value="owner">{{ t('teamsView.roleOwner') }}</option>
          </select>
          <button class="btn primary" :disabled="!addUserId" @click="addMember">{{ t('teamsView.add') }}</button>
        </div>
      </div>

      <div class="btn-row" style="justify-content: flex-end; margin-top: 1rem">
        <button class="btn" @click="showMembers = false">{{ t('teamsView.close') }}</button>
      </div>
    </div>
  </div>

  <!-- MCP access -->
  <div v-if="showAccess" class="modal-backdrop" @click.self="showAccess = false">
    <div class="modal" style="max-width: 640px">
      <h2>{{ t('teamsView.accessTitle', { name: accessTeam?.name }) }}</h2>
      <small class="muted">
        <i18n-t keypath="teamsView.accessDescription" tag="span">
          <template #restricted><strong>{{ t('teamsView.restricted') }}</strong></template>
        </i18n-t>
      </small>

      <p v-if="accessLoading" class="muted" style="margin-top: 1rem">{{ t('teamsView.loading') }}</p>
      <div v-else-if="accessServers.length === 0" class="empty" style="margin-top: 1rem">{{ t('teamsView.noEndpoints') }}</div>

      <div v-else style="margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem">
        <div v-for="vs in accessServers" :key="vs.id" class="card" style="background: var(--bg-page)">
          <div class="row spread" style="align-items: center">
            <div>
              <label class="checkbox" style="font-weight: 600">
                <input type="checkbox" :checked="vs.granted" :disabled="!canWrite || accessBusy === vs.id" @change="toggleGrant(vs)" />
                {{ vs.name }}
              </label>
              <small class="muted">/endpoints/{{ vs.slug }}/mcp · {{ vs.access }}<span v-if="!vs.enabled"> · {{ t('teamsView.disabled') }}</span></small>
            </div>
            <span v-if="accessBusy === vs.id" class="muted">{{ t('teamsView.savingShort') }}</span>
          </div>

          <div v-if="vs.granted" style="margin-top: 0.5rem; padding-left: 1.5rem">
            <div class="row" style="gap: 1rem; margin-bottom: 0.4rem">
              <label class="checkbox">
                <input type="radio" :name="'mode-' + vs.id" :checked="displayMode(vs) === 'all'" :disabled="!canWrite || accessBusy === vs.id" @change="setMode(vs, 'all')" />
                {{ t('teamsView.allTools') }}
              </label>
              <label class="checkbox">
                <input type="radio" :name="'mode-' + vs.id" :checked="displayMode(vs) === 'subset'" :disabled="!canWrite || accessBusy === vs.id" @change="setMode(vs, 'subset')" />
                {{ t('teamsView.onlySelectedTools') }}
              </label>
            </div>
            <div v-if="displayMode(vs) === 'subset'" style="display: flex; flex-direction: column; gap: 0.2rem; padding-left: 0.5rem">
              <label v-for="tool in vs.tools" :key="tool.id" class="checkbox">
                <input type="checkbox" :checked="vs.toolIds.includes(tool.id)" :disabled="!canWrite || accessBusy === vs.id" @change="toggleTool(vs, tool.id)" />
                {{ tool.name }}
              </label>
              <small v-if="vs.tools.length === 0" class="muted">{{ t('teamsView.noTools') }}</small>
              <small v-else-if="vs.toolIds.length === 0" class="muted">{{ t('teamsView.pickTools') }}</small>
            </div>
          </div>
        </div>
      </div>

      <div class="btn-row" style="justify-content: flex-end; margin-top: 1rem">
        <button class="btn" @click="showAccess = false">{{ t('teamsView.close') }}</button>
      </div>
    </div>
  </div>
</template>
