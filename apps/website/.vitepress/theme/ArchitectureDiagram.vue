<script setup lang="ts">
import { h } from 'vue';
import { data } from '../integrations.data';

// Small, stroke-based icon set (currentColor) so nodes read cleanly in both themes without external deps.
const ICONS: Record<string, string> = {
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  code: '<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/>',
  bot: '<rect x="5" y="8" width="14" height="10" rx="2"/><path d="M12 4v4"/><path d="M9 13h.01M15 13h.01"/>',
  app: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16"/>',
  layers: '<path d="M4 8l8-4 8 4-8 4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  shield: '<path d="M12 3l7 3v5c0 4.2-3 7.4-7 8.5-4-1.1-7-4.3-7-8.5V6z"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 6.2A9.7 9.7 0 0112 6c5 0 9 6 9 6a15 15 0 01-2.3 2.9"/><path d="M6.5 6.9A15 15 0 003 12s4 6 9 6a9.3 9.3 0 004-.9"/><path d="M10.6 10.6a2 2 0 002.8 2.8"/>',
  journal: '<path d="M6 3h9l3 3v15H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"/>',
  chip: '<rect x="8" y="8" width="8" height="8" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.1"/><path d="M5.6 16.4c.6-1.7 1.9-2.4 3.4-2.4s2.8.7 3.4 2.4"/><path d="M14 10h4M14 13h4"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  plug: '<path d="M8 2v5M16 2v5"/><path d="M6 7h12v3a6 6 0 01-12 0z"/><path d="M12 16v5"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  down: '<path d="M12 5v13M6 11l6 6 6-6"/>',
};

const Icon = (props: { name: string }) =>
  h('svg', {
    class: 'ai',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.6,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    innerHTML: ICONS[props.name] ?? '',
  });

const consumers = [
  { icon: 'spark', label: 'Claude, ChatGPT & other LLMs' },
  { icon: 'code', label: 'IDEs — Cursor, VS Code' },
  { icon: 'bot', label: 'Custom agents' },
  { icon: 'app', label: 'Internal apps' },
];

const pipeline = [
  { icon: 'shield', label: 'Authn & RBAC' },
  { icon: 'eyeoff', label: 'PII / DLP redaction' },
  { icon: 'journal', label: 'Audit trail' },
  { icon: 'globe', label: 'SSRF egress guard' },
  { icon: 'chip', label: 'Model governance' },
];

const upstreams = [
  { icon: 'grid', label: 'Catalog', sub: `${data.catalogCount} remote MCP servers` },
  { icon: 'plug', label: 'Native integrations', sub: `${data.builtInCount} built in — Jira, Odoo, SharePoint…` },
  { icon: 'server', label: 'Your internal servers', sub: 'HTTP · SSE · stdio' },
];
</script>

<template>
  <div class="arch" role="img" aria-label="Kravn architecture: MCP clients connect to MCP endpoints on the self-hosted Kravn gateway, which enforces auth, DLP, audit, egress and model policies over a curated registry, and connects out to catalog, native and internal MCP servers.">
    <!-- ── Consumers ─────────────────────────────────────────── -->
    <section class="arch-band">
      <header class="arch-band-head">Consumers</header>
      <div class="arch-row">
        <div v-for="c in consumers" :key="c.label" class="arch-node">
          <span class="arch-node-ic"><Icon :name="c.icon" /></span>
          <span>{{ c.label }}</span>
        </div>
      </div>
    </section>

    <div class="arch-conn"><Icon name="down" class="arch-conn-ic" /><span class="arch-conn-label">MCP · HTTP / SSE</span></div>

    <!-- ── Gateway (the perimeter) ───────────────────────────── -->
    <section class="arch-gw">
      <span class="arch-perimeter-tag">Runs in your infrastructure · no data egress</span>
      <header class="arch-gw-head">
        <img src="/logo.svg" alt="" class="arch-gw-logo" />
        <div class="arch-gw-titles">
          <div class="arch-gw-title">Kravn Gateway</div>
          <div class="arch-gw-sub">registry · proxy · policy</div>
        </div>
        <span class="arch-idp"><Icon name="id" /> Identity — SAML · OIDC · SCIM · RBAC</span>
      </header>

      <div class="arch-layer">
        <div class="arch-layer-t"><span class="arch-layer-ic"><Icon name="layers" /></span> MCP Endpoints</div>
        <div class="arch-layer-d">Curated, published surfaces — <em>public</em> · <em>authenticated</em> · <em>restricted by team</em></div>
      </div>

      <div class="arch-pipe">
        <div class="arch-layer-t">Policy pipeline <span class="arch-pipe-note">opt-in · a global step can’t be bypassed</span></div>
        <div class="arch-chips">
          <span v-for="p in pipeline" :key="p.label" class="arch-chip"><Icon :name="p.icon" /> {{ p.label }}</span>
        </div>
      </div>

      <div class="arch-layer">
        <div class="arch-layer-t"><span class="arch-layer-ic"><Icon name="db" /></span> Registry</div>
        <div class="arch-layer-d">Tools · Resources · Prompts — one source of truth across every upstream</div>
      </div>
    </section>

    <div class="arch-conn"><Icon name="down" class="arch-conn-ic" /><span class="arch-conn-label">guarded egress</span></div>

    <!-- ── Upstreams ─────────────────────────────────────────── -->
    <section class="arch-band">
      <header class="arch-band-head">MCP Servers <span class="arch-band-sub">upstreams</span></header>
      <div class="arch-row">
        <div v-for="u in upstreams" :key="u.label" class="arch-node arch-node--tall">
          <span class="arch-node-ic"><Icon :name="u.icon" /></span>
          <span>
            <span class="arch-node-l">{{ u.label }}</span>
            <span class="arch-node-s">{{ u.sub }}</span>
          </span>
        </div>
      </div>
    </section>

    <p class="arch-legend">
      <strong>Control plane</strong> (admins configure the gateway) is separate from the
      <strong>data plane</strong> (users consume endpoints, authorized by team).
    </p>
  </div>
