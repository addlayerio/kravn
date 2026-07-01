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
const editingId = ref<string | null>(null);

const blank = () => ({ email: '', password: '', name: '', role: 'viewer' as 'admin' | 'editor' | 'viewer', disabled: false });
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
  editingId.value = null;
  error.value = '';
  showModal.value = true;
}

function openEdit(u: User) {
  Object.assign(form, { email: u.email, name: u.name, password: '', role: u.role, disabled: !!u.disabled });
  editingId.value = u.id;
  error.value = '';
  showModal.value = true;
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    if (editingId.value) {
      const patch: Record<string, unknown> = { name: form.name, email: form.email, role: form.role, disabled: form.disabled };
      if (form.password) patch.password = form.password; // blank = keep current password
      await api.patch(`/api/users/${editingId.value}`, patch);
      toast.success('User updated.');
    } else {
      await api.post('/api/users', { email: form.email, name: form.name, password: form.password, role: form.role });
      toast.success('User created.');
    }
    showModal.value = false;
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Could not save user.';
  } finally {
    saving.value = false;
  }
}

async function remove(u: User) {
  if (!confirm(`Delete user "${u.email}"? This is permanent — to keep the record but block sign-in, disable it instead.`)) return;
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
        <tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td style="font-weight: 600">{{ u.email }}</td>
          <td>{{ u.name || '—' }}</td>
          <td><span class="badge">{{ u.role }}</span></td>
          <td>
            <span class="badge" :class="u.disabled ? 'offline' : 'online'">{{ u.disabled ? 'disabled' : 'active' }}</span>
          </td>
          <td>
            <div class="btn-row">
              <button v-if="auth.can('users.write')" class="btn" @click="openEdit(u)">Edit</button>
              <button
                v-if="auth.can('users.write') && u.id !== auth.user?.id"
                class="btn danger"
                @click="remove(u)"
              >
                Delete
              </button>
              <small v-if="u.id === auth.user?.id" class="muted">you</small>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal">
      <h2>{{ editingId ? 'Edit user' : 'Add user' }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div class="field"><label>Email</label><input v-model="form.email" type="email" required /></div>
      <div class="field"><label>Name</label><input v-model="form.name" /></div>
      <div class="field">
        <label>{{ editingId ? 'Reset password (leave blank to keep)' : 'Password' }}</label>
        <input v-model="form.password" type="password" minlength="8" :required="!editingId" autocomplete="new-password" />
      </div>
      <div class="field">
        <label>Role</label>
        <select v-model="form.role">
          <option value="viewer">Viewer (read-only / MCP consumer)</option>
          <option value="editor">Editor (manage servers & registry)</option>
          <option value="admin">Admin (full access)</option>
        </select>
      </div>
      <div v-if="editingId && editingId !== auth.user?.id" class="field">
        <label class="checkbox"><input v-model="form.disabled" type="checkbox" /> Disabled (block sign-in, keep the account)</label>
      </div>
      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="showModal = false">Cancel</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : editingId ? 'Save changes' : 'Create user' }}</button>
      </div>
    </div>
  </div>
</template>
