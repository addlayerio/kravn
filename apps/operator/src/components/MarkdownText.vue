<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown, renderMarkdownInline } from '../lib/markdown';

const props = withDefaults(defineProps<{ text?: string; inline?: boolean }>(), { inline: false });

// Safe: renderMarkdown uses markdown-it with html:false (raw HTML escaped) + link-scheme validation,
// so v-html here cannot inject markup even for imported-plugin text.
const html = computed(() => (props.inline ? renderMarkdownInline(props.text) : renderMarkdown(props.text)));
</script>

<template>
  <div class="md" :class="{ 'md-inline': inline }" v-html="html"></div>
</template>

<style scoped>
.md {
  line-height: 1.55;
  font-size: 0.9rem;
  color: var(--text);
}
.md-inline {
  display: inline;
}
.md :deep(p) {
  margin: 0 0 0.6rem;
}
.md :deep(p:last-child) {
  margin-bottom: 0;
}
.md :deep(ul),
.md :deep(ol) {
  margin: 0.3rem 0 0.6rem;
  padding-left: 1.3rem;
}
.md :deep(li) {
  margin: 0.2rem 0;
}
.md :deep(li)::marker {
  color: var(--text-muted);
}
.md :deep(a) {
  color: var(--accent, var(--brand));
  text-decoration: none;
}
.md :deep(a:hover) {
  text-decoration: underline;
}
.md :deep(code) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.85em;
  background: var(--hover);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
  word-break: break-word;
}
.md :deep(pre) {
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  overflow-x: auto;
  margin: 0.4rem 0 0.7rem;
}
.md :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
}
.md :deep(strong) {
  font-weight: 650;
  color: var(--text);
}
.md :deep(h3),
.md :deep(h4) {
  font-size: 0.92rem;
  font-weight: 650;
  margin: 0.7rem 0 0.35rem;
}
.md :deep(:first-child) {
  margin-top: 0;
}
</style>