</template>

<style scoped>
.arch {
  margin: 1.5rem 0 2rem;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

/* ── Bands (consumers / upstreams) ── */
.arch-band {
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  padding: 0.85rem 0.95rem 0.95rem;
}
.arch-band-head {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
  margin-bottom: 0.65rem;
}
.arch-band-sub { font-weight: 500; text-transform: none; letter-spacing: 0; opacity: 0.7; }

.arch-row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.arch-node {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
  font-size: 0.82rem;
  color: var(--vp-c-text-1);
  line-height: 1.25;
}
.arch-node--tall { flex: 1 1 220px; align-items: flex-start; }
.arch-node-l { display: block; font-weight: 600; }
.arch-node-s { display: block; font-size: 0.72rem; color: var(--vp-c-text-3); margin-top: 0.1rem; }
.arch-node-ic {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}
.ai { width: 17px; height: 17px; display: block; }

/* ── Connectors ── */
.arch-conn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  padding: 0.4rem 0;
  color: var(--vp-c-text-3);
}
.arch-conn-ic { width: 22px; height: 22px; color: var(--vp-c-brand-2); }
.arch-conn-label {
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

/* ── Gateway ── */
.arch-gw {
  position: relative;
  border: 1.5px solid var(--vp-c-brand-1);
  border-radius: 16px;
  padding: 1.5rem 1rem 1rem;
  background:
    linear-gradient(180deg, var(--vp-c-brand-soft), transparent 38%),
    var(--vp-c-bg-soft);
  box-shadow: 0 6px 24px -14px rgba(201, 137, 44, 0.5);
}
.arch-perimeter-tag {
  position: absolute;
  top: -0.72rem;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 999px;
  padding: 0.14rem 0.7rem;
}
.arch-gw-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.85rem;
  flex-wrap: wrap;
}
.arch-gw-logo { width: 32px; height: 32px; flex: 0 0 auto; }
.arch-gw-titles { margin-right: auto; }
.arch-gw-title { font-weight: 700; font-size: 1.05rem; color: var(--vp-c-text-1); line-height: 1.1; }
.arch-gw-sub { font-size: 0.73rem; color: var(--vp-c-text-3); }
.arch-idp {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  white-space: nowrap;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  border: 1px dashed color-mix(in srgb, var(--vp-c-brand-1) 45%, var(--vp-c-divider));
  border-radius: 999px;
  padding: 0.22rem 0.6rem;
}
.arch-idp .ai { width: 15px; height: 15px; color: var(--vp-c-brand-1); }

.arch-layer,
.arch-pipe {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
  padding: 0.65rem 0.75rem;
}
.arch-layer + .arch-pipe,
.arch-pipe + .arch-layer,
.arch-layer + .arch-layer { margin-top: 0.5rem; }
.arch-layer-t {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
  font-size: 0.88rem;
  color: var(--vp-c-text-1);
}
.arch-layer-ic { color: var(--vp-c-brand-1); display: inline-flex; }
.arch-layer-ic .ai { width: 16px; height: 16px; }
.arch-layer-d { font-size: 0.78rem; color: var(--vp-c-text-2); margin-top: 0.25rem; line-height: 1.4; }
.arch-layer-d em { font-style: normal; color: var(--vp-c-text-1); font-weight: 500; }

.arch-pipe {
  background: var(--vp-c-brand-soft);
  border-color: color-mix(in srgb, var(--vp-c-brand-1) 30%, var(--vp-c-divider));
}
.arch-pipe-note { font-weight: 500; font-size: 0.68rem; color: var(--vp-c-text-3); margin-left: 0.4rem; }
.arch-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.55rem; }
.arch-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  font-size: 0.74rem;
  font-weight: 500;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg);
  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 35%, var(--vp-c-divider));
  border-radius: 999px;
  padding: 0.28rem 0.6rem;
}
.arch-chip .ai { width: 14px; height: 14px; color: var(--vp-c-brand-1); }

.arch-legend {
  margin: 1.1rem 0 0;
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
  text-align: center;
}
.arch-legend strong { color: var(--vp-c-text-1); }

@media (max-width: 640px) {
  .arch-node,
  .arch-node--tall { flex: 1 1 100%; }
  .arch-idp { font-size: 0.66rem; white-space: normal; }
}
</style>
