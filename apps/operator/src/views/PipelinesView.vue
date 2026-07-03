<script setup lang="ts">
import PipelineEditor from '../components/PipelineEditor.vue';
</script>

<template>
  <div class="topbar">
    <div>
      <h1>Pipelines · Global</h1>
      <p class="muted">
        The <strong>global</strong> pipeline runs for all traffic. Add hook plugins to each MCP lifecycle
        junction, in the order you want — only the plugins you add here run. To add a plugin just for one
        MCP endpoint, edit that MCP endpoint and use its own pipeline.
      </p>
    </div>
  </div>

  <PipelineEditor scope="global" />
</template>

<style scoped>
.muted { color: var(--text-muted); }
</style>
