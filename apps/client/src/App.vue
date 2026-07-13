<script setup lang="ts">
import { watch } from 'vue';
import { useAuthStore } from './stores/auth';
import { applyBranding } from './lib/branding';

// Re-apply branding whenever the public bootstrap info arrives/changes (runs before login, too).
const auth = useAuthStore();
watch(() => auth.info, (info) => applyBranding(info), { immediate: true });
</script>

<template>
  <RouterView />
</template>
