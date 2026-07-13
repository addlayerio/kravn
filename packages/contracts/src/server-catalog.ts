/**
 * Curated catalog of known public MCP servers, so an admin can browse and one-click-add them as
 * upstream servers instead of hand-typing a URL. Offline data (no network) shared by the gateway and
 * operator, mirroring LLM_MODEL_CATALOG. Sourced/adapted from public MCP server directories.
 *
 *  - `auth: 'open'`   -> no credential; connects today.
 *  - `auth: 'apikey'` -> the server takes an API key/token (added as a Bearer header); connects today.
 *  - `auth: 'oauth'`  -> the server requires an OAuth 2.1 handshake to the upstream; catalogued now,
 *                        one-click connect lands with upstream-OAuth support.
 */
export type CatalogAuth = 'open' | 'apikey' | 'oauth';

export interface CatalogServer {
  id: string;
  name: string;
  category: string;
  description: string;
  /** Remote MCP endpoint URL. */
  url: string;
  transport: 'streamable-http' | 'sse';
  auth: CatalogAuth;
  provider?: string;
  tags?: string[];
}

export const MCP_SERVER_CATALOG: CatalogServer[] = [
  {
    id: 'notion', name: 'Notion', category: 'Project Management',
    description: 'All-in-one workspace for notes, tasks, and collaboration',
    url: 'https://mcp.notion.com/sse', transport: 'sse', auth: 'oauth', provider: 'Notion',
    tags: ['project-management', 'documentation', 'wiki'],
  },
  {
    id: 'asana', name: 'Asana', category: 'Project Management',
    description: 'Task and project management platform for teams',
    url: 'https://mcp.asana.com/sse', transport: 'sse', auth: 'oauth', provider: 'Asana',
    tags: ['project-management', 'collaboration', 'tasks'],
  },
  {
    id: 'linear', name: 'Linear', category: 'Project Management',
    description: 'Modern project management for software teams',
    url: 'https://mcp.linear.app/sse', transport: 'sse', auth: 'oauth', provider: 'Linear',
    tags: ['project-management', 'issue-tracking', 'development'],
  },
  {
    id: 'monday', name: 'monday.com', category: 'Productivity',
    description: 'Work OS for teams to manage projects and workflows',
    url: 'https://mcp.monday.com/sse', transport: 'sse', auth: 'oauth', provider: 'monday MCP',
    tags: ['productivity', 'workflow', 'collaboration'],
  },
  {
    id: 'cloudflare-workers', name: 'Cloudflare Workers', category: 'Software Development',
    description: 'Serverless compute platform at the edge',
    url: 'https://bindings.mcp.cloudflare.com/sse', transport: 'sse', auth: 'oauth', provider: 'Cloudflare',
    tags: ['serverless', 'edge-computing', 'development'],
  },
  {
    id: 'cloudflare-observability', name: 'Cloudflare Observability', category: 'Observability',
    description: 'Monitor and analyze Cloudflare services',
    url: 'https://observability.mcp.cloudflare.com/sse', transport: 'sse', auth: 'oauth', provider: 'Cloudflare',
    tags: ['monitoring', 'observability', 'analytics'],
  },
  {
    id: 'grafbase', name: 'Grafbase', category: 'Software Development',
    description: 'GraphQL backend platform',
    url: 'https://api.grafbase.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Grafbase',
    tags: ['graphql', 'backend', 'api', 'development'],
  },
  {
    id: 'instant', name: 'Instant', category: 'Software Development',
    description: 'Real-time database platform',
    url: 'https://mcp.instantdb.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Instant',
    tags: ['database', 'real-time', 'development'],
  },
  {
    id: 'jam', name: 'Jam', category: 'Software Development',
    description: 'Bug reporting and debugging tool',
    url: 'https://mcp.jam.dev/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Jam.dev',
    tags: ['debugging', 'bug-tracking', 'development'],
  },
  {
    id: 'neon', name: 'Neon', category: 'Software Development',
    description: 'Serverless Postgres database',
    url: 'https://mcp.neon.tech/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Neon',
    tags: ['database', 'postgres', 'serverless'],
  },
  {
    id: 'netlify', name: 'Netlify', category: 'Software Development',
    description: 'Web hosting and serverless backend services',
    url: 'https://netlify-mcp.netlify.app/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Netlify',
    tags: ['hosting', 'deployment', 'serverless', 'jamstack'],
  },
  {
    id: 'sentry', name: 'Sentry', category: 'Software Development',
    description: 'Application monitoring and error tracking',
    url: 'https://mcp.sentry.dev/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Sentry',
    tags: ['monitoring', 'error-tracking', 'observability'],
  },
  {
    id: 'vercel', name: 'Vercel', category: 'Software Development',
    description: 'Platform for frontend frameworks and static sites',
    url: 'https://mcp.vercel.com/', transport: 'streamable-http', auth: 'oauth', provider: 'Vercel',
    tags: ['hosting', 'deployment', 'nextjs', 'serverless'],
  },
  {
    id: 'prisma-postgres', name: 'Prisma Postgres', category: 'Database',
    description: 'Type-safe database access and migrations',
    url: 'https://mcp.prisma.io/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Prisma Postgres',
    tags: ['database', 'orm', 'postgres', 'typescript'],
  },
  {
    id: 'globalping', name: 'Globalping', category: 'Software Development',
    description: 'Global network testing and monitoring',
    url: 'https://mcp.globalping.dev/sse', transport: 'sse', auth: 'oauth', provider: 'Globalping',
    tags: ['networking', 'monitoring', 'testing'],
  },
  {
    id: 'supabase', name: 'Supabase', category: 'Database',
    description: 'Open source Firebase alternative with Postgres',
    url: 'https://mcp.supabase.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Supabase',
    tags: ['database', 'postgres', 'backend', 'auth'],
  },
  {
    id: 'cortex', name: 'Cortex', category: 'Software Development',
    description: 'Internal developer portal and service catalog',
    url: 'https://mcp.cortex.io/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Cortex',
    tags: ['developer-portal', 'service-catalog', 'development'],
  },
  {
    id: 'stripe', name: 'Stripe', category: 'Payments',
    description: 'Payment processing and financial infrastructure',
    url: 'https://mcp.stripe.com/', transport: 'streamable-http', auth: 'oauth', provider: 'Stripe',
    tags: ['payments', 'billing', 'finance'],
  },
  {
    id: 'paypal', name: 'PayPal', category: 'Payments',
    description: 'Online payment processing',
    url: 'https://mcp.paypal.com/sse', transport: 'sse', auth: 'oauth', provider: 'PayPal',
    tags: ['payments', 'e-commerce', 'finance'],
  },
  {
    id: 'plaid', name: 'Plaid', category: 'Payments',
    description: 'Financial data aggregation and banking APIs',
    url: 'https://api.dashboard.plaid.com/mcp/sse', transport: 'sse', auth: 'oauth', provider: 'Plaid',
    tags: ['banking', 'finance', 'fintech'],
  },
  {
    id: 'square', name: 'Square', category: 'Payments',
    description: 'Payment processing and point-of-sale solutions',
    url: 'https://mcp.squareup.com/sse', transport: 'sse', auth: 'oauth', provider: 'Square',
    tags: ['payments', 'pos', 'e-commerce'],
  },
  {
    id: 'dodo-payments', name: 'Dodo Payments', category: 'Payments',
    description: 'Payment processing platform',
    url: 'https://mcp.dodopayments.com/sse', transport: 'sse', auth: 'apikey', provider: 'Dodo Payments',
    tags: ['payments', 'processing', 'finance'],
  },
  {
    id: 'mercado-pago', name: 'Mercado Pago', category: 'Payments',
    description: 'Payment solutions for Latin America',
    url: 'https://mcp.mercadopago.com/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Mercado Pago MCP Server',
    tags: ['payments', 'latam', 'e-commerce'],
  },
  {
    id: 'ramp', name: 'Ramp', category: 'Payments',
    description: 'Corporate card and spend management platform',
    url: 'https://ramp-mcp-remote.ramp.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Ramp',
    tags: ['payments', 'finance', 'expense-management'],
  },
  {
    id: 'close-crm', name: 'Close CRM', category: 'CRM',
    description: 'Sales CRM for small and medium businesses',
    url: 'https://mcp.close.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Close',
    tags: ['crm', 'sales', 'customer-management'],
  },
  {
    id: 'hubspot', name: 'HubSpot', category: 'CRM',
    description: 'Inbound marketing, sales, and service platform',
    url: 'https://app.hubspot.com/mcp/v1/http', transport: 'streamable-http', auth: 'apikey', provider: 'HubSpot',
    tags: ['crm', 'marketing', 'sales', 'automation'],
  },
  {
    id: 'intercom', name: 'Intercom', category: 'Customer Support',
    description: 'Customer messaging and support platform',
    url: 'https://mcp.intercom.com/sse', transport: 'sse', auth: 'oauth', provider: 'Intercom',
    tags: ['support', 'messaging', 'customer-service'],
  },
  {
    id: 'box', name: 'Box', category: 'Document Management',
    description: 'Cloud content management and file sharing',
    url: 'https://mcp.box.com', transport: 'streamable-http', auth: 'oauth', provider: 'Box',
    tags: ['storage', 'documents', 'collaboration'],
  },
  {
    id: 'egnyte', name: 'Egnyte', category: 'Document Management',
    description: 'Content collaboration and governance platform',
    url: 'https://mcp-server.egnyte.com/sse', transport: 'sse', auth: 'oauth', provider: 'Egnyte',
    tags: ['storage', 'documents', 'governance'],
  },
  {
    id: 'cloudinary', name: 'Cloudinary', category: 'Asset Management',
    description: 'Image and video management platform',
    url: 'https://asset-management.mcp.cloudinary.com/sse', transport: 'sse', auth: 'oauth', provider: 'Cloudinary',
    tags: ['media', 'images', 'video', 'cdn'],
  },
  {
    id: 'audioscrape', name: 'Audioscrape', category: 'RAG-as-a-Service',
    description: 'Audio content extraction and analysis',
    url: 'https://mcp.audioscrape.com', transport: 'streamable-http', auth: 'oauth', provider: 'Audioscrape',
    tags: ['audio', 'rag', 'ai', 'content-extraction'],
  },
  {
    id: 'carbon-voice', name: 'Carbon Voice', category: 'Productivity',
    description: 'Voice-based productivity tools',
    url: 'https://mcp.carbonvoice.app', transport: 'streamable-http', auth: 'oauth', provider: 'Carbon Voice',
    tags: ['voice', 'productivity', 'audio'],
  },
  {
    id: 'firefly', name: 'Firefly', category: 'Productivity',
    description: 'AI meeting assistant and transcription',
    url: 'https://api.fireflies.ai/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Firefly',
    tags: ['meetings', 'transcription', 'ai', 'productivity'],
  },
  {
    id: 'listenetic', name: 'Listenetic', category: 'Productivity',
    description: 'Audio analysis and processing platform',
    url: 'https://mcp.listenetic.com/v1/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Listenetic',
    tags: ['audio', 'analysis', 'productivity'],
  },
  {
    id: 'waystation', name: 'WayStation', category: 'Productivity',
    description: 'AI-powered productivity assistant',
    url: 'https://waystation.ai/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'WayStation',
    tags: ['ai', 'productivity', 'assistant'],
  },
  {
    id: 'zine', name: 'Zine', category: 'Memory',
    description: 'Personal knowledge management system',
    url: 'https://www.zine.ai/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Zine',
    tags: ['knowledge', 'memory', 'notes'],
  },
  {
    id: 'mypromind', name: 'myProMind', category: 'Productivity',
    description: 'AI-powered professional productivity tools',
    url: 'https://www.mypromind.com/interface/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'myProMind',
    tags: ['ai', 'productivity', 'professional'],
  },
  {
    id: 'canva', name: 'Canva', category: 'Design',
    description: 'Graphic design and visual content creation',
    url: 'https://mcp.canva.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Canva',
    tags: ['design', 'graphics', 'content-creation'],
  },
  {
    id: 'invideo', name: 'InVideo', category: 'Video Platform',
    description: 'Video creation and editing platform',
    url: 'https://mcp.invideo.io/sse', transport: 'sse', auth: 'oauth', provider: 'Invidio',
    tags: ['video', 'editing', 'content-creation'],
  },
  {
    id: 'vibemarketing', name: 'VibeMarketing', category: 'Marketing',
    description: 'AI-powered marketing content creation',
    url: 'https://vibemarketing.ninja/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'VibeMarketing',
    tags: ['marketing', 'content-creation', 'ai'],
  },
  {
    id: 'webflow', name: 'Webflow', category: 'CMS',
    description: 'Visual web design and CMS platform',
    url: 'https://mcp.webflow.com/sse', transport: 'sse', auth: 'oauth', provider: 'Webflow',
    tags: ['cms', 'web-design', 'no-code'],
  },
  {
    id: 'wix', name: 'Wix', category: 'CMS',
    description: 'Website builder and hosting platform',
    url: 'https://mcp.wix.com/sse', transport: 'sse', auth: 'oauth', provider: 'Wix',
    tags: ['cms', 'website-builder', 'hosting'],
  },
  {
    id: 'dialer', name: 'Dialer', category: 'Outbound Phone Calls',
    description: 'Automated outbound calling platform',
    url: 'https://getdialer.app/sse', transport: 'sse', auth: 'oauth', provider: 'Dialer',
    tags: ['phone', 'calling', 'communication'],
  },
  {
    id: 'thoughtspot', name: 'ThoughtSpot', category: 'Data Analytics',
    description: 'Search-driven analytics platform',
    url: 'https://agent.thoughtspot.app/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'ThoughtSpot',
    tags: ['analytics', 'bi', 'data', 'search'],
  },
  {
    id: 'scorecard', name: 'Scorecard', category: 'AI Evaluation',
    description: 'AI model evaluation and benchmarking',
    url: 'https://scorecard-mcp.dare-d5b.workers.dev/sse', transport: 'sse', auth: 'oauth', provider: 'Scorecard',
    tags: ['ai', 'evaluation', 'testing', 'ml'],
  },
  {
    id: 'morningstar', name: 'MorningStar', category: 'Data Analytics',
    description: 'Investment research and financial data analytics',
    url: 'https://mcp.morningstar.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'MorningStar',
    tags: ['finance', 'analytics', 'investment', 'data'],
  },
  {
    id: 'onecontext', name: 'OneContext', category: 'RAG-as-a-Service',
    description: 'Retrieval-augmented generation platform',
    url: 'https://rag-mcp-2.whatsmcp.workers.dev/sse', transport: 'sse', auth: 'oauth', provider: 'OneContext',
    tags: ['rag', 'ai', 'search', 'retrieval'],
  },
  {
    id: 'needle', name: 'Needle', category: 'RAG-as-a-Service',
    description: 'Document search and retrieval AI',
    url: 'https://mcp.needle-ai.com/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Needle',
    tags: ['rag', 'ai', 'search', 'documents'],
  },
  {
    id: 'dappier', name: 'Dappier', category: 'RAG-as-a-Service',
    description: 'Content discovery and recommendation engine',
    url: 'https://mcp.dappier.com/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Dappier',
    tags: ['rag', 'ai', 'content', 'recommendations'],
  },
  {
    id: 'deepwiki', name: 'DeepWiki', category: 'RAG-as-a-Service',
    description: 'Knowledge base with deep learning integration',
    url: 'https://mcp.deepwiki.com/mcp', transport: 'streamable-http', auth: 'open', provider: 'Devin',
    tags: ['rag', 'wiki', 'knowledge', 'ai'],
  },
  {
    id: 'exa-search', name: 'Exa Search', category: 'RAG-as-a-Service',
    description: 'AI-powered search engine for retrieving web content',
    url: 'https://mcp.exa.ai/mcp', transport: 'streamable-http', auth: 'open', provider: 'Exa',
    tags: ['search', 'rag', 'ai', 'web'],
  },
  {
    id: 'cloudflare-docs', name: 'Cloudflare Docs', category: 'Documentation',
    description: 'Cloudflare documentation and guides',
    url: 'https://docs.mcp.cloudflare.com/sse', transport: 'sse', auth: 'open', provider: 'Cloudflare',
    tags: ['documentation', 'cloudflare', 'reference'],
  },
  {
    id: 'astro-docs', name: 'Astro Docs', category: 'Documentation',
    description: 'Astro framework documentation',
    url: 'https://mcp.docs.astro.build/mcp', transport: 'streamable-http', auth: 'open', provider: 'Astro',
    tags: ['documentation', 'astro', 'framework'],
  },
  {
    id: 'gitmcp', name: 'GitMCP', category: 'Software Development',
    description: 'Git integration for MCP',
    url: 'https://gitmcp.io/docs', transport: 'streamable-http', auth: 'open', provider: 'GitMCP',
    tags: ['git', 'version-control', 'development'],
  },
  {
    id: 'simplescraper', name: 'Simplescraper', category: 'Web Scraping',
    description: 'Visual web scraping platform',
    url: 'https://mcp.simplescraper.io/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Simplescraper',
    tags: ['scraping', 'automation', 'web-data'],
  },
  {
    id: 'apify', name: 'Apify', category: 'Web Data Extraction',
    description: 'Web scraping and automation platform',
    url: 'https://mcp.apify.com', transport: 'streamable-http', auth: 'apikey', provider: 'Apify',
    tags: ['scraping', 'automation', 'crawling', 'data-extraction'],
  },
  {
    id: 'zapier', name: 'Zapier', category: 'Automation',
    description: 'Workflow automation between apps',
    url: 'https://mcp.zapier.com/api/mcp/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Zapier',
    tags: ['automation', 'integration', 'workflow', 'no-code'],
  },
  {
    id: 'mercado-libre', name: 'Mercado Libre', category: 'E-Commerce',
    description: 'Latin America\'s largest e-commerce platform',
    url: 'https://mcp.mercadolibre.com/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Mercado Libre MCP Server',
    tags: ['e-commerce', 'marketplace', 'latam'],
  },
  {
    id: 'stytch', name: 'Stytch', category: 'Authentication',
    description: 'User authentication and authorization platform',
    url: 'https://mcp.stytch.dev/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Stytch',
    tags: ['auth', 'security', 'identity'],
  },
  {
    id: 'zenable', name: 'Zenable', category: 'Security',
    description: 'Security and compliance automation',
    url: 'https://mcp.zenable.app/', transport: 'streamable-http', auth: 'oauth', provider: 'Zenable',
    tags: ['security', 'compliance', 'automation'],
  },
  {
    id: 'find-a-domain', name: 'Find-A-Domain', category: 'Productivity',
    description: 'Domain name search and availability checker',
    url: 'https://api.findadomain.dev/mcp', transport: 'streamable-http', auth: 'open', provider: 'Find-A-Domain',
    tags: ['domains', 'dns', 'search'],
  },
  {
    id: 'hive-intelligence', name: 'Hive Intelligence', category: 'Crypto',
    description: 'Cryptocurrency and blockchain analytics',
    url: 'https://hiveintelligence.xyz/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Hive Intelligence',
    tags: ['crypto', 'blockchain', 'analytics'],
  },
  {
    id: 'octagon', name: 'Octagon', category: 'Market Intelligence',
    description: 'Market research and competitive intelligence',
    url: 'https://mcp.octagonagents.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Octagon',
    tags: ['market-research', 'intelligence', 'analytics'],
  },
  {
    id: 'meta-ads', name: 'Meta Ads by Pipeboard', category: 'Advertising',
    description: 'Meta (Facebook/Instagram) advertising management',
    url: 'https://mcp.pipeboard.co/meta-ads-mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Pipeboard',
    tags: ['advertising', 'marketing', 'social-media', 'meta'],
  },
  {
    id: 'shortio', name: 'Short.io', category: 'Link Shortener',
    description: 'Custom domain link shortening service',
    url: 'https://ai-assistant.short.io/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Short.io',
    tags: ['urls', 'links', 'analytics'],
  },
  {
    id: 'turkish-airlines', name: 'Turkish Airlines', category: 'Airlines',
    description: 'Flight booking and airline services',
    url: 'https://mcp.turkishtechlab.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Turkish Technology',
    tags: ['travel', 'airlines', 'booking'],
  },
  {
    id: 'rube', name: 'Rube', category: 'Other',
    description: 'Workflow automation and integration platform',
    url: 'https://rube.app/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Composio',
    tags: ['automation', 'integration', 'workflow'],
  },
  {
    id: 'indeed', name: 'Indeed', category: 'Recruitment',
    description: 'Job search and recruitment platform',
    url: 'https://mcp.indeed.com/claude/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Indeed',
    tags: ['jobs', 'recruitment', 'hiring'],
  },
  {
    id: 'peek', name: 'Peek', category: 'Travel',
    description: 'Activities and experiences booking platform',
    url: 'https://mcp.peek.com', transport: 'streamable-http', auth: 'open', provider: 'Peek',
    tags: ['travel', 'booking', 'activities'],
  },
  {
    id: 'ferryhopper', name: 'Ferryhopper', category: 'Travel',
    description: 'Ferry ticket booking and route planning',
    url: 'https://mcp.ferryhopper.com/mcp', transport: 'streamable-http', auth: 'open', provider: 'Ferryhopper',
    tags: ['travel', 'ferries', 'booking'],
  },
  {
    id: 'subwayinfo-nyc', name: 'SubwayInfo NYC', category: 'Travel',
    description: 'New York City subway information and schedules',
    url: 'https://subwayinfo.nyc/mcp', transport: 'streamable-http', auth: 'open', provider: 'SubwayInfo',
    tags: ['transit', 'nyc', 'subway'],
  },
  {
    id: 'hugging-face', name: 'Hugging Face', category: 'Software Development',
    description: 'Machine learning model hub and collaboration platform',
    url: 'https://hf.co/mcp', transport: 'streamable-http', auth: 'open', provider: 'Hugging Face',
    tags: ['ai', 'ml', 'models', 'datasets'],
  },
  {
    id: 'semgrep', name: 'Semgrep', category: 'Software Development',
    description: 'Static code analysis and security scanning',
    url: 'https://mcp.semgrep.ai/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Semgrep',
    tags: ['security', 'code-analysis', 'sast', 'linting'],
  },
  {
    id: 'polar-signals', name: 'Polar Signals', category: 'Software Development',
    description: 'Continuous profiling for performance optimization',
    url: 'https://api.polarsignals.com/api/mcp/', transport: 'streamable-http', auth: 'apikey', provider: 'Polar Signals',
    tags: ['performance', 'profiling', 'observability'],
  },
  {
    id: 'remote-mcp', name: 'Remote MCP', category: 'MCP Directory',
    description: 'Directory and discovery service for MCP servers',
    url: 'https://mcp.remote-mcp.com', transport: 'streamable-http', auth: 'open', provider: 'Remote MCP',
    tags: ['directory', 'discovery', 'mcp'],
  },
  {
    id: 'context-awesome', name: 'Context Awesome', category: 'Specialised Dataset',
    description: 'Curated datasets for context-aware applications',
    url: 'https://www.context-awesome.com/api/mcp', transport: 'streamable-http', auth: 'open', provider: 'Context Awesome',
    tags: ['datasets', 'context', 'ai', 'data'],
  },
  {
    id: 'port-io', name: 'Port', category: 'Software Development',
    description: 'Internal developer portal for microservices',
    url: 'https://mcp.port.io/v1', transport: 'streamable-http', auth: 'oauth', provider: 'Port',
    tags: ['developer-portal', 'infrastructure', 'microservices'],
  },
  {
    id: 'openzeppelin-cairo', name: 'OpenZeppelin Cairo Contracts', category: 'Software Development',
    description: 'Cairo smart contract libraries for StarkNet',
    url: 'https://mcp.openzeppelin.com/contracts/cairo/mcp', transport: 'streamable-http', auth: 'open', provider: 'OpenZeppelin',
    tags: ['blockchain', 'smart-contracts', 'cairo', 'starknet'],
  },
  {
    id: 'openzeppelin-solidity', name: 'OpenZeppelin Solidity Contracts', category: 'Software Development',
    description: 'Secure smart contract libraries for Ethereum',
    url: 'https://mcp.openzeppelin.com/contracts/solidity/mcp', transport: 'streamable-http', auth: 'open', provider: 'OpenZeppelin',
    tags: ['blockchain', 'smart-contracts', 'solidity', 'ethereum'],
  },
  {
    id: 'openzeppelin-stellar', name: 'OpenZeppelin Stellar Contracts', category: 'Software Development',
    description: 'Smart contract libraries for Stellar blockchain',
    url: 'https://mcp.openzeppelin.com/contracts/stellar/mcp', transport: 'streamable-http', auth: 'open', provider: 'OpenZeppelin',
    tags: ['blockchain', 'smart-contracts', 'stellar'],
  },
  {
    id: 'openzeppelin-stylus', name: 'OpenZeppelin Stylus Contracts', category: 'Software Development',
    description: 'Smart contract libraries for Arbitrum Stylus',
    url: 'https://mcp.openzeppelin.com/contracts/stylus/mcp', transport: 'streamable-http', auth: 'open', provider: 'OpenZeppelin',
    tags: ['blockchain', 'smart-contracts', 'stylus', 'arbitrum'],
  },
  {
    id: 'aws-knowledge', name: 'AWS Knowledge', category: 'Cloud',
    description: 'AWS documentation and knowledge base',
    url: 'https://knowledge-mcp.global.api.aws', transport: 'streamable-http', auth: 'open', provider: 'AWS',
    tags: ['cloud', 'aws', 'documentation', 'knowledge'],
  },
  {
    id: 'google-maps', name: 'Google Maps', category: 'Maps & Location',
    description: 'Maps, geocoding, and location services',
    url: 'https://mapstools.googleapis.com/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Google',
    tags: ['maps', 'location', 'geocoding', 'google'],
  },
  {
    id: 'google-bigquery', name: 'Google BigQuery', category: 'Data Analytics',
    description: 'Serverless data warehouse for analytics',
    url: 'https://bigquery.googleapis.com/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Google',
    tags: ['data', 'analytics', 'warehouse', 'google'],
  },
  {
    id: 'google-gke', name: 'Google GKE', category: 'Cloud',
    description: 'Google Kubernetes Engine container management',
    url: 'https://container.googleapis.com/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Google',
    tags: ['kubernetes', 'containers', 'cloud', 'google'],
  },
  {
    id: 'google-compute-engine', name: 'Google Compute Engine', category: 'Cloud',
    description: 'Virtual machine instances on Google Cloud',
    url: 'https://compute.googleapis.com/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Google',
    tags: ['compute', 'vm', 'cloud', 'google'],
  },
  {
    id: 'searchapi', name: 'SearchAPI', category: 'Search',
    description: 'Real-time search engine results API',
    url: 'https://www.searchapi.io/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'SearchAPI',
    tags: ['search', 'api', 'data'],
  },
  {
    id: 'ean-search', name: 'EAN-Search', category: 'Product Data',
    description: 'Barcode and product information lookup',
    url: 'https://www.ean-search.org/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'EAN-Search.org',
    tags: ['barcode', 'products', 'ean', 'data'],
  },
  {
    id: 'webzum', name: 'WebZum', category: 'Search',
    description: 'Business search and local data platform',
    url: 'https://webzum.com/api/mcp', transport: 'streamable-http', auth: 'open', provider: 'WebZum',
    tags: ['search', 'business', 'local-data'],
  },
  {
    id: 'zip1', name: 'zip1.io', category: 'Link Shortener',
    description: 'URL shortener service',
    url: 'https://zip1.io/mcp', transport: 'streamable-http', auth: 'open', provider: 'zip1.io',
    tags: ['urls', 'links', 'shortener'],
  },
  {
    id: 'tweetsave', name: 'TweetSave', category: 'Social Media',
    description: 'Tweet archiving and saving service',
    url: 'https://mcp.tweetsave.org/sse', transport: 'sse', auth: 'open', provider: 'TweetSave',
    tags: ['twitter', 'social-media', 'archive'],
  },
  {
    id: 'parallel-task', name: 'Parallel Task', category: 'AI Services',
    description: 'AI-powered task execution and automation',
    url: 'https://task-mcp.parallel.ai/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Parallel',
    tags: ['ai', 'tasks', 'automation'],
  },
  {
    id: 'parallel-search', name: 'Parallel Search', category: 'AI Services',
    description: 'AI-powered search and information retrieval',
    url: 'https://search-mcp.parallel.ai/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Parallel',
    tags: ['ai', 'search', 'retrieval'],
  },
  {
    id: 'metro-mcp', name: 'Metro MCP', category: 'Software Development',
    description: 'Metro bundler integration for React Native',
    url: 'https://metro-mcp.anuragd.me/sse', transport: 'sse', auth: 'oauth', provider: 'Metro MCP',
    tags: ['react-native', 'metro', 'bundler', 'development'],
  },
  {
    id: 'attio', name: 'Attio', category: 'CRM',
    description: 'Next-generation CRM with flexible data modeling and real-time collaboration',
    url: 'https://mcp.attio.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Attio',
    tags: ['crm', 'sales', 'customer-management'],
  },
  {
    id: 'github', name: 'GitHub', category: 'Software Development',
    description: 'Version control and collaborative software development',
    url: 'https://api.githubcopilot.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'GitHub',
    tags: ['development', 'git', 'version-control', 'collaboration'],
  },
  {
    id: 'atlassian', name: 'Atlassian', category: 'Software Development',
    description: 'Suite of development and collaboration tools',
    url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', auth: 'oauth', provider: 'Atlassian',
    tags: ['development', 'jira', 'confluence', 'bitbucket'],
  },
  {
    id: 'stack-overflow', name: 'Stack Overflow', category: 'Software Development',
    description: 'Developer Q&A platform — search and access programming knowledge',
    url: 'https://mcp.stackoverflow.com', transport: 'streamable-http', auth: 'oauth', provider: 'Stack Overflow',
    tags: ['development', 'q-and-a', 'knowledge'],
  },
  {
    id: 'buildkite', name: 'Buildkite', category: 'Software Development',
    description: 'Continuous integration and deployment platform',
    url: 'https://mcp.buildkite.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Buildkite',
    tags: ['ci-cd', 'automation', 'development'],
  },
  {
    id: 'telnyx', name: 'Telnyx', category: 'Communication',
    description: 'Cloud communications platform — voice, messaging, and networking APIs',
    url: 'https://api.telnyx.com/v2/mcp', transport: 'streamable-http', auth: 'apikey', provider: 'Telnyx',
    tags: ['communication', 'voice', 'messaging', 'telecom'],
  },
  {
    id: 'microsoft-learn-docs', name: 'Microsoft Learn Docs', category: 'Documentation',
    description: 'Real-time semantic search across Microsoft Learn, Azure, Microsoft 365, .NET, and C# documentation — always up to date with the latest releases and best practices',
    url: 'https://learn.microsoft.com/api/mcp', transport: 'streamable-http', auth: 'open', provider: 'Microsoft',
    tags: ['documentation', 'microsoft', 'azure', 'dotnet', 'csharp'],
  },
  {
    id: 'power-bi', name: 'Power BI', category: 'Data Analytics',
    description: 'Query Power BI semantic models — AI agents connect to hosted analytics without running a local server',
    url: 'https://api.fabric.microsoft.com/v1/mcp/powerbi', transport: 'streamable-http', auth: 'oauth', provider: 'Microsoft',
    tags: ['analytics', 'bi', 'power-bi', 'fabric', 'microsoft'],
  },
  {
    id: 'microsoft-foundry', name: 'Microsoft Foundry', category: 'AI Services',
    description: 'Unified toolkit for Azure AI — models, knowledge, evaluation, and more through a single MCP endpoint',
    url: 'https://mcp.ai.azure.com', transport: 'streamable-http', auth: 'oauth', provider: 'Microsoft',
    tags: ['ai', 'azure', 'models', 'evaluation', 'microsoft'],
  },
  {
    id: 'javadocs', name: 'Javadocs', category: 'Documentation',
    description: 'Java API documentation search and reference',
    url: 'https://www.javadocs.dev/mcp', transport: 'streamable-http', auth: 'open', provider: 'Javadocs',
    tags: ['documentation', 'java', 'api-reference'],
  },
  {
    id: 'bluedot', name: 'Bluedot', category: 'Productivity',
    description: 'AI meeting notetaker — access your transcripts, recordings and meeting metadata',
    url: 'https://app.bluedothq.com/api/v1/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Bluedot',
    tags: ['meetings', 'transcription', 'notetaker', 'productivity'],
  },
  {
    id: 'read-ai', name: 'Read AI', category: 'Productivity',
    description: 'AI meeting copilot — meeting reports, transcripts, summaries and action items',
    url: 'https://api.read.ai/mcp/', transport: 'streamable-http', auth: 'oauth', provider: 'Read AI',
    tags: ['meetings', 'transcription', 'notetaker', 'productivity'],
  },
  {
    id: 'salesforce', name: 'Salesforce', category: 'CRM',
    description: 'Salesforce CRM — query, search and update records across your org (Hosted MCP)',
    url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all', transport: 'streamable-http', auth: 'oauth', provider: 'Salesforce',
    tags: ['crm', 'sales', 'salesforce'],
  },
  {
    id: 'servicenow', name: 'ServiceNow', category: 'IT Service Management',
    description: 'ServiceNow ITSM — incidents, requests and records via your instance MCP server',
    url: 'https://<your-instance>.service-now.com/sncapps/mcp-server/mcp/sn_mcp_server_default', transport: 'streamable-http', auth: 'oauth', provider: 'ServiceNow',
    tags: ['itsm', 'tickets', 'incidents', 'servicenow'],
  },
  {
    id: 'slack', name: 'Slack', category: 'Communication',
    description: 'Slack — search and read messages and post to channels (official hosted MCP)',
    url: 'https://mcp.slack.com/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'Slack',
    tags: ['communication', 'chat', 'slack'],
  },
  {
    id: 'snowflake', name: 'Snowflake', category: 'Data Analytics',
    description: 'Snowflake — query your data via a Snowflake-managed Cortex MCP server',
    url: 'https://<account>.snowflakecomputing.com/api/v2/databases/<database>/schemas/<schema>/mcp-servers/<mcp_server>', transport: 'streamable-http', auth: 'oauth', provider: 'Snowflake',
    tags: ['database', 'data-analytics', 'snowflake'],
  },
  {
    id: 'datadog', name: 'Datadog', category: 'Observability',
    description: 'Datadog — query metrics, logs, monitors and incidents (official MCP, preview; API + App key)',
    url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp', transport: 'streamable-http', auth: 'open', provider: 'Datadog',
    tags: ['observability', 'monitoring', 'datadog'],
  },
  {
    id: 'gitlab', name: 'GitLab', category: 'Software Development',
    description: 'GitLab — issues, merge requests, pipelines and code (official MCP, beta)',
    url: 'https://gitlab.com/api/v4/mcp', transport: 'streamable-http', auth: 'oauth', provider: 'GitLab',
    tags: ['development', 'devops', 'gitlab'],
  },
];

