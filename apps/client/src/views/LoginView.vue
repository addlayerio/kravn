<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { api, ApiError, setToken } from '../api';
import RavenLogo from '../RavenLogo.vue';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const form = reactive({ email: '', password: '' });
const error = ref('');
const busy = ref(false);

const ssoMethods = computed(() => auth.info?.ssoMethods ?? []);

// Every SSO start carries returnTo=client so the gateway redirects the token back to THIS app.
function ssoUrl(m: { kind: string; id: string }): string {
  return m.kind === 'saml'
    ? '/api/auth/sso/saml/start?returnTo=client'
    : `/api/auth/sso/oauth/${m.id}/start?returnTo=client`;
}

onMounted(async () => {
  // SSO returns a one-time ?code= (not a token). Exchange it for a session token.
  const code = route.query.code as string | undefined;
  const ssoError = route.query.sso_error as string | undefined;
  if (ssoError) error.value = ssoError;
  if (code) {
    try {
      const { token } = await api.post<{ token: string }>('/api/auth/exchange', { code });
      setToken(token);
      auth.token = token;
      await auth.loadMe();
      if (auth.isAuthenticated) {
        router.replace('/');
        return;
      }
      setToken(null);
      auth.token = null;
      error.value = error.value || 'SSO sign-in did not complete.';
    } catch (e) {
      error.value = e instanceof ApiError ? e.message : 'Single sign-on failed.';
    }
  }
});

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await auth.login(form);
    router.push('/');
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
        <h1 style="margin: 0">{{ auth.info?.instanceName || 'Kravn' }}</h1>
        <p class="muted" style="margin: 0">Sign in to your AI workspace.</p>
      </div>

      <div v-if="error" class="alert error">{{ error }}</div>

      <div v-if="ssoMethods.length" class="btn-row" style="flex-direction: column; gap: 0.5rem; margin-bottom: 1rem">
        <a v-for="m in ssoMethods" :key="m.id" class="btn" style="justify-content: center" :href="ssoUrl(m)">
          Sign in with {{ m.label }}
        </a>
      </div>

      <div v-if="ssoMethods.length" class="row" style="margin: 0.5rem 0; align-items: center; gap: 0.5rem">
        <hr style="flex: 1; border: none; border-top: 1px solid var(--border)" />
        <small class="muted">or</small>
        <hr style="flex: 1; border: none; border-top: 1px solid var(--border)" />
      </div>

      <form @submit.prevent="submit">
        <div class="field"><label>Email</label><input v-model="form.email" type="email" required autofocus /></div>
        <div class="field"><label>Password</label><input v-model="form.password" type="password" required /></div>
        <button class="btn primary" style="width: 100%" :disabled="busy" type="submit">
          {{ busy ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </div>
  </div>
</template>
