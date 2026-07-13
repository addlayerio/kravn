<script setup lang="ts">
import { onMounted, reactive, ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppSettings, LocaleCode } from '@kravn/contracts';
import { shouldShowAttribution, AVAILABLE_LOCALES } from '@kravn/contracts';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useBootstrapStore } from '../stores/bootstrap';
import BrandLogo from '../components/BrandLogo.vue';
import PoweredByKravn from '../components/PoweredByKravn.vue';

const { t } = useI18n();
const auth = useAuthStore();
const bootstrap = useBootstrapStore();
const canWrite = auth.can('settings.write');

const loading = ref(true);
const saving = ref(false);
const message = ref('');
const error = ref('');
const showCss = ref(false);
const instanceName = ref('Kravn');
const locale = ref<LocaleCode>('en');

const form = reactive({
  brandName: '',
  tagline: '',
  logoDataUri: '',
  primaryColor: '',
  cssOverride: '',
});

// The server caps the stored data URI at 512 KB; base64 inflates bytes ~33%, so validate the ENCODED length.
const LOGO_MAX_DATAURI = 512_000;

const previewName = computed(() => form.brandName || instanceName.value || 'Kravn');
const previewTagline = computed(() => form.tagline || t('appearanceView.previewTaglineDefault'));
const previewCustomized = computed(() => shouldShowAttribution({ ...form } as AppSettings['branding'], instanceName.value));
const previewStyle = computed(() => (form.primaryColor ? { '--accent': form.primaryColor } : {}));

onMounted(async () => {
  try {
    const { settings } = await api.get<{ settings: AppSettings }>('/api/settings');
    instanceName.value = settings.general.instanceName;
    locale.value = settings.general.locale;
    Object.assign(form, settings.branding);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('appearanceView.couldNotLoad');
  } finally {
    loading.value = false;
  }
});

function onLogoFile(e: Event) {
  error.value = '';
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    error.value = t('appearanceView.invalidImage');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUri = String(reader.result || '');
    // Validate the ENCODED size (what actually gets stored + rejected server-side), not the raw file bytes.
    if (dataUri.length > LOGO_MAX_DATAURI) {
      error.value = t('appearanceView.imageTooLarge');
      return;
    }
    form.logoDataUri = dataUri;
  };
  reader.readAsDataURL(file);
}
function removeLogo() {
  form.logoDataUri = '';
}
function resetColor() {
  form.primaryColor = '';
}

