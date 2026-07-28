/**
 * Generate packages/contracts/src/brand-icons.ts — brand logos baked from simple-icons + Iconify.
 *
 * Run after adding/removing an integration (catalog server or native mcp-server plugin):
 *   node apps/operator/scripts/gen-brand-icons.mjs
 *
 * It reads the catalog (packages/contracts/src/server-catalog.ts) + the native-plugin id list
 * below and bakes a brand icon per id into a plain TS map in @kravn/contracts, so BOTH the operator
 * (IntegrationIcon.vue) and the public website (integrations gallery) render logos from one source.
 * Three sources, in priority order:
 *   1. simple-icons — a single monochrome { path, hex } (24x24). First choice.
 *   2. Iconify (the ICONIFY map) for brands simple-icons dropped/lacks — Microsoft/Amazon (removed
 *      from simple-icons) + a few SaaS. logos = full-colour, mdi/cib = monochrome tinted by hex;
 *      baked as a full SVG { body, viewBox }.
 *   3. Logo.dev (the LOGODEV map) — last resort for real companies NO icon set has. Fetched at build
 *      time as a raster PNG and baked as a base64 data URI { src } (the operator CSP allows
 *      img-src data:). Refreshing needs a token: `LOGODEV_TOKEN=pk_... node <this>`; without it the
 *      already-baked data URIs are preserved (regen is never destructive). The token is build-time
 *      only and is never written to the output.
 * simple-icons and @iconify-json/{logos,mdi,cib} are build-time devDependencies; Logo.dev is a build-time
 * HTTP fetch. Nothing imports them at runtime. Ids with no brand logo in ANY source fall back to a coloured
 * monogram (deliberately: a wrong/unrelated icon is worse than initials — some niche MCP servers have none).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const si = await import(`${ROOT}/node_modules/simple-icons/index.mjs`);

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const all = Object.values(si).filter((o) => o && typeof o === 'object' && o.slug && o.path);
const byKey = new Map();
for (const ic of all) for (const k of [ic.slug, norm(ic.title)]) if (k && !byKey.has(k)) byKey.set(k, ic);
const find = (...cands) => {
  for (const c of cands) {
    const k = norm(c);
    if (k && byKey.has(k)) return byKey.get(k);
  }
  return null;
};

// Iconify sets (build-time only) for brands simple-icons lacks — Microsoft/Amazon (dropped from
// simple-icons) + a few SaaS. logos = full-colour brand logos; mdi/cib = monochrome (currentColor,
// tinted at render time with the brand hex). Baked the same way as simple-icons (nothing at runtime).
const ICON_SETS = {};
for (const p of ['logos', 'mdi', 'cib']) {
  try { ICON_SETS[p] = JSON.parse(readFileSync(`${ROOT}/node_modules/@iconify-json/${p}/icons.json`, 'utf8')); }
  catch { ICON_SETS[p] = null; }
}
const UNSAFE = /<script|\son\w+=|javascript:/i; // iconify data is pure shapes; assert it's never markup/script
const iconifyRef = (ref, hex) => {
  const [set, name] = ref.split(':');
  const s = ICON_SETS[set];
  const ic = s && s.icons[name];
  if (!ic) return null;
  if (UNSAFE.test(ic.body)) throw new Error(`unsafe icon body in ${ref}`);
  const w = ic.width || s.width || 24;
  const h = ic.height || s.height || 24;
  return { body: ic.body, viewBox: `0 0 ${w} ${h}`, ...(hex ? { hex } : {}) };
};

// Catalog entries (id, name, provider) parsed from the shared catalog source.
const src = readFileSync(`${ROOT}/packages/contracts/src/server-catalog.ts`, 'utf8');
const body = src.slice(0, src.indexOf('export const CATALOG_CATEGORIES'));
const entries = [];
const re = /id:\s*'([^']+)',\s*name:\s*'([^']+)'/g;
let m;
while ((m = re.exec(body))) {
  const after = body.slice(m.index, m.index + 400);
  const pm = after.match(/provider:\s*'([^']+)'/);
  entries.push({ id: m[1], name: m[2], provider: pm ? pm[1] : '' });
}

// Overrides where the catalog id doesn't normalise to the simple-icons slug.
const OVERRIDE = {
  monday: 'mondaydotcom', 'cloudflare-workers': 'cloudflare', 'cloudflare-observability': 'cloudflare',
  'prisma-postgres': 'prisma', 'hugging-face': 'huggingface', 'google-drive': 'googledrive',
  'google-calendar': 'googlecalendar', 'google-analytics': 'googleanalytics', 'google-maps': 'googlemaps',
  'new-relic': 'newrelic', 'brave-search': 'brave', elastic: 'elasticsearch', gcp: 'googlecloud',
  azure: 'microsoftazure', aws: 'amazonwebservices', 'digital-ocean': 'digitalocean', wandb: 'weightsandbiases',
  'meta-ads': 'meta', devto: 'devdotto', cockroachdb: 'cockroachlabs',
};

// Native mcp-server plugins (apps/gateway/src/plugins/*) — map id -> simple-icons slug.
const NATIVE = [
  { id: 'kravn-azure', slug: 'microsoftazure' },
  { id: 'kravn-aws', slug: 'amazonwebservices' },
  { id: 'kravn-gcp', slug: 'googlecloud' },
  { id: 'kravn-gmail', slug: 'gmail' },
  { id: 'kravn-outlook', slug: 'microsoftoutlook' },
  { id: 'kravn-confluence', slug: 'confluence' },
  { id: 'kravn-jira', slug: 'jira' },
  { id: 'kravn-odoo', slug: 'odoo' },
  { id: 'kravn-sharepoint', slug: 'microsoftsharepoint' },
  { id: 'kravn-teams', slug: 'microsoftteams' },
  { id: 'kravn-zoho', slug: 'zoho' },
];

// Brands simple-icons dropped/lacks — filled from Iconify (see ICON_SETS). logos = full colour;
// mdi/cib = monochrome tinted with the brand hex. Niche MCP-server startups that have NO brand logo
// in ANY Iconify set intentionally stay a monogram — a wrong/unrelated logo is worse than initials.
const ICONIFY = {
  // native Microsoft / AWS plugins (simple-icons no longer ships these brands)
  'kravn-azure': ['logos:microsoft-azure'],
  'kravn-aws': ['logos:aws'],
  'kravn-teams': ['logos:microsoft-teams'],
  'kravn-outlook': ['mdi:microsoft-outlook', '#0078D4'],
  'kravn-sharepoint': ['mdi:microsoft-sharepoint', '#038387'],
  'kravn-http': ['mdi:api', '#4b5563'],
  'kravn-linkedin': ['logos:linkedin-icon'],
  // catalog entries with no simple-icons logo but a real brand mark on Iconify
  monday: ['logos:monday-icon'],
  canva: ['cib:canva', '#00C4CC'],
  salesforce: ['logos:salesforce'],
  slack: ['logos:slack-icon'],
  'power-bi': ['logos:microsoft-power-bi'],
  'microsoft-learn-docs': ['logos:microsoft-icon'],
  'microsoft-foundry': ['logos:microsoft-icon'],
  'aws-knowledge': ['logos:aws'],
};

// Last resort for brands NO icon set has (real companies, mostly niche SaaS): Logo.dev, baked as a
// raster data URI (Logo.dev serves no SVG). Domains were resolved via Logo.dev's search API and each
// one below returned a REAL logo — probed with `fallback=404`, which 404s instead of serving Logo.dev's
// generated monogram, so a 200 means an actual brand asset (not a placeholder). Ids that 404'd
// (no real logo anywhere) are deliberately absent → they keep the coloured monogram.
// Refreshing these needs a Logo.dev token: `LOGODEV_TOKEN=pk_... node apps/operator/scripts/gen-brand-icons.mjs`.
// Without the token the generator PRESERVES the already-baked data URIs (see prevSrc), so a normal
// regen never wipes them. The token is used only at build time and is never written to the output.
const LOGODEV = {
  servicenow: 'servicenow.com', plaid: 'plaid.com', ramp: 'ramp.com', apify: 'apify.com',
  attio: 'attio.com', telnyx: 'telnyx.com', semgrep: 'semgrep.dev', thoughtspot: 'thoughtspot.com',
  morningstar: 'morningstar.com', stytch: 'stytch.com', 'close-crm': 'close.com', invideo: 'invideo.io',
  cortex: 'cortex.io', grafbase: 'grafbase.com', 'port-io': 'getport.io', dappier: 'dappier.com',
  deepwiki: 'deepwiki.com', simplescraper: 'simplescraper.io', shortio: 'short.io', 'read-ai': 'read.ai',
  'exa-search': 'exa.ai', 'parallel-task': 'parallel.ai', 'parallel-search': 'parallel.ai',
  firefly: 'firefly.ai', jam: 'jam.dev', instant: 'instantdb.com', globalping: 'globalping.io',
  'polar-signals': 'polarsignals.com', zenable: 'zenable.io', peek: 'peek.com', ferryhopper: 'ferryhopper.com',
  searchapi: 'searchapi.io', 'ean-search': 'ean-search.org', onecontext: 'onecontext.ai', scorecard: 'scorecard.io',
  audioscrape: 'audioscrape.com', rube: 'rube.app', bluedot: 'bluedothq.com', 'carbon-voice': 'carbonvoice.app',
  waystation: 'waystation.ai', needle: 'needle.app', 'hive-intelligence': 'hiveintelligence.xyz',
  mypromind: 'mypromind.com', dialer: 'getdialer.app', javadocs: 'javadocs.dev', 'find-a-domain': 'findadomain.dev',
  'subwayinfo-nyc': 'subwayinfo.nyc', 'context-awesome': 'context-awesome.com', webzum: 'webzum.com',
  zine: 'zine.dev', vibemarketing: 'vibemarketing.com', zip1: 'zip1.io',
};

const out = new Map();
const misses = [];
for (const e of entries) {
  const ic =
    (OVERRIDE[e.id] && byKey.get(OVERRIDE[e.id])) ||
    find(e.id, e.id.replace(/-/g, ''), e.name, e.provider, e.name.replace(/\.?(com|inc|mcp|hq|labs)$/i, ''));
  if (ic) out.set(e.id, { path: ic.path, hex: ic.hex });
  else misses.push(`${e.id} (${e.name})`);
}
for (const n of NATIVE) {
  const ic = byKey.get(n.slug);
  if (ic) out.set(n.id, { path: ic.path, hex: ic.hex });
  else misses.push(`NATIVE ${n.id} -> ${n.slug} NOT FOUND (monogram fallback)`);
}

// Brands simple-icons lacks but that share another brand's glyph with a different colour.
// Mercado Libre uses the same "handshake" mark as Mercado Pago, in MercadoLibre yellow (#FFE600).
const DERIVED = {
  'mercado-libre': { slug: 'mercadopago', hex: 'FFE600' },
};
for (const [id, d] of Object.entries(DERIVED)) {
  const base = byKey.get(d.slug);
  if (base) {
    out.set(id, { path: base.path, hex: d.hex });
    const i = misses.findIndex((m) => m.startsWith(`${id} `));
    if (i >= 0) misses.splice(i, 1);
  }
}

// Iconify fill — overrides the monogram fallback for the curated ids above (catalog + native).
for (const [id, [ref, hex]] of Object.entries(ICONIFY)) {
  const v = iconifyRef(ref, hex);
  if (!v) { console.warn(`ICONIFY: ${id} -> ${ref} not found (stays monogram)`); continue; }
  out.set(id, v);
  const i = misses.findIndex((m) => m.startsWith(`${id} `) || m.startsWith(`NATIVE ${id} `));
  if (i >= 0) misses.splice(i, 1);
}

// Hand-provided brand logos, baked inline as data URIs — for brands with NO simple-icons/Iconify mark
// (e.g. Tempo). The data URI lives HERE in the build script (not as a loose image file in the repo), so it
// bakes into brand-icons.ts and survives regens. Highest precedence over the icon fallbacks above.
const BAKED = {
  'kravn-tempo': 'data:image/webp;base64,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',
};
for (const [id, src] of Object.entries(BAKED)) {
  out.set(id, { src });
  const i = misses.findIndex((m) => m.startsWith(`${id} `) || m.startsWith(`NATIVE ${id} `));
  if (i >= 0) misses.splice(i, 1);
}

// Logo.dev fill (raster data URIs). Preserve any previously-baked src entries so a regen WITHOUT the
// token is non-destructive; only refresh/add them when LOGODEV_TOKEN is set.
const prevSrc = new Map();
try {
  const prev = readFileSync(`${ROOT}/packages/contracts/src/brand-icons.ts`, 'utf8');
  const rx = /^\s+'?([\w-]+)'?: \{ src: ("(?:[^"\\]|\\.)*") \},$/gm;
  let pm2;
  while ((pm2 = rx.exec(prev))) prevSrc.set(pm2[1], JSON.parse(pm2[2]));
} catch { /* first run — no prior file */ }

