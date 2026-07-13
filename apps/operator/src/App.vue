<script setup lang="ts">
import { watch } from 'vue';
import ToastHost from './components/ToastHost.vue';
import { useBootstrapStore } from './stores/bootstrap';
import { applyInstanceLocale } from './i18n';

// Apply the instance-default locale from bootstrap (never overrides a user's own choice).
const bootstrap = useBootstrapStore();
watch(() => bootstrap.info, (info) => applyInstanceLocale(info?.locale), { immediate: true });
</script>

<template>
  <RouterView />
  <ToastHost />
</template>
