<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { useBootstrapStore } from '../stores/bootstrap';
import { api, ApiError, setToken } from '../api/client';
import RavenLogo from '../components/RavenLogo.vue';

const { t } = useI18n();
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

const POST_LOGIN_KEY = 'kravn.postLogin';

/** Where to land after auth: the guard's ?redirect=, else a target stashed before an SSO round-trip, else home. */
function postLoginTarget(): string {
  const fromQuery = route.query.redirect as string | undefined;
  if (fromQuery) return fromQuery;
  try {
    return sessionStorage.getItem(POST_LOGIN_KEY) || '/';
  } catch {
    return '/';
  }
}

onMounted(async () => {
  // Stash the intended destination so it survives the SAML round-trip (which returns to /login?token=
  // and drops the query). sessionStorage persists across the same-tab redirect.
  const redirect = route.query.redirect as string | undefined;
  if (redirect) {
    try {
      sessionStorage.setItem(POST_LOGIN_KEY, redirect);
    } catch {
      /* ignore */
    }
  }

  // Redirected here because the account is authenticated but not a Platform Administrator Team member.
  if (route.query.denied) {
    error.value = t('operatorLoginView.errorNotPlatformAdmin');
  }

  // Capture an SSO redirect (?token=) or surface an SSO error.
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
        const target = postLoginTarget();
        try {
          sessionStorage.removeItem(POST_LOGIN_KEY);
        } catch {
          /* ignore */
        }
        router.replace(target);
        return;
      }
      setToken(null);
      auth.token = null;
    } catch (e) {
      error.value = e instanceof ApiError ? e.message : t('operatorLoginView.errorSsoFailed');
    }
  }
});

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await auth.login(form);
    const target = postLoginTarget();
    // Non-admins may still complete a standalone OAuth consent (an MCP consumer authorizing an endpoint);
    // they just can't reach the admin console. Mirrors the router guard's oauth-consent exemption.
    if (!auth.isPlatformAdmin && !target.startsWith('/oauth/consent')) {
      error.value = t('operatorLoginView.errorNotPlatformAdmin');
      return;
    }
    try {
      sessionStorage.removeItem(POST_LOGIN_KEY);
    } catch {
      /* ignore */
    }
    router.push(target);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('operatorLoginView.errorLoginFailed');
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
        <p class="muted" style="margin: 0">{{ t('operatorLoginView.subtitle') }}</p>
      </div>

      <div v-if="error" class="alert error">{{ error }}</div>

      <div v-if="ssoMethods.length" class="btn-row" style="flex-direction: column; gap: 0.5rem; margin-bottom: 1rem">
        <a v-for="m in ssoMethods" :key="m.id" class="btn" style="justify-content: center" :href="ssoUrl(m)">
          {{ t('operatorLoginView.signInWith', { label: m.label }) }}
        </a>
      </div>

      <div v-if="ssoMethods.length && passwordLoginEnabled" class="row" style="margin: 0.5rem 0">
        <hr style="flex: 1; border-color: var(--border)" /><small class="muted">{{ t('operatorLoginView.or') }}</small><hr style="flex: 1; border-color: var(--border)" />
      </div>

      <form v-if="passwordLoginEnabled" @submit.prevent="submit">
        <div class="field">
          <label>{{ t('operatorLoginView.emailLabel') }}</label>
          <input v-model="form.email" type="email" required />
        </div>
        <div class="field">
          <label>{{ t('operatorLoginView.passwordLabel') }}</label>
          <input v-model="form.password" type="password" required />
        </div>
        <button class="btn primary" style="width: 100%" :disabled="busy" type="submit">
          {{ busy ? t('operatorLoginView.signingIn') : t('operatorLoginView.signIn') }}
        </button>
      </form>

      <p v-else-if="!ssoMethods.length" class="muted" style="text-align: center; margin: 0">
        {{ t('operatorLoginView.noSignInMethod') }}
      </p>
    </div>
  </div>
</template>