/** Distinct categories present in the catalog, for the browse filter. */
export const CATALOG_CATEGORIES: string[] = Array.from(new Set(MCP_SERVER_CATALOG.map((s) => s.category))).sort();

/**
 * Optional per-server setup detail shown in the catalog's detail view: a `docsUrl` and a `setup` guide
 * (what it needs + how to get the credential/token). Entries without a specific `setup` fall back to
 * generic guidance derived from the auth class (open/apikey/oauth). Keyed by catalog id.
 */
export interface CatalogDetail {
  docsUrl?: string;
  setup?: string;
}

export const CATALOG_SETUP: Record<string, CatalogDetail> = {
  bluedot: {
    docsUrl: 'https://help.bluedothq.com/en/articles/14708332-bluedot-mcp',
    setup:
      'Click **Connect** and sign in with the Bluedot account you want the AI to access — the emails need not match.\n\n' +
      'No token to manage: the AI can only read what that account already has permission to see (meeting transcripts and metadata).\n\n' +
      'For an org-wide setup, an admin connects it from `Bluedot → Personal Settings → Connectors`.',
  },
  'read-ai': {
    docsUrl: 'https://support.read.ai/hc/en-us/articles/49379985941523-Read-AI-API-and-MCP-Overview',
    setup:
      'Click **Connect** and sign in with your Read AI account. The AI can then read your **meeting reports, ' +
      'transcripts, summaries and action items** — following your Read AI account permissions. No token to manage.',
  },
  salesforce: {
    docsUrl: 'https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/hosted-mcp-servers-overview.html',
    setup:
      'Salesforce **Hosted MCP** uses one central host (`api.salesforce.com`) — **not** your `my.salesforce.com` URL; your org is resolved at sign-in.\n\n' +
      '1. An admin enables **Hosted MCP Servers** in Setup and creates an **External Client App** (OAuth) with scopes `api`, `sfap_api`, `refresh_token`.\n' +
      "2. Enter that app's **Consumer Key** as the OAuth **Client ID** here, click **Connect** and sign in — every call runs as you, with field-level security and sharing enforced.\n\n" +
      'Read-only variant: change `sobject-all` → `sobject-reads` in the URL. Sandbox org: insert `/sandbox/` after `/v1`.',
  },
  servicenow: {
    docsUrl: 'https://www.servicenow.com/docs/r/intelligent-experiences/mcp-client.html',
    setup:
      'Replace `<your-instance>` in the URL with your ServiceNow subdomain. Requires a **Zurich (or later)** instance with the **MCP Server Console** and a published MCP server (the out-of-box one is `sn_mcp_server_default`).\n\n' +
      'An admin registers Kravn as an inbound **OAuth** client (Application Registry) and clears the *"Allow access only to APIs in selected scope"* toggle so the token can reach `/sncapps/mcp-server`. Then click **Connect** and sign in. ' +
      '_Tip: an unauthenticated GET to the path returns 401 if routing is enabled, 404 if path-forwarding still needs to be turned on._',
  },
  slack: {
    docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
    setup:
      "Slack's **official hosted** MCP. It does **not** support automatic client registration, so you must pre-register an app:\n\n" +
      '1. Create a Slack app at [api.slack.com](https://api.slack.com/apps) (published or internal) and add the user scopes you need (e.g. `search:read.public`, `channels:history`, `chat:write`, `users:read`).\n' +
      "2. Paste the app's **Client ID** and **Client Secret** into the OAuth config here, then click **Connect** and approve — Kravn receives a per-user token.",
  },
  snowflake: {
    docsUrl: 'https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp',
    setup:
      'Use a **Snowflake-managed** MCP server. In Snowflake, create one (`CREATE MCP SERVER …`) and copy its URL, then replace the placeholders in ' +
      '`https://<account>.snowflakecomputing.com/api/v2/databases/<database>/schemas/<schema>/mcp-servers/<mcp_server>` with your account, database, schema and server name.\n\n' +
      'Auth is **OAuth** — click **Connect** and sign in. _(Not available on government / VPS / VPC regions.)_',
  },
  datadog: {
    docsUrl: 'https://docs.datadoghq.com/mcp_server/setup/',
    setup:
      "Datadog's official MCP server (**preview**). Today it authenticates with an **API key + Application key** " +
      'sent as HTTP headers — the gateway OAuth flow is not available yet (Datadog says it is coming later), so ' +
      '**do not use OAuth here**.\n\n' +
      '1. In Datadog, create an **API key** (`Organization Settings → API Keys`) and an **Application key** ' +
      '(`Organization Settings → Application Keys`).\n' +
      '2. **Grant the MCP permissions — this is the #1 gotcha.** The MCP server is gated by its own RBAC ' +
      'permissions, *separate* from the data scopes: **MCP Read (`mcp_read`)** is required, and **MCP Write ' +
      '(`mcp_write`)** for the action tools. Without them `tools/list` still works, but every query fails with ' +
      '`Forbidden / Failed permission authorization checks`. Grant `mcp_read`/`mcp_write` to the Application ' +
      "key owner's **role**, and if the key is scoped, include them in its scopes too.\n" +
      '3. Add the **data-read** scopes for the tools you will use (least privilege), matched per query family: ' +
      'metric queries need `metrics_read` **and** `timeseries_query` (the latter is easy to miss — without it ' +
      'metric reads fail); log analytics needs `logs_read_data` **and** `logs_read_index_data`; change tracking ' +
      '/ event search need `events_read`; plus `monitors_read`, `dashboards_read`, `apm_read` as needed. ' +
      "_Tip: while debugging, leave the Application key **unscoped** — it inherits the owner's full permissions " +
      '— to rule out scoping, then lock it down._\n' +
      '4. Set the **region host** in the URL: US1 = `mcp.datadoghq.com`; for other sites swap the host ' +
      '(e.g. `mcp.datadoghq.eu`, `mcp.us3.datadoghq.com`, `mcp.us5.datadoghq.com`, `mcp.ap1.datadoghq.com`).\n' +
      '5. On the server, add both keys under **Extra headers (JSON)**: ' +
      '`{"DD-API-KEY": "your-api-key", "DD-APPLICATION-KEY": "your-app-key"}`, then save. The keys are stored ' +
      'with the server config; access follows the Application key’s scopes.',
  },
  gitlab: {
    docsUrl: 'https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/',
    setup:
      "GitLab's **official** MCP server (**beta**, GitLab **18.6+**, requires GitLab Duo). For SaaS use `https://gitlab.com/api/v4/mcp`; for **Self-Managed / Dedicated** replace the host with your own GitLab domain. " +
      'Click **Connect** and authorize with **OAuth**.',
  },
  github: {
    docsUrl: 'https://docs.github.com/apps/creating-github-apps/registering-a-github-app/registering-a-github-app',
    setup:
      "GitHub's MCP server uses OAuth but doesn't auto-register an app, so create one first:\n\n" +
      '1. Go to `GitHub → Settings → Developer settings → OAuth Apps → New OAuth App`.\n' +
      '2. Set the **Authorization callback URL** to the redirect URL Kravn shows when you click **Connect**.\n' +
      "3. Paste the app's **Client ID** and **Client Secret**.\n\n" +
      'Then click **Connect** and authorize which org / repositories to grant.',
  },
  stripe: {
    docsUrl: 'https://docs.stripe.com/mcp',
    setup:
      'Two ways to connect:\n\n' +
      '- **OAuth** — just click **Connect**.\n' +
      '- **API key** — add a Stripe key as the token. Create one at `Stripe Dashboard → Developers → API keys → Create restricted key`, grant only the resources you need (read-only where possible), then paste it.',
  },
  notion: {
    docsUrl: 'https://developers.notion.com/docs/mcp',
    setup:
      'Click **Connect** and sign in with Notion, then pick exactly which **pages / databases** to share with the integration — it can only see what you share.',
  },
  linear: { setup: 'Click **Connect** and authorize your Linear workspace. No token to manage.' },
  sentry: {
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
    setup: 'Click **Connect** and authorize your Sentry organization. Access follows your Sentry role.',
  },
  supabase: {
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    setup: 'Click **Connect** and authorize, scoping the grant to the specific **project** you want the AI to reach.',
  },
  vercel: { setup: 'Click **Connect** and authorize the Vercel account or team you want to expose.' },
  neon: { setup: 'Click **Connect** and authorize your Neon account.' },
  atlassian: {
    setup:
      'Click **Connect** and authorize Jira / Confluence for your Atlassian site.\n\n' +
      'Prefer a single service identity with no per-user sign-in? Use the **built-in Jira / Confluence** integrations instead (app-only, tighter scoping).',
  },
  paypal: { setup: 'Click **Connect** and sign in with PayPal. Access follows your PayPal account permissions.' },
  plaid: { setup: 'Click **Connect** and authorize from your Plaid dashboard.' },
  hubspot: {
    docsUrl: 'https://developers.hubspot.com/docs/guides/apps/private-apps/overview',
    setup:
      'Create a HubSpot **Private App** token, then paste it as the token here:\n\n' +
      '1. Go to `HubSpot → Settings → Integrations → Private Apps → Create a private app`.\n' +
      '2. Grant the scopes you need (e.g. `crm.objects.contacts.read` / `.write`).\n' +
      '3. Copy the token.',
  },
  apify: {
    docsUrl: 'https://docs.apify.com/platform/integrations/mcp',
    setup: 'Copy your API token from `Apify Console → Settings → Integrations (API)` and paste it as the token.',
  },
  zapier: {
    setup: 'Open Zapier MCP settings, generate an **MCP endpoint + API key**, and paste the key as the token.',
  },
  'mercado-libre': {
    setup:
      'Create an access token from your Mercado Libre developer app ([developers.mercadolibre.com](https://developers.mercadolibre.com)) and paste it as the token.',
  },
  'mercado-pago': {
    docsUrl: 'https://www.mercadopago.com/developers',
    setup:
      'Copy your Mercado Pago **Access Token** from your developer credentials (`Your integrations → credentials`) and paste it as the token. Use a **test token** first.',
  },
  shortio: { setup: 'Copy your API key from `Short.io → Settings → Integrations & API` and paste it as the token.' },
  telnyx: { setup: 'Create a **V2 API key** in `Telnyx Portal → Auth → API Keys` and paste it as the token.' },
  'google-maps': {
    docsUrl: 'https://developers.google.com/maps',
    setup:
      'Create an API key and paste it as the token:\n\n' +
      '1. Go to `Google Cloud Console → APIs & Services → Credentials → Create credentials → API key`.\n' +
      '2. Enable the **Maps / Places** APIs you need.\n' +
      '3. Restrict the key, then copy it.',
  },
  'google-bigquery': {
    setup:
      'Create an API key (or use a service-account token) in `Google Cloud Console → APIs & Services → Credentials`, enable the **BigQuery API**, and paste it as the token.',
  },
  'hugging-face': {
    docsUrl: 'https://huggingface.co/settings/tokens',
    setup:
      'Works with **no credential** for public models / datasets.\n\n' +
      'For private or gated content, create a Hugging Face access token (`huggingface.co → Settings → Access Tokens`) and add it as a Bearer header.',
  },
  semgrep: { setup: 'Click **Connect** and authorize with your Semgrep account.' },
  'cloudflare-workers': { setup: 'Click **Connect** and authorize your Cloudflare account (scoped to Workers bindings).' },
  'cloudflare-observability': { setup: 'Click **Connect** and authorize your Cloudflare account (observability / logs).' },
};

