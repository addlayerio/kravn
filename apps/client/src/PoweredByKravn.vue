<script setup lang="ts">
import { PATH_HEAD, PATH_BODY, RAVEN_VIEWBOX, RAVEN_TRANSFORM } from '@kravn/ui/raven';
// The raven + wordmark are hard-coloured (not var(--accent)/currentColor) on purpose: this attribution
// must stay legible and un-recolourable even under a custom primary colour or a raw CSS override.
</script>

<template>
  <a
    class="powered-by"
    data-kravn-attribution="1"
    href="https://kravn.ai"
    target="_blank"
    rel="noopener noreferrer"
    aria-label="Powered by Kravn"
  >
    <svg :width="13" :height="13" :viewBox="RAVEN_VIEWBOX" fill="none" role="img" aria-hidden="true">
      <g :transform="RAVEN_TRANSFORM" fill="#c9892c">
        <path :d="PATH_HEAD" />
        <path :d="PATH_BODY" />
      </g>
    </svg>
    <span class="pbk-text">Powered by <strong>Kravn</strong></span>
  </a>
</template>

<style scoped>
.powered-by {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 1;
  color: #9096a1;
  text-decoration: none;
}
.powered-by:hover .pbk-text strong {
  text-decoration: underline;
}
.pbk-text strong {
  color: #c9892c;
  font-weight: 600;
}
</style>
