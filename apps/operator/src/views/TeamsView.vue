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
</script>

<template>
  <div class="topbar">
    <div>
      <h1>Teams</h1>
      <small class="muted">Group users and grant them access to virtual servers.</small>
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
</template>
