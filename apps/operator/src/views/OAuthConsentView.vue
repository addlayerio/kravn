<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { shouldShowAttribution } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useBootstrapStore } from '../stores/bootstrap';
import BrandLogo from '../components/BrandLogo.vue';
import PoweredByKravn from '../components/PoweredByKravn.vue';

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const bootstrap = useBootstrapStore();

// Branding is applied here as SAFE structured data only — logo, name, tagline, accent colour. The raw CSS
// override is deliberately NOT applied on this security-sensitive approval screen.
const brandName = computed(() => bootstrap.info?.branding?.brandName || bootstrap.info?.instanceName || 'Kravn');
const brandCustomized = computed(() => shouldShowAttribution(bootstrap.info?.branding, bootstrap.info?.instanceName));
const brandStyle = computed(() =>
  bootstrap.info?.branding?.primaryColor ? { '--accent': bootstrap.info.branding.primaryColor } : {},
);

const reqId = String(route.query.req ?? '');
const consent = ref<{ clientId: string; clientName: string; scope: string; redirectHost: string } | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref('');

onMounted(async () => {
  if (!reqId) {
    error.value = 'Missing authorization request.';
    loading.value = false;
    return;
  }
  try {
    const res = await api.get<{ consent: typeof consent.value }>(`/api/oauth/consent/${encodeURIComponent(reqId)}`);
    consent.value = res.consent;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'This authorization request expired. Start again from your client.';
  } finally {
    loading.value = false;
  }
});

async function decide(approve: boolean): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const res = await api.post<{ redirect: string }>(`/api/oauth/consent/${encodeURIComponent(reqId)}/decision`, { approve });
    // Hand control back to the OAuth client (Claude) — a full navigation, not a SPA route.
    window.location.href = res.redirect;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Could not complete the request.';
    busy.value = false;
  }
}
</script>

<template>
  <div class="auth-wrap" :style="brandStyle">
    <div class="auth-card">
      <div class="auth-brand">
        <BrandLogo :size="44" />
        <h1 style="margin: 0">{{ brandName }}</h1>
        <p v-if="bootstrap.info?.branding?.tagline" class="muted" style="margin: 0">{{ bootstrap.info.branding.tagline }}</p>
        <p class="muted" style="margin: 0">{{ t('consent.authorizeAccess') }}</p>
        <PoweredByKravn v-if="brandCustomized" style="margin-top: 2px" />
      </div>

      <div v-if="error" class="alert error">{{ error }}</div>
      <p v-if="loading" class="muted" style="text-align: center">{{ t('common.loading') }}</p>

      <template v-else-if="consent">
        <p style="margin: 0 0 0.25rem">
          {{ t('consent.wantsToConnect', { client: consent.clientName }) }}
        </p>
        <p class="muted" style="margin: 0 0 1rem; font-size: 0.85rem">
          {{ t('consent.onBehalf', { email: auth.user?.email, role: auth.user?.role }) }}
        </p>

        <div class="consent-scope">
          <span class="muted">{{ t('consent.scope') }}</span>
          <code>{{ consent.scope || 'mcp' }}</code>
        </div>
        <div v-if="consent.redirectHost" class="consent-scope" style="margin-top: 0.5rem">
          <span class="muted">{{ t('consent.redirectsTo') }}</span>
          <code>{{ consent.redirectHost }}</code>
        </div>

        <div class="btn-row" style="margin-top: 1.25rem; gap: 0.5rem">
          <button class="btn" style="flex: 1" :disabled="busy" @click="decide(false)">{{ t('consent.deny') }}</button>
          <button class="btn primary" style="flex: 2" :disabled="busy" @click="decide(true)">
            {{ busy ? t('consent.authorizing') : t('consent.allow') }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.consent-scope {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-surface-elev);
}
.consent-scope code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.85rem;
  color: var(--text);
}
</style>
