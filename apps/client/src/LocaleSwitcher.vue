<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { AVAILABLE_LOCALES, type LocaleCode } from '@kravn/contracts';
import { setLocale } from './i18n';

const { locale } = useI18n();
function onChange(e: Event) {
  setLocale((e.target as HTMLSelectElement).value as LocaleCode);
}
</script>

<template>
  <select class="locale-switcher" :value="locale" :aria-label="'Language'" @change="onChange">
    <option v-for="l in AVAILABLE_LOCALES" :key="l.code" :value="l.code">{{ l.name }}</option>
  </select>
</template>

<style scoped>
.locale-switcher {
  width: 100%;
  margin-bottom: 8px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text);
  font-size: 12px;
  box-sizing: border-box;
  cursor: pointer;
}
</style>