/** Setup detail for a catalog id (empty object if none). */
export function catalogDetail(id: string): CatalogDetail {
  return CATALOG_SETUP[id] ?? {};
}

/**
 * Built-in (native) integrations to external products — mcp-server plugins that run in-process.
 * `id` matches the plugin manifest id and the BRAND_ICONS key. Kept here (not derived from the
 * gateway plugin code) so the shared contracts + the public website can list them statically.
 */
export interface NativeIntegration {
  id: string;
  name: string;
  category: string;
  description: string;
}

export const NATIVE_INTEGRATIONS: NativeIntegration[] = [
  {
    id: 'kravn-jira', name: 'Jira', category: 'Project Management',
    description: 'Query and read issues via the Jira REST API.',
  },
  {
    id: 'kravn-confluence', name: 'Confluence', category: 'Documentation',
    description: 'Search and read Confluence pages.',
  },
  {
    id: 'kravn-sharepoint', name: 'SharePoint', category: 'Document Management',
    description: 'Search, browse document libraries and read documents (Word/PDF/Excel/text) over Microsoft Graph.',
  },
  {
    id: 'kravn-teams', name: 'Microsoft Teams', category: 'Communication',
    description: 'Find people, read chats and channel posts, list teams/channels over Microsoft Graph.',
  },
  {
    id: 'kravn-odoo', name: 'Odoo', category: 'CRM',
    description: 'CRM & ERP over Odoo JSON-RPC — CRUD, server-side aggregation & counts, and search across leads, contacts, sales orders, invoices, products, tasks, employees. Works with Odoo Online, Odoo.sh and self-hosted.',
  },
  {
    id: 'kravn-zoho', name: 'Zoho CRM', category: 'CRM',
    description: 'Zoho CRM over its v6 REST API — read/search/CRUD on any module, COQL queries with GROUP BY and COUNT/SUM/AVG aggregates, and convenience search for Leads, Contacts, Accounts and Deals. Server-to-server OAuth 2.0, region-aware.',
  },
  {
    id: 'kravn-azure', name: 'Azure', category: 'Cloud',
    description: 'Read-only Azure diagnostics & cost — Resource Graph (KQL over any resource), Log Analytics (KQL logs/diagnostics), Cost Management (spend by service), and Azure Monitor metrics. Entra service-principal auth; public, US Gov and China clouds. No write tools.',
  },
  {
    id: 'kravn-aws', name: 'AWS', category: 'Cloud',
    description: 'Read-only AWS cost & diagnostics — Cost Explorer (spend by service), CloudWatch Logs Insights (log queries) + log-group discovery, and Resource Groups Tagging (resource inventory). IAM access-key auth, requests signed with AWS Signature V4. No write tools.',
  },
  {
    id: 'kravn-gcp', name: 'Google Cloud', category: 'Cloud',
    description: 'Read-only Google Cloud diagnostics & cost — Cloud Asset (search any resource), Cloud Logging, Cloud Monitoring, and cost from the BigQuery billing export. Service-account (RS256 JWT) auth. No write tools.',
  },
  {
    id: 'kravn-gmail', name: 'Gmail', category: 'Email',
    description: 'Read and send email over the Gmail API — search/read messages and send mail (incl. replying into a thread). OAuth 2.0 (client id/secret + refresh token). Includes a send action.',
  },
  {
    id: 'kravn-outlook', name: 'Outlook', category: 'Email',
    description: 'Read and send email over Microsoft 365 / Exchange Online (Microsoft Graph) — search/read messages, send, and reply/reply-all. App-only Graph auth (Mail.Read + Mail.Send). Includes a send action.',
  },
  {
    id: 'kravn-web', name: 'Web', category: 'Search',
    description: 'Read-only web access for agents — web_fetch reads any page as clean Markdown, and web_search returns results via a configured provider (Brave API key or a self-hosted SearXNG). All egress is SSRF-guarded; web_fetch needs no configuration.',
  },
  {
    id: 'kravn-linkedin', name: 'LinkedIn', category: 'Social',
    description: 'Read the authenticated member’s LinkedIn profile and publish posts/shares on their behalf, over LinkedIn’s official OAuth 2.0 API (OpenID Connect + Share on LinkedIn). Standard-app scope: profile search, messaging and jobs are not available (LinkedIn partner programs only). Includes a mutating action (posting).',
  },
];
