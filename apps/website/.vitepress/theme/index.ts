import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import IntegrationsGallery from './IntegrationsGallery.vue';
import ArchitectureDiagram from './ArchitectureDiagram.vue';
import PhBadge from './PhBadge.vue';
import './custom.css';

// The stock VitePress theme, re-skinned with Kravn's brand palette in custom.css, plus the
// generated integrations gallery and the architecture diagram used across the docs.
export default {
  extends: DefaultTheme,
  // Render the Product Hunt launch badge right under the hero (before the feature cards) via the
  // home-hero-after slot, so it isn't buried below the page content.
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-after': () => h(PhBadge),
    });
  },
  enhanceApp({ app }) {
    app.component('IntegrationsGallery', IntegrationsGallery);
    app.component('ArchitectureDiagram', ArchitectureDiagram);
  },
} satisfies Theme;