const logoToken = process.env.LOGODEV_TOKEN;
let logodevFetched = 0;
for (const [id, domain] of Object.entries(LOGODEV)) {
  let src = prevSrc.get(id) || null;
  if (logoToken) {
    try {
      const r = await fetch(`https://img.logo.dev/${domain}?token=${logoToken}&format=png&size=64&fallback=404`);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        src = `data:${(r.headers.get('content-type') || 'image/png').split(';')[0]};base64,${buf.toString('base64')}`;
        logodevFetched++;
      } else {
        src = null; // 404 with fallback=404 → no real logo; drop rather than keep a stale one
        console.warn(`LOGODEV: ${id} -> ${domain} returned ${r.status} (stays monogram)`);
      }
    } catch (e) {
      console.warn(`LOGODEV: ${id} -> ${domain} fetch failed (${e.message}); keeping any prior icon`);
    }
  }
  if (src) {
    out.set(id, { src });
    const i = misses.findIndex((m) => m.startsWith(`${id} `));
    if (i >= 0) misses.splice(i, 1);
  }
}
if (logoToken) console.log(`Logo.dev: fetched ${logodevFetched}/${Object.keys(LOGODEV).length} live`);
else if (prevSrc.size) console.log(`Logo.dev: no token — preserved ${prevSrc.size} previously-baked logos`);

