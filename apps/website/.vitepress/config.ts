import { defineConfig } from 'vitepress';

// Deployed to GitHub Pages at https://addlayerio.github.io/kravn/ → the site lives under the `/kravn/` path.
// If you point a custom domain (a CNAME) at the root, change `base` to '/' and update the favicon hrefs below.
const BASE = '/kravn/';

export default defineConfig({
  base: BASE,
  lang: 'en-US',
  title: 'Kravn',
  titleTemplate: ':title · Kravn',
  description:
    'Kravn — a self-hostable, enterprise MCP gateway, registry and proxy. Bring the Model Context Protocol to your organization on your own infrastructure, governed by your own policies, with no data ever leaving your perimeter.',
  cleanUrls: true,
  lastUpdated: true,
  metaChunk: true,

  // localhost URLs are legitimate examples in the install/quickstart docs, not broken links.
  ignoreDeadLinks: [/^https?:\/\/localhost/],

  // The app README is developer docs, not a site page.
  srcExclude: ['README.md'],

  head: [
    ['link', { rel: 'icon', href: `${BASE}favicon.svg`, type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#0f1115' }],
    ['meta', { name: 'author', content: 'AddLayer' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Kravn' }],
    ['meta', { property: 'og:title', content: 'Kravn — the enterprise MCP gateway' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Self-hostable MCP gateway, registry and proxy for the enterprise. Corporate identity (SAML/OIDC/SCIM/RBAC), no data egress, one-command install.',
      },
    ],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],

  sitemap: { hostname: 'https://addlayerio.github.io/kravn/' },

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Kravn',

    nav: [
      { text: 'Why Kravn', link: '/guide/what-is-kravn', activeMatch: '/guide/what-is-kravn' },
      { text: 'Get Started', link: '/guide/getting-started' },
      { text: 'Install', link: '/guide/installation' },
      {
        text: 'Docs',
        items: [
          { text: 'Core concepts', link: '/guide/concepts' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Plugins & integrations', link: '/guide/plugins' },
          { text: 'Security & compliance', link: '/guide/security' },
        ],
      },
      {
        text: 'Resources',
        items: [
          { text: 'GitHub', link: 'https://github.com/addlayerio/kravn' },
          { text: 'Changelog (SECURITY.md)', link: 'https://github.com/addlayerio/kravn/blob/main/SECURITY.md' },
          { text: 'License (BSL 1.1)', link: 'https://github.com/addlayerio/kravn/blob/main/LICENSE' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Why Kravn', link: '/guide/what-is-kravn' },
            { text: 'Core concepts', link: '/guide/concepts' },
          ],
        },
        {
          text: 'Getting started',
          items: [
            { text: 'Quickstart', link: '/guide/getting-started' },
            { text: 'Installation manual', link: '/guide/installation' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Capabilities',
          items: [
            { text: 'Plugins & integrations', link: '/guide/plugins' },
            { text: 'Security & compliance', link: '/guide/security' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/addlayerio/kravn' }],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/addlayerio/kravn/edit/main/apps/website/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Source-available under the Business Source License 1.1 (converts to Apache 2.0). Built by AddLayer.',
      copyright: '© 2026 AddLayer',
    },

    outline: { level: [2, 3] },
  },
});
