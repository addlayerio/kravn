<script setup lang="ts">
import { watch } from 'vue';
import { useAuthStore } from './stores/auth';
import { applyBranding } from './lib/branding';
import { applyInstanceLocale } from './i18n';

// React to the public bootstrap info arriving/changing (runs before login, too).
const auth = useAuthStore();
watch(
  () => auth.info,
  (info) => {
    applyBranding(info);
    applyInstanceLocale(info?.locale); // instance default; never overrides the user's own choice
  },
  { immediate: true },
);
</script>

<template>
  <RouterView />
</template>
