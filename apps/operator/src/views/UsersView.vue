<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { User } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useToastStore } from '../stores/toast';
import { Pencil, Trash2 } from 'lucide-vue-next';

const { t } = useI18n();
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
      toast.success(t('usersView.userUpdated'));
    } else {
      await api.post('/api/users', { email: form.email, name: form.name, password: form.password, role: form.role });
      toast.success(t('usersView.userCreated'));
    }
    showModal.value = false;
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('usersView.couldNotSave');
  } finally {
    saving.value = false;
  }
}

async function remove(u: User) {
  if (!confirm(t('usersView.confirmDelete', { email: u.email }))) return;
  try {
    await api.del(`/api/users/${u.id}`);
    toast.success(t('usersView.userDeleted'));
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : t('usersView.couldNotDelete'));
  }
}
</script>

<template>
  <div class="topbar">
    <h1>{{ t('usersView.title') }}</h1>
    <button v-if="auth.can('users.write')" class="btn primary" @click="openCreate">{{ t('usersView.addUser') }}</button>
  </div>

  <div class="card">
    <p v-if="loading" class="muted">{{ t('usersView.loading') }}</p>
    <table v-else>
      <thead>
        <tr><th>{{ t('usersView.colEmail') }}</th><th>{{ t('usersView.colName') }}</th><th>{{ t('usersView.colRole') }}</th><th>{{ t('usersView.colStatus') }}</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td style="font-weight: 600">{{ u.email }}</td>
          <td>{{ u.name || '—' }}</td>
          <td><span class="badge">{{ u.role }}</span></td>
          <td>
            <span class="badge" :class="u.disabled ? 'offline' : 'online'">{{ u.disabled ? t('usersView.statusDisabled') : t('usersView.statusActive') }}</span>
          </td>
          <td class="actions-cell">
            <div class="btn-row" style="flex-wrap: nowrap">
              <button v-if="auth.can('users.write')" class="btn icon" :title="t('usersView.edit')" :aria-label="t('usersView.edit')" @click="openEdit(u)"><Pencil :size="16" :stroke-width="2" /></button>
              <button
                v-if="auth.can('users.write') && u.id !== auth.user?.id"
                class="btn danger icon"
                :title="t('usersView.delete')"
                :aria-label="t('usersView.delete')"
                @click="remove(u)"
              ><Trash2 :size="16" :stroke-width="2" /></button>
              <small v-if="u.id === auth.user?.id" class="muted">{{ t('usersView.you') }}</small>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="showModal" class="modal-backdrop" @click.self="showModal = false">
    <div class="modal">
      <h2>{{ editingId ? t('usersView.editUser') : t('usersView.addUserTitle') }}</h2>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div class="field"><label>{{ t('usersView.labelEmail') }}</label><input v-model="form.email" type="email" required /></div>
      <div class="field"><label>{{ t('usersView.labelName') }}</label><input v-model="form.name" /></div>
      <div class="field">
        <label>{{ editingId ? t('usersView.labelResetPassword') : t('usersView.labelPassword') }}</label>
        <input v-model="form.password" type="password" minlength="8" :required="!editingId" autocomplete="new-password" />
      </div>
      <div class="field">
        <label>{{ t('usersView.labelRole') }}</label>
        <select v-model="form.role">
          <option value="viewer">{{ t('usersView.roleViewer') }}</option>
          <option value="editor">{{ t('usersView.roleEditor') }}</option>
          <option value="admin">{{ t('usersView.roleAdmin') }}</option>
        </select>
      </div>
      <div v-if="editingId && editingId !== auth.user?.id" class="field">
        <label class="checkbox"><input v-model="form.disabled" type="checkbox" /> {{ t('usersView.labelDisabled') }}</label>
      </div>
      <div class="btn-row" style="justify-content: flex-end">
        <button class="btn" @click="showModal = false">{{ t('usersView.cancel') }}</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? t('usersView.saving') : editingId ? t('usersView.saveChanges') : t('usersView.createUser') }}</button>
      </div>
    </div>
  </div>
</template>
