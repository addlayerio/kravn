<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { Team, TeamMember, User } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

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
function openEdit(t: Team) {
  form.name = t.name;
  form.description = t.description;
  editingId.value = t.id;
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
    toast.success(editingId.value ? 'Team updated.' : 'Team created.');
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Save failed.';
  } finally {
    saving.value = false;
  }
}
async function remove(t: Team) {
  if (!confirm(`Delete team "${t.name}"?`)) return;
  await api.del(`/api/teams/${t.id}`);
  toast.success('Team deleted.');
  await load();
}

async function openMembers(t: Team) {
  membersTeam.value = t;
  addUserId.value = '';
  addRole.value = 'member';
  showMembers.value = true;
  const [m, u] = await Promise.all([
    api.get<{ members: TeamMember[] }>(`/api/teams/${t.id}/members`),
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
    toast.success('Member added.');
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : 'Could not add member.');
  }
}
async function removeMember(m: TeamMember) {
  if (!membersTeam.value) return;
  await api.del(`/api/teams/${membersTeam.value.id}/members/${m.userId}`);
  members.value = members.value.filter((x) => x.userId !== m.userId);
  toast.success('Member removed.');
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

async function openAccess(t: Team) {
  accessTeam.value = t;
  showAccess.value = true;
  accessServers.value = [];
  Object.keys(toolMode).forEach((k) => delete toolMode[k]); // derive mode from freshly-loaded state
  accessLoading.value = true;
  try {
    accessServers.value = (await api.get<{ servers: ServerAccess[] }>(`/api/teams/${t.id}/servers`)).servers;
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
    toast.success('MCP access updated.');
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : 'Could not update access.');
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
      <h1>Teams</h1>
      <small class="muted">Group users and grant them access to MCP endpoints.</small>
    </div>
    <button v-if="canWrite" class="btn primary" @click="openCreate">+ New team</button>
  </div>

  <div class="card">
    <p v-if="loading" class="muted">Loading…</p>
    <div v-else-if="teams.length === 0" class="empty">No teams yet.</div>
    <table v-else>
      <thead>
        <tr><th>Name</th><th>Members</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="t in teams" :key="t.id">
          <td>
            <div style="font-weight: 600">{{ t.name }}</div>
            <small class="muted">{{ t.description }}</small>
          </td>
          <td><span class="badge">{{ t.memberCount }}</span></td>
          <td>
            <div class="btn-row">
              <button class="btn" @click="openMembers(t)">Members</button>
              <button v-if="canWrite" class="btn" @click="openAccess(t)">MCP access</button>
              <button v-if="canWrite" class="btn" @click="openEdit(t)">Edit</button>
              <button v-if="canWrite" class="btn danger" @click="remove(t)">Delete</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Create/edit team -->
  <div v-if="showTeam" class="modal-backdrop" @click.self="showTeam = false">
    <div class="modal">
      <h2>{{ editingId ? 'Edit team' : 'New team' }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div class="field"><label>Name</label><input v-model="form.name" /></div>
      <div class="field"><label>Description</label><input v-model="form.description" /></div>
      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="showTeam = false">Cancel</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
      </div>
    </div>
  </div>

  <!-- Members -->
  <div v-if="showMembers" class="modal-backdrop" @click.self="showMembers = false">
    <div class="modal">
      <h2>Members · {{ membersTeam?.name }}</h2>

      <table v-if="members.length">
        <thead><tr><th>User</th><th>Role</th><th></th></tr></thead>
        <tbody>
          <tr v-for="m in members" :key="m.userId">
            <td><div style="font-weight: 600">{{ m.email }}</div><small class="muted">{{ m.name }}</small></td>
            <td><span class="badge">{{ m.role }}</span></td>
            <td><button v-if="canWrite" class="btn danger" @click="removeMember(m)">Remove</button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">No members yet.</div>

      <div v-if="canWrite" class="card" style="background: var(--bg-page); margin-top: 1rem">
        <label>Add member</label>
        <div class="row" style="gap: 0.5rem">
          <select v-model="addUserId" style="flex: 2">
            <option value="">Select user…</option>
            <option v-for="u in allUsers" :key="u.id" :value="u.id">{{ u.email }}</option>
          </select>
          <select v-model="addRole" style="flex: 1">
            <option value="member">member</option>
            <option value="owner">owner</option>
          </select>
          <button class="btn primary" :disabled="!addUserId" @click="addMember">Add</button>
        </div>
      </div>

      <div class="btn-row" style="justify-content: flex-end; margin-top: 1rem">
        <button class="btn" @click="showMembers = false">Close</button>
      </div>
    </div>
  </div>

  <!-- MCP access -->
  <div v-if="showAccess" class="modal-backdrop" @click.self="showAccess = false">
    <div class="modal" style="max-width: 640px">
      <h2>MCP access · {{ accessTeam?.name }}</h2>
      <small class="muted">
        Choose which MCPs this team can use, and — per MCP — whether they get all its tools or only some.
        Granting an MCP switches it to <strong>restricted</strong> so only granted teams/roles can use it.
      </small>

      <p v-if="accessLoading" class="muted" style="margin-top: 1rem">Loading…</p>
      <div v-else-if="accessServers.length === 0" class="empty" style="margin-top: 1rem">No MCP endpoints yet.</div>

      <div v-else style="margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem">
        <div v-for="vs in accessServers" :key="vs.id" class="card" style="background: var(--bg-page)">
          <div class="row spread" style="align-items: center">
            <div>
              <label class="checkbox" style="font-weight: 600">
                <input type="checkbox" :checked="vs.granted" :disabled="!canWrite || accessBusy === vs.id" @change="toggleGrant(vs)" />
                {{ vs.name }}
              </label>
              <small class="muted">/endpoints/{{ vs.slug }}/mcp · {{ vs.access }}<span v-if="!vs.enabled"> · disabled</span></small>
            </div>
            <span v-if="accessBusy === vs.id" class="muted">Saving…</span>
          </div>

          <div v-if="vs.granted" style="margin-top: 0.5rem; padding-left: 1.5rem">
            <div class="row" style="gap: 1rem; margin-bottom: 0.4rem">
              <label class="checkbox">
                <input type="radio" :name="'mode-' + vs.id" :checked="displayMode(vs) === 'all'" :disabled="!canWrite || accessBusy === vs.id" @change="setMode(vs, 'all')" />
                All tools
              </label>
              <label class="checkbox">
                <input type="radio" :name="'mode-' + vs.id" :checked="displayMode(vs) === 'subset'" :disabled="!canWrite || accessBusy === vs.id" @change="setMode(vs, 'subset')" />
                Only selected tools
              </label>
            </div>
            <div v-if="displayMode(vs) === 'subset'" style="display: flex; flex-direction: column; gap: 0.2rem; padding-left: 0.5rem">
              <label v-for="t in vs.tools" :key="t.id" class="checkbox">
                <input type="checkbox" :checked="vs.toolIds.includes(t.id)" :disabled="!canWrite || accessBusy === vs.id" @change="toggleTool(vs, t.id)" />
                {{ t.name }}
              </label>
              <small v-if="vs.tools.length === 0" class="muted">This MCP has no tools.</small>
              <small v-else-if="vs.toolIds.length === 0" class="muted">Pick the tools this team may use (none selected = the team gets all).</small>
            </div>
          </div>
        </div>
      </div>

      <div class="btn-row" style="justify-content: flex-end; margin-top: 1rem">
        <button class="btn" @click="showAccess = false">Close</button>
      </div>
    </div>
  </div>
</template>
