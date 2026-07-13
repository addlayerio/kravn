<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import PipelineEditor from '../components/PipelineEditor.vue';

const { t } = useI18n();
</script>

<template>
  <div class="topbar">
    <div>
      <h1>{{ t('pipelinesView.title') }}</h1>
      <p class="muted" v-html="t('pipelinesView.description')"></p>
    </div>
  </div>

  <PipelineEditor scope="global" />
</template>

<style scoped>
.muted { color: var(--text-muted); }
</style>
