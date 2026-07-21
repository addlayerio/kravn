import { defineConfig } from 'vitepress';

// Served from the custom domain kravn.ai (apex). `base` is '/' and public/CNAME pins the domain on every deploy.
const HOSTNAME = 'https://kravn.ai';
const BASE = '/';

// FAQPage structured data for /faq. Mirrors the visible Q&A in faq.md so the answers Google/AI engines
// read match the page. Keep the two in sync when editing either.
const FAQ_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    ['What is Kravn?', 'Kravn is a self-hostable MCP gateway, registry and proxy. It brings the Model Context Protocol to your organization on your own infrastructure, integrated with your identity stack (SAML, OIDC, SCIM, RBAC), with no data ever leaving your perimeter.'],
    ['What is an MCP gateway?', 'An MCP gateway sits between AI clients and the MCP servers they need: it connects to many upstream MCP servers, imports their tools, resources and prompts into one registry, and re-exposes them behind a single governed endpoint, so every call passes through access control and policy.'],
    ['Is Kravn free and open-source?', 'Kravn is source-available and free to self-host. It is licensed under the Business Source License 1.1 (BSL 1.1), which converts to Apache 2.0 after four years. You can read the source, run it, and self-host it at no cost.'],
    ['Is there a paid or enterprise edition?', 'No. There is one edition. The enterprise capabilities — SSO, SCIM, RBAC, governance pipelines, audit, KMS/HSM key management — are in the product you self-host, not behind a paywall or a per-seat license.'],
    ['Does my data leave my network with Kravn?', 'No. Kravn is self-hosted by design and runs entirely on your infrastructure via Docker or Helm. There is no data egress and no third-party dependency in the request path.'],
    ['How is Kravn different from IBM MCP Context Forge?', 'IBM MCP Context Forge is a broad, mature, Python-based MCP gateway. Kravn is a leaner, identity-first take built in TypeScript (Fastify + Vue 3): it boots in one command, is configured at runtime, and leads with corporate identity, governance and audit for compliance-bound teams.'],
    ['Which identity providers does Kravn support?', 'SAML and OAuth2 / OIDC single sign-on, SCIM 2.0 provisioning, role-based access control, teams, and per-team MCP and tool entitlements, out of the box.'],
    ['How do I install Kravn?', 'Run docker compose up or helm install with zero overrides and it is running — embedded SQLite, an auto-generated signing key and a first-run setup wizard.'],
    ['Which databases does Kravn support?', 'A portable store over SQLite, PostgreSQL, MySQL / MariaDB, or SQL Server, with versioned migrations. SQLite is embedded so a fresh install needs no external database.'],
    ['What can Kravn connect to?', 'Any upstream MCP server over streamable-HTTP, SSE or stdio, plus a curated catalog of 100+ public MCP servers, and native integrations for SharePoint, Microsoft Teams, Jira and Confluence over the vendor API.'],
    ['Is Kravn ready for regulated or bank environments?', 'That is the design center: governance pipelines (redact secrets and PII, guard against prompt injection), a tamper-evident audit trail, KMS/HSM-backed key management, separation-of-duties / maker-checker controls, and SBOM plus signed images.'],
  ].map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
};

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
    // Multiple formats so Google (and browsers) reliably pick up the favicon — Google prefers a
    // crawlable .ico / square PNG (multiple of 48px) alongside the SVG.
    ['link', { rel: 'icon', href: `${BASE}favicon.svg`, type: 'image/svg+xml' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '96x96', href: `${BASE}favicon-96x96.png` }],
    ['link', { rel: 'shortcut icon', href: `${BASE}favicon.ico` }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: `${BASE}apple-touch-icon.png` }],
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
        applicationSubCategory: 'MCP gateway',
        operatingSystem: 'Docker, Kubernetes, Linux',
        url: HOSTNAME,
        description:
          'Kravn — a self-hostable, enterprise MCP gateway, registry and proxy. Bring the Model Context Protocol to your organization on your own infrastructure, integrated with your identity stack (SAML/OIDC/SCIM/RBAC), with no data ever leaving your perimeter.',
        featureList: [
          'Self-hosted MCP gateway, registry and proxy (Docker / Helm)',
          'No data egress — runs entirely on your infrastructure',
          'Enterprise identity: SAML, OAuth2/OIDC SSO, SCIM 2.0, RBAC, teams',
          'Per-team MCP server and tool entitlements',
          'Governance pipelines: redact secrets/PII, prompt-injection guard, tamper-evident audit',
          'Catalog of 100+ public MCP servers plus native SharePoint, Teams, Jira, Confluence',
          'Boots in one command with a first-run setup wizard; runtime config, no redeploy',
          'KMS/HSM key management, SBOM and signed images',
        ],
        author: { '@type': 'Organization', name: 'AddLayer', url: HOSTNAME },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        license: 'https://github.com/addlayerio/kravn/blob/main/LICENSE',
        sameAs: ['https://github.com/addlayerio/kravn'],
      }),
    ],
    [
      'script',
      { type: 'application/ld+json' },
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'AddLayer',
        url: HOSTNAME,
        logo: `${HOSTNAME}/logo.svg`,
        description: 'AddLayer builds Kravn — a self-hostable, source-available enterprise MCP gateway.',
        sameAs: ['https://github.com/addlayerio', 'https://github.com/addlayerio/kravn'],
      }),
    ],
    [
      'script',
      { type: 'application/ld+json' },
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'Kravn',
        url: HOSTNAME,
        publisher: { '@type': 'Organization', name: 'AddLayer' },
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
    // Rich results: the FAQ page carries FAQPage structured data (answers mirror the visible Q&A).
    if (slug === 'faq') {
      pageData.frontmatter.head.push(['script', { type: 'application/ld+json' }, JSON.stringify(FAQ_JSONLD)]);
    }
    // Learn articles carry TechArticle + BreadcrumbList structured data (title/description from frontmatter).
    if (slug.startsWith('learn/')) {
      const title = pageData.frontmatter.title ?? pageData.title;
      const description = pageData.frontmatter.description ?? '';
      pageData.frontmatter.head.push(
        ['script', { type: 'application/ld+json' }, JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: title,
          description,
          url,
          mainEntityOfPage: url,
          author: { '@type': 'Organization', name: 'AddLayer', url: HOSTNAME },
          publisher: { '@type': 'Organization', name: 'AddLayer', logo: { '@type': 'ImageObject', url: `${HOSTNAME}/logo.svg` } },
          isPartOf: { '@type': 'CollectionPage', name: 'Learn', url: `${HOSTNAME}/learn` },
        })],
        ['script', { type: 'application/ld+json' }, JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: HOSTNAME },
            { '@type': 'ListItem', position: 2, name: 'Learn', item: `${HOSTNAME}/learn` },
            { '@type': 'ListItem', position: 3, name: title, item: url },
          ],
        })],
      );
    }
  },

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Kravn',

    nav: [
      { text: 'Why Kravn', link: '/guide/what-is-kravn', activeMatch: '/guide/what-is-kravn' },
      { text: 'Compare', link: '/comparison' },
      { text: 'Learn', link: '/learn/', activeMatch: '/learn/' },
      { text: 'Integrations', link: '/integrations' },
      { text: 'Get Started', link: '/guide/getting-started' },
      { text: 'Install', link: '/guide/installation' },
      { text: 'FAQ', link: '/faq' },
      {
        text: 'Docs',
        items: [
          { text: 'Core concepts', link: '/guide/concepts' },
          { text: 'The governed client', link: '/guide/client' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Plugins & integrations', link: '/guide/plugins' },
          { text: 'Security & compliance', link: '/guide/security' },
          { text: 'Key management (KMS/HSM)', link: '/guide/key-management' },
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
            { text: 'The governed client', link: '/guide/client' },
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
            { text: 'Key management (KMS/HSM)', link: '/guide/key-management' },
            { text: 'Disaster recovery & continuity', link: '/guide/dr-bcp' },
          ],
        },
      ],
      '/learn/': [
        {
          text: 'Fundamentals',
          items: [
            { text: 'What is MCP?', link: '/learn/what-is-model-context-protocol' },
            { text: 'What is an MCP Gateway?', link: '/learn/what-is-an-mcp-gateway' },
            { text: 'What is an MCP Registry?', link: '/learn/mcp-registry' },
            { text: 'MCP Proxy', link: '/learn/mcp-proxy' },
            { text: 'MCP Reverse Proxy', link: '/learn/mcp-reverse-proxy' },
            { text: 'MCP vs API Gateway', link: '/learn/mcp-vs-api-gateway' },
          ],
        },
        {
          text: 'Security & governance',
          items: [
            { text: 'MCP Authentication', link: '/learn/mcp-authentication' },
            { text: 'MCP Authorization', link: '/learn/mcp-authorization' },
            { text: 'MCP Security', link: '/learn/mcp-security' },
            { text: 'MCP Governance', link: '/learn/mcp-governance' },
            { text: 'Tool Poisoning & Rug-Pull', link: '/learn/mcp-tool-poisoning' },
          ],
        },
        {
          text: 'Enterprise & operations',
          items: [
            { text: 'Enterprise MCP Architecture', link: '/learn/enterprise-mcp-architecture' },
            { text: 'MCP for Regulated Industries', link: '/learn/mcp-for-regulated-industries' },
            { text: 'MCP Observability & Auditing', link: '/learn/mcp-observability' },
            { text: 'Running MCP On-Premise', link: '/learn/running-mcp-on-premise' },
            { text: 'Deploying MCP in Kubernetes', link: '/learn/deploying-mcp-in-kubernetes' },
            { text: 'MCP Best Practices', link: '/learn/mcp-best-practices' },
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
      message:
        'Source-available under the Business Source License 1.1 (converts to Apache 2.0). Built by AddLayer. · ' +
        '<a href="https://buymeacoffee.com/kravn" class="coffee-link">☕ Buy me a coffee</a>',
      copyright: '© 2026 AddLayer',
    },

    outline: { level: [2, 3] },
  },
});
