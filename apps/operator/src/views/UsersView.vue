<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { User } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';

const auth = useAuthStore();
const toast = useToastStore();
const users = ref<User[]>([]);
const loading = ref(true);
const showModal = ref(false);
const saving = ref(false);
const error = ref('');

const blank = () => ({ email: '', password: '', name: '', role: 'viewer' as 'admin' | 'editor' | 'viewer' });
const form = reactive(blank());

async function load() {
  loading.value = true;
  try {
    users.value = (await api.get<{ users: User[] }>('/api/users')).users;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openCreate() {
  Object.assign(form, blank());
  error.value = '';
  showModal.value = true;
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    await api.post('/api/users', { ...form });
    showModal.value = false;
    toast.success('User created.');
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Could not create user.';
  } finally {
    saving.value = false;
  }
}

async function changeRole(u: User, role: string) {
  if (u.role === role) return;
  try {
    await api.patch(`/api/users/${u.id}`, { role });
    u.role = role as User['role'];
    toast.success(`Role updated to ${role}.`);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : 'Could not update role.');
    await load(); // revert the <select> to the server's value
  }
}

async function remove(u: User) {
  if (!confirm(`Delete user "${u.email}"?`)) return;
  try {
    await api.del(`/api/users/${u.id}`);
    toast.success('User deleted.');
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : 'Could not delete user.');
  }
}
</script>

<template>
  <div class="topbar">
    <h1>Users</h1>
    <button v-if="auth.can('users.write')" class="btn primary" @click="openCreate">+ Add user</button>
  </div>

  <div class="card">
    <p v-if="loading" class="muted">Loading…</p>
    <table v-else>
      <thead>
        <tr><th>Email</th><th>Name</th><th>Role</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td style="font-weight: 600">{{ u.email }}</td>
          <td>{{ u.name || '—' }}</td>
          <td>
            <select
              v-if="auth.can('users.write') && u.id !== auth.user?.id"
              :value="u.role"
              @change="changeRole(u, ($event.target as HTMLSelectElement).value)"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
            <span v-else class="badge">{{ u.role }}</span>
          </td>
          <td>
            <button
              v-if="auth.can('users.write') && u.id !== auth.user?.id"
              class="btn danger"
              @click="remove(u)"
            >
              Delete
            </button>
            <small v-else-if="u.id === auth.user?.id" class="muted">you</small>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal">
      <h2>Add user</h2>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div class="field"><label>Email</label><input v-model="form.email" type="email" required /></div>
      <div class="field"><label>Name</label><input v-model="form.name" /></div>
      <div class="field"><label>Password</label><input v-model="form.password" type="password" minlength="8" required /></div>
      <div class="field">
        <label>Role</label>
        <select v-model="form.role">
          <option value="viewer">Viewer (read-only)</option>
          <option value="editor">Editor (manage servers & registry)</option>
          <option value="admin">Admin (full access)</option>
        </select>
      </div>
      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="showModal = false">Cancel</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Create user' }}</button>
      </div>
    </div>
  </div>
</template>
