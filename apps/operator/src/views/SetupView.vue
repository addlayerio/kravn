<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { useBootstrapStore } from '../stores/bootstrap';
import { ApiError } from '../api/client';
import RavenLogo from '../components/RavenLogo.vue';

const auth = useAuthStore();
const bootstrap = useBootstrapStore();
const router = useRouter();
const { t } = useI18n();

const form = reactive({ instanceName: 'Kravn', email: '', password: '', name: '' });
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await auth.setup({
      email: form.email,
      password: form.password,
      name: form.name,
      instanceName: form.instanceName,
    });
    await bootstrap.load(true);
    router.push('/');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('setupView.setupFailed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="auth-wrap">
    <form class="auth-card" @submit.prevent="submit">
      <div class="auth-brand">
        <RavenLogo :size="44" />
        <h1 style="margin: 0">{{ t('setupView.welcomeTitle') }}</h1>
        <p class="muted" style="margin: 0">{{ t('setupView.welcomeSubtitle') }}</p>
      </div>

      <div v-if="error" class="alert error">{{ error }}</div>

      <div class="field">
        <label>{{ t('setupView.instanceNameLabel') }}</label>
        <input v-model="form.instanceName" placeholder="Kravn" />
      </div>
      <div class="field">
        <label>{{ t('setupView.yourNameLabel') }}</label>
        <input v-model="form.name" :placeholder="t('setupView.yourNamePlaceholder')" />
      </div>
      <div class="field">
        <label>{{ t('setupView.emailLabel') }}</label>
        <input v-model="form.email" type="email" required placeholder="admin@example.com" />
      </div>
      <div class="field">
        <label>{{ t('setupView.passwordLabel') }}</label>
        <input v-model="form.password" type="password" required minlength="8" :placeholder="t('setupView.passwordPlaceholder')" />
      </div>

      <button class="btn primary" style="width: 100%" :disabled="busy" type="submit">
        {{ busy ? t('setupView.creating') : t('setupView.createAdmin') }}
      </button>
    </form>
  </div>
</template>