let ts = `// AUTO-GENERATED by apps/operator/scripts/gen-brand-icons.mjs — do NOT edit by hand.\n`;
ts += `// Brand logos baked per catalog/plugin id, shared by the operator (IntegrationIcon.vue) and the\n`;
ts += `// public website (integrations gallery). Two shapes: simple-icons monochrome glyphs as a single\n`;
ts += `// { path, hex } (24x24); Iconify icons (logos = full colour, mdi/cib = mono tinted by hex) as a\n`;
ts += `// full SVG { body, viewBox } — rendered with v-html of this build-baked, trusted markup.\n`;
ts += `// A third shape { src } is a Logo.dev raster logo as a base64 data URI, for brands no icon set has.\n`;
ts += `// Regenerate after adding an integration: node apps/operator/scripts/gen-brand-icons.mjs\n`;
ts += `export interface BrandIcon { path?: string; hex?: string; body?: string; viewBox?: string; src?: string }\n`;
ts += `export const BRAND_ICONS: Record<string, BrandIcon> = {\n`;
for (const [id, v] of [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const f = [];
  if (v.path) f.push(`path: ${JSON.stringify(v.path)}`);
  if (v.body) f.push(`body: ${JSON.stringify(v.body)}`);
  if (v.viewBox) f.push(`viewBox: ${JSON.stringify(v.viewBox)}`);
  if (v.src) f.push(`src: ${JSON.stringify(v.src)}`);
  if (v.hex) f.push(`hex: '${v.hex.startsWith('#') ? v.hex : '#' + v.hex}'`);
  ts += `  ${/^[a-z][\w]*$/i.test(id) ? id : `'${id}'`}: { ${f.join(', ')} },\n`;
}
ts += `};\n`;
writeFileSync(`${ROOT}/packages/contracts/src/brand-icons.ts`, ts);

console.log(`brand-icons.ts: matched ${out.size}/${entries.length + NATIVE.length} (the rest use monogram fallback)`);
if (misses.length) console.log(`no brand logo for:\n  ${misses.join('\n  ')}`);
