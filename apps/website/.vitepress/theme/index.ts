import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import IntegrationsGallery from './IntegrationsGallery.vue';
import './custom.css';

// The stock VitePress theme, re-skinned with Kravn's brand palette in custom.css, plus the
// generated integrations gallery component (used on the landing page and /integrations).
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('IntegrationsGallery', IntegrationsGallery);
  },
} satisfies Theme;
