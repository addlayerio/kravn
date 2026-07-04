<script setup lang="ts">
/**
 * Kravn brand mark — a stylised raven in profile. Uses `currentColor` so the
 * parent themes it via CSS `color` (defaults to --brand). Path data shared via @kravn/ui.
 */
import { PATH_HEAD, PATH_BODY, RAVEN_VIEWBOX, RAVEN_TRANSFORM } from '@kravn/ui/raven';

withDefaults(
  defineProps<{
    size?: number;
    background?: 'none' | 'tile';
  }>(),
  { size: 32, background: 'none' },
);
</script>

<template>
  <span
    class="raven-logo"
    :class="{ tile: background === 'tile' }"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-label="Kravn"
  >
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
  color: var(--accent);
}
.raven-logo.tile {
  background: var(--bg-brand-tile);
  border-radius: var(--radius-md);
  padding: 14%;
  box-sizing: border-box;
}
.raven-logo.tile svg {
  width: 100% !important;
  height: 100% !important;
}
</style>
