import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import IntegrationsGallery from './IntegrationsGallery.vue';
import ArchitectureDiagram from './ArchitectureDiagram.vue';
import './custom.css';

// The stock VitePress theme, re-skinned with Kravn's brand palette in custom.css, plus the
// generated integrations gallery and the architecture diagram used across the docs.
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('IntegrationsGallery', IntegrationsGallery);
    app.component('ArchitectureDiagram', ArchitectureDiagram);
  },
} satisfies Theme;
