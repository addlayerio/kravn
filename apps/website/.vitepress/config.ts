import { defineConfig } from 'vitepress';

// Served from the custom domain kravn.ai (apex). `base` is '/' and public/CNAME pins the domain on every deploy.
const HOSTNAME = 'https://kravn.ai';
const BASE = '/';

export default defineConfig({
  base: BASE,
  lang: 'en-US',
  // ⚠️ SEO / OpenGraph limits before editing title/description/image — see apps/website/SEO.md:
  //   meta description ≤160 · og:description ≤125 (SEPARATE string) · home <title> 50–60 chars ·
  //   og.png = PNG 1200×630 with a CTA (regen from og-source.svg) · HOSTNAME drives all absolute URLs.
  title: 'Kravn',
  titleTemplate: ':title · Kravn',
  description:
    'Kravn is a self-hostable enterprise MCP gateway: bring the Model Context Protocol on-prem, with SSO/SCIM/RBAC and no data leaving your network.',
  cleanUrls: true,
  lastUpdated: true,
  metaChunk: true,

  // localhost URLs are legitimate examples in the install/quickstart docs, not broken links.
  ignoreDeadLinks: [/^https?:\/\/localhost/],

  // The app README is developer docs, not a site page.
  srcExclude: ['README.md'],

  head: [
    ['link', { rel: 'icon', href: `${BASE}favicon.svg`, type: 'image/svg+xml' }],
    // Cloudflare Web Analytics — privacy-first + cookieless (no consent banner needed). Token is public by design.
    ['script', { defer: '', src: 'https://static.cloudflareinsights.com/beacon.min.js', 'data-cf-beacon': '{"token": "21ef1756069e40c1b49b7dac4a01b2db"}' }],
    ['meta', { name: 'theme-color', content: '#0f1115' }],
    ['meta', { name: 'author', content: 'AddLayer' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Kravn' }],
    ['meta', { property: 'og:title', content: 'Kravn — the enterprise MCP gateway' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Self-hostable enterprise MCP gateway: on-prem, SSO/SCIM/RBAC, no data egress — up in one command.',
      },
    ],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    // ?v=N busts social/scraper caches when the image CONTENT changes but the path stays the same.
    // Bump the number whenever you regenerate og.png (see apps/website/SEO.md).
    ['meta', { property: 'og:image', content: `${HOSTNAME}/og.png?v=2` }],
    ['meta', { name: 'twitter:image', content: `${HOSTNAME}/og.png?v=2` }],
    [
      'script',
      { type: 'application/ld+json' },
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Kravn',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Docker, Kubernetes, Linux',
        url: HOSTNAME,
        description:
          'Kravn — a self-hostable, enterprise MCP gateway, registry and proxy. Bring the Model Context Protocol to your organization on your own infrastructure, integrated with your identity stack (SAML/OIDC/SCIM/RBAC), with no data ever leaving your perimeter.',
        author: { '@type': 'Organization', name: 'AddLayer', url: HOSTNAME },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        license: 'https://github.com/addlayerio/kravn/blob/main/LICENSE',
        sameAs: ['https://github.com/addlayerio/kravn'],
      }),
    ],
  ],

  sitemap: { hostname: `${HOSTNAME}/` },

  // Per-page canonical + og:url — critical for SEO and correct social unfurls on every page, not just home.
  transformPageData(pageData) {
    let slug = pageData.relativePath.replace(/\.md$/, '');
    if (slug === 'index') slug = '';
    else slug = slug.replace(/\/index$/, '');
    const url = `${HOSTNAME}/${slug}`;
    // The home <title> should use the SERP space (50–60 chars); sub-pages keep the "· Kravn" template.
    if (slug === '') {
      pageData.title = 'Kravn — the self-hosted enterprise MCP gateway';
      pageData.titleTemplate = false;
    }
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:url', content: url }],
    );
  },

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
