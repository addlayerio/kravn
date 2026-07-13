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
  'kravn-web': ['mdi:web', '#4b5563'],
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
