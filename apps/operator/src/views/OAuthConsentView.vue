<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useBootstrapStore } from '../stores/bootstrap';
import RavenLogo from '../components/RavenLogo.vue';

const route = useRoute();
const auth = useAuthStore();
const bootstrap = useBootstrapStore();

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
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-brand">
        <RavenLogo :size="44" />
        <h1 style="margin: 0">{{ bootstrap.info?.instanceName || 'Kravn' }}</h1>
        <p class="muted" style="margin: 0">Authorize access</p>
      </div>

      <div v-if="error" class="alert error">{{ error }}</div>
      <p v-if="loading" class="muted" style="text-align: center">Loading…</p>

      <template v-else-if="consent">
        <p style="margin: 0 0 0.25rem">
          <strong>{{ consent.clientName }}</strong> wants to connect to your MCP gateway.
        </p>
        <p class="muted" style="margin: 0 0 1rem; font-size: 0.85rem">
          It will access tools, resources and prompts on your behalf as
          <strong>{{ auth.user?.email }}</strong> ({{ auth.user?.role }}). Access is limited to MCP — it
          cannot manage your gateway.
        </p>

        <div class="consent-scope">
          <span class="muted">Scope</span>
          <code>{{ consent.scope || 'mcp' }}</code>
        </div>
        <div v-if="consent.redirectHost" class="consent-scope" style="margin-top: 0.5rem">
          <span class="muted">Redirects to</span>
          <code>{{ consent.redirectHost }}</code>
        </div>

        <div class="btn-row" style="margin-top: 1.25rem; gap: 0.5rem">
          <button class="btn" style="flex: 1" :disabled="busy" @click="decide(false)">Deny</button>
          <button class="btn primary" style="flex: 2" :disabled="busy" @click="decide(true)">
            {{ busy ? 'Authorizing…' : 'Allow' }}
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
