<script setup lang="ts">
import { PATH_HEAD, PATH_BODY, RAVEN_VIEWBOX, RAVEN_TRANSFORM } from '@kravn/ui/raven';
withDefaults(defineProps<{ size?: number }>(), { size: 32 });
</script>

<template>
  <span class="raven-logo" :style="{ width: `${size}px`, height: `${size}px` }" aria-label="Kravn">
    <svg :width="size" :height="size" :viewBox="RAVEN_VIEWBOX" fill="none" role="img">
      <g :transform="RAVEN_TRANSFORM" fill="currentColor">
        <path :d="PATH_HEAD" />
        <path :d="PATH_BODY" />
      </g>
    </svg>
  </span>
</template>

<style scoped>
.raven-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--brand);
}
</style>
