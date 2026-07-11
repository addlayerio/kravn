// VitePress build-time data loader — the public integrations gallery, generated from the SAME
// catalog + brand icons the product ships (@kravn/contracts). Add an integration to the catalog or
// NATIVE_INTEGRATIONS and it appears here automatically; nothing to hand-maintain.
import { MCP_SERVER_CATALOG, NATIVE_INTEGRATIONS, BRAND_ICONS, type BrandIcon } from '@kravn/contracts';

export interface GalleryItem {
  id: string;
  name: string;
  category: string;
  description: string;
  kind: 'built-in' | 'catalog';
  auth?: 'open' | 'apikey' | 'oauth';
  icon: BrandIcon | null;
}

export interface GalleryData {
  items: GalleryItem[];
  categories: string[];
  featured: string[];
  total: number;
  builtInCount: number;
  catalogCount: number;
}

// A recognisable subset shown on the landing page (order preserved).
const FEATURED = [
  'kravn-jira', 'kravn-odoo', 'kravn-sharepoint', 'kravn-teams', 'kravn-confluence',
  'notion', 'linear', 'asana', 'github', 'sentry', 'stripe', 'paypal', 'hubspot',
  'intercom', 'supabase', 'neon', 'vercel', 'netlify', 'cloudflare-workers', 'hugging-face',
  'zapier', 'square', 'webflow', 'mercado-pago', 'mercado-libre',
];

declare const data: GalleryData;
export { data };

export default {
  load(): GalleryData {
    const items: GalleryItem[] = [
      ...NATIVE_INTEGRATIONS.map((n) => ({
        id: n.id, name: n.name, category: n.category, description: n.description,
        kind: 'built-in' as const, icon: BRAND_ICONS[n.id] ?? null,
      })),
      ...MCP_SERVER_CATALOG.map((s) => ({
        id: s.id, name: s.name, category: s.category, description: s.description,
        kind: 'catalog' as const, auth: s.auth, icon: BRAND_ICONS[s.id] ?? null,
      })),
    ];
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const categories = [...new Set(items.map((i) => i.category))].sort();
    return {
      items,
      categories,
      featured: FEATURED,
      total: items.length,
      builtInCount: NATIVE_INTEGRATIONS.length,
      catalogCount: MCP_SERVER_CATALOG.length,
    };
  },
};