async function save() {
  if (!canWrite) return;
  saving.value = true;
  message.value = '';
  error.value = '';
  try {
    await api.put<{ settings: AppSettings }>('/api/settings', { general: { locale: locale.value }, branding: { ...form } });
    await bootstrap.load(true); // refresh the operator's own live branding (e.g. the consent page)
    message.value = t('appearanceView.savedSuccess');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('appearanceView.couldNotSave');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="topbar">
    <h1>{{ t('appearanceView.title') }}</h1>
    <button v-if="canWrite" class="btn primary" :disabled="saving || loading" @click="save">
      {{ saving ? t('appearanceView.saving') : t('appearanceView.saveChanges') }}
    </button>
  </div>
  <p class="muted intro" v-html="t('appearanceView.intro')"></p>

  <div v-if="message" class="alert success">{{ message }}</div>
  <div v-if="error" class="alert error">{{ error }}</div>
  <p v-if="loading" class="muted">{{ t('appearanceView.loading') }}</p>

  <div v-else class="appearance">
    <!-- ── Editor ── -->
    <div class="ap-form">
      <div class="field">
        <label>{{ t('appearanceView.languageLabel') }}</label>
        <select v-model="locale" :disabled="!canWrite">
          <option v-for="l in AVAILABLE_LOCALES" :key="l.code" :value="l.code">{{ l.name }}</option>
        </select>
        <small class="muted">{{ t('appearanceView.languageHint') }}</small>
      </div>

      <div class="field">
        <label>{{ t('appearanceView.brandNameLabel') }}</label>
        <input v-model="form.brandName" :disabled="!canWrite" :placeholder="t('appearanceView.brandNamePlaceholder')" maxlength="80" />
        <small class="muted">{{ t('appearanceView.brandNameHint') }}</small>
      </div>

      <div class="field">
        <label>{{ t('appearanceView.taglineLabel') }}</label>
        <input v-model="form.tagline" :disabled="!canWrite" :placeholder="t('appearanceView.taglinePlaceholder')" maxlength="160" />
        <small class="muted">{{ t('appearanceView.taglineHint') }}</small>
      </div>

      <div class="field">
        <label>{{ t('appearanceView.logoLabel') }}</label>
        <div class="logo-row">
          <span class="logo-box"><BrandLogo :size="40" :logo="form.logoDataUri" /></span>
          <label class="btn">
            {{ form.logoDataUri ? t('appearanceView.logoReplace') : t('appearanceView.logoUpload') }}
            <input type="file" accept="image/*" :disabled="!canWrite" style="display: none" @change="onLogoFile" />
          </label>
          <button v-if="form.logoDataUri" class="btn" :disabled="!canWrite" @click="removeLogo">{{ t('appearanceView.remove') }}</button>
        </div>
        <small class="muted">{{ t('appearanceView.logoHint') }}</small>
      </div>

      <div class="field">
        <label>{{ t('appearanceView.primaryColorLabel') }}</label>
        <div class="logo-row">
          <input type="color" :value="form.primaryColor || '#325ea8'" :disabled="!canWrite" @input="form.primaryColor = ($event.target as HTMLInputElement).value" />
          <input v-model="form.primaryColor" :disabled="!canWrite" placeholder="#325ea8" style="max-width: 130px" />
          <button v-if="form.primaryColor" class="btn" :disabled="!canWrite" @click="resetColor">{{ t('appearanceView.reset') }}</button>
        </div>
        <small class="muted">{{ t('appearanceView.primaryColorHint') }}</small>
      </div>

      <div class="field">
        <label>
          <button class="linkish" @click="showCss = !showCss">{{ showCss ? '▾' : '▸' }} {{ t('appearanceView.advancedCss') }}</button>
        </label>
        <template v-if="showCss">
          <textarea v-model="form.cssOverride" :disabled="!canWrite" rows="6" spellcheck="false" placeholder="/* e.g. */
.chat-sidebar { background: #0b1b2b; }"></textarea>
          <small class="muted" v-html="t('appearanceView.cssHint')"></small>
        </template>
      </div>
    </div>

    <!-- ── Live preview + where-it-appears ── -->
    <div class="ap-preview">
      <div class="preview-label">{{ t('appearanceView.previewLabel') }}</div>
      <div class="preview-surfaces" :style="previewStyle">
        <!-- Login card -->
        <div class="pv-card">
          <div class="pv-badge">{{ t('appearanceView.loginScreenBadge') }}</div>
          <div class="pv-brand">
            <BrandLogo :size="40" :logo="form.logoDataUri" />
            <div class="pv-name">{{ previewName }}</div>
            <div class="pv-tag">{{ previewTagline }}</div>
            <PoweredByKravn v-if="previewCustomized" style="margin-top: 4px" />
          </div>
          <div class="pv-btn">{{ t('appearanceView.signIn') }}</div>
        </div>

        <!-- Sidebar header -->
        <div class="pv-side">
          <div class="pv-badge">{{ t('appearanceView.chatSidebarBadge') }}</div>
          <div class="pv-side-brand"><BrandLogo :size="22" :logo="form.logoDataUri" /> <strong>{{ previewName }}</strong></div>
          <PoweredByKravn v-if="previewCustomized" style="padding-left: 2px" />
        </div>
      </div>
      <p class="muted where" v-html="t('appearanceView.whereText')"></p>
    </div>
  </div>
</template>

<style scoped>
.intro {
  max-width: 60ch;
}
.appearance {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1.5rem;
  align-items: start;
}
@media (max-width: 900px) {
  .appearance {
    grid-template-columns: 1fr;
  }
}
.ap-form .field {
  margin-bottom: 1.1rem;
}
.logo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.logo-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-surface, transparent);
}
input[type='color'] {
  width: 44px;
  height: 34px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: none;
  cursor: pointer;
}
.linkish {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font: inherit;
}
.ap-preview {
  position: sticky;
  top: 1rem;
}
.preview-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 8px;
}
.preview-surfaces {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pv-card,
.pv-side {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  background: var(--bg-surface, rgba(127, 127, 127, 0.04));
}
.pv-badge {
  position: absolute;
  top: 8px;
  right: 10px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.pv-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  text-align: center;
  padding: 8px 0 16px;
}
.pv-name {
  font-weight: 700;
  font-size: 18px;
}
.pv-tag {
  font-size: 12px;
  color: var(--text-muted);
}
.pv-btn {
  text-align: center;
  padding: 9px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.pv-side-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.pv-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.where {
  margin-top: 12px;
  font-size: 12px;
}
</style>
