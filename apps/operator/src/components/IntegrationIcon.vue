<script setup lang="ts">
import { computed } from 'vue';
import { BRAND_ICONS } from '@kravn/contracts';

const props = withDefaults(defineProps<{ id?: string; name: string; size?: number }>(), { size: 30 });

const brand = computed(() => (props.id ? BRAND_ICONS[props.id] : undefined));

/** Deterministic hue from the name, for the monogram tile when no brand logo exists. */
const monogram = computed(() => {
  const name = props.name || '?';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  // Two initials for multi-word names (e.g. "New Relic" -> "NR"), else first letter.
  const words = name.replace(/[^\w ]/g, '').trim().split(/\s+/).filter(Boolean);
  const initials = (words.length >= 2 ? words[0][0] + words[1][0] : name.replace(/[^\w]/g, '').slice(0, 2) || '?').toUpperCase();
  return { initials, bg: `hsl(${h} 45% 42%)` };
});
</script>

<template>
  <span class="int-icon" :style="{ '--sz': size + 'px' }" :title="name" aria-hidden="true">
    <span v-if="brand" class="int-brand">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path :d="brand.path" :fill="brand.hex" /></svg>
    </span>
    <span v-else class="int-mono" :style="{ background: monogram.bg }">{{ monogram.initials }}</span>
  </span>
</template>

<style scoped>
.int-icon {
  display: inline-flex;
  flex: 0 0 auto;
  width: var(--sz);
  height: var(--sz);
}
.int-brand,
.int-mono {
  width: 100%;
  height: 100%;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* Brand logos are designed on white; a light tile reads cleanly in both themes. */
.int-brand {
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  padding: 16%;
  box-sizing: border-box;
}
.int-brand svg {
  width: 100%;
  height: 100%;
  display: block;
}
.int-mono {
  color: #fff;
  font-weight: 700;
  font-size: calc(var(--sz) * 0.4);
  letter-spacing: -0.02em;
  line-height: 1;
}
</style>
