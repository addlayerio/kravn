<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from './stores/auth';
import RavenLogo from './RavenLogo.vue';

const props = withDefaults(defineProps<{ size?: number }>(), { size: 32 });
const auth = useAuthStore();
const logo = computed(() => auth.info?.branding?.logoDataUri || '');
</script>

<template>
  <img
    v-if="logo"
    :src="logo"
    alt=""
    class="brand-logo-img"
    :style="{ height: size + 'px', maxWidth: size * 5 + 'px' }"
  />
  <RavenLogo v-else :size="size" />
</template>

<style scoped>
.brand-logo-img {
  object-fit: contain;
  display: block;
}
</style>
