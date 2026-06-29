<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { AppSettings, SettingGroupMeta } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useBootstrapStore } from '../stores/bootstrap';

const auth = useAuthStore();
const bootstrap = useBootstrapStore();
const model = ref<AppSettings | null>(null);
const ui = ref<SettingGroupMeta[]>([]);
const loading = ref(true);
const saving = ref(false);
const message = ref('');
const error = ref('');

const canWrite = auth.can('settings.write');

onMounted(async () => {
  try {
    const res = await api.get<{ settings: AppSettings; ui: SettingGroupMeta[] }>('/api/settings');
    model.value = res.settings;
    ui.value = res.ui;
  } finally {
    loading.value = false;
  }
});

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
    message.value = 'Settings saved.';
    await bootstrap.load(true);
    setTimeout(() => (message.value = ''), 3000);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Could not save settings.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="topbar">
    <h1>Settings</h1>
    <button v-if="canWrite" class="btn primary" :disabled="saving" @click="save">
      {{ saving ? 'Saving…' : 'Save changes' }}
    </button>
  </div>
  <p class="muted" style="margin-top: -0.5rem">
    These apply immediately and are stored in the database — no redeploy needed.
  </p>

  <div v-if="message" class="alert success">{{ message }}</div>
  <div v-if="error" class="alert error">{{ error }}</div>

  <p v-if="loading" class="muted">Loading…</p>

  <template v-else-if="model">
    <div v-for="group in ui" :key="group.key" class="card">
      <h3>{{ group.label }}</h3>
      <p v-if="group.description" class="muted">{{ group.description }}</p>

      <div v-for="f in group.fields" :key="f.path" class="field">
        <label>{{ f.label }}</label>

        <div v-if="f.control === 'boolean'" class="checkbox">
          <input
            type="checkbox"
            :checked="getVal(f.path)"
            :disabled="!canWrite"
            @change="setVal(f.path, ($event.target as HTMLInputElement).checked)"
          />
          <span class="muted">{{ getVal(f.path) ? 'Enabled' : 'Disabled' }}</span>
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
          placeholder="One per line"
          @input="setArr(f.path, ($event.target as HTMLTextAreaElement).value)"
        ></textarea>

        <input
          v-else
          :type="f.secret ? 'password' : 'text'"
          :value="getVal(f.path)"
          :disabled="!canWrite"
          @input="setVal(f.path, ($event.target as HTMLInputElement).value)"
        />

        <small v-if="f.help" class="muted">{{ f.help }}</small>
      </div>
    </div>
  </template>
</template>
