<script setup lang="ts">
import { computed } from 'vue';
import { useBootstrapStore } from '../stores/bootstrap';
import RavenLogo from './RavenLogo.vue';

const props = withDefaults(defineProps<{ size?: number; logo?: string }>(), { size: 32, logo: undefined });
const bootstrap = useBootstrapStore();
// An explicit `logo` prop wins (used by the Appearance preview); otherwise use the live branding.
const src = computed(() => (props.logo !== undefined ? props.logo : bootstrap.info?.branding?.logoDataUri || ''));
</script>

<template>
  <img v-if="src" :src="src" alt="" class="brand-logo-img" :style="{ height: size + 'px', maxWidth: size * 5 + 'px' }" />
  <RavenLogo v-else :size="size" />
</template>

<style scoped>
.brand-logo-img {
  object-fit: contain;
  display: block;
}
</style>
