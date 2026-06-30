<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useBootstrapStore } from '../stores/bootstrap';
import { ApiError, setToken } from '../api/client';
import RavenLogo from '../components/RavenLogo.vue';

const auth = useAuthStore();
const bootstrap = useBootstrapStore();
const router = useRouter();
const route = useRoute();

const form = reactive({ email: '', password: '' });
const error = ref('');
const busy = ref(false);

const ssoMethods = computed(() => bootstrap.info?.ssoMethods ?? []);
const passwordLoginEnabled = computed(() => bootstrap.info?.passwordLoginEnabled !== false);

function ssoUrl(m: { kind: string; id: string }): string {
  return m.kind === 'saml' ? '/api/auth/sso/saml/start' : `/api/auth/sso/oauth/${m.id}/start`;
}

onMounted(async () => {
  // Capture an SSO redirect (?token=) or surface an SSO error.
  const token = route.query.token as string | undefined;
  const ssoError = route.query.sso_error as string | undefined;
  if (ssoError) error.value = ssoError;
  if (token) {
    setToken(token);
    auth.token = token;
    await auth.loadMe();
    if (auth.isAuthenticated) {
      router.replace('/');
      return;
    }
    setToken(null);
    auth.token = null;
  }
});

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await auth.login(form);
    router.push((route.query.redirect as string) || '/');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Login failed.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-brand">
        <RavenLogo :size="44" />
        <h1 style="margin: 0">{{ bootstrap.info?.instanceName || 'Kravn' }}</h1>
        <p class="muted" style="margin: 0">Sign in to your MCP gateway.</p>
      </div>

      <div v-if="error" class="alert error">{{ error }}</div>

      <div v-if="ssoMethods.length" class="btn-row" style="flex-direction: column; gap: 0.5rem; margin-bottom: 1rem">
        <a v-for="m in ssoMethods" :key="m.id" class="btn" style="justify-content: center" :href="ssoUrl(m)">
          Sign in with {{ m.label }}
        </a>
      </div>

      <div v-if="ssoMethods.length && passwordLoginEnabled" class="row" style="margin: 0.5rem 0">
        <hr style="flex: 1; border-color: var(--border)" /><small class="muted">or</small><hr style="flex: 1; border-color: var(--border)" />
      </div>

      <form v-if="passwordLoginEnabled" @submit.prevent="submit">
        <div class="field">
          <label>Email</label>
          <input v-model="form.email" type="email" required />
        </div>
        <div class="field">
          <label>Password</label>
          <input v-model="form.password" type="password" required />
        </div>
        <button class="btn primary" style="width: 100%" :disabled="busy" type="submit">
          {{ busy ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>

      <p v-else-if="!ssoMethods.length" class="muted" style="text-align: center; margin: 0">
        No sign-in method is available. Password login is disabled and no SSO provider is configured.
      </p>
    </div>
  </div>
</template>
