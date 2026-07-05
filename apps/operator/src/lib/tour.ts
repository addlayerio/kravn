import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import type { Router } from 'vue-router';

/**
 * Interactive product tour (driver.js) that actually DRIVES the app: as it advances it navigates to the
 * right page, waits for the target to mount, then spotlights it — so the highlight always lands on what's
 * visible. Two shapes:
 *   • Overview (first run, or "Take a tour" from the Dashboard): walks the whole app, page by page.
 *   • Per-page: "Take a tour" while on a specific page runs a focused tour of just that page.
 * Runs once per browser (localStorage); relaunchable from the sidebar.
 */
const SEEN_KEY = 'kravn.tour.v1.seen';

export function shouldAutoTour(): boolean {
  try {
    return !localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
}
function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* private mode */
  }
}

const has = (sel: string): boolean => !!document.querySelector(sel);
const waitFor = (sel: string, ms = 4000): Promise<void> =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (has(sel) || Date.now() - t0 > ms ? resolve() : window.setTimeout(tick, 60));
    tick();
  });

type Side = 'top' | 'bottom' | 'left' | 'right';
interface Step {
  route?: string; // navigate here before showing
  element?: string; // spotlight target (centered if omitted)
  title: string;
  description: string;
  side?: Side;
  run?: () => void; // e.g. click a tab so the target becomes visible
}

// ─── Plans ──────────────────────────────────────────────────────────────────────────────────────
function overviewPlan(): Step[] {
  return [
    {
      title: 'Welcome to Kravn 🐦‍⬛',
      description:
        'Your self-hosted MCP gateway: connect AI tools to your systems, governed by your own policies, with nothing leaving your network. This tour walks the whole console — I\'ll change pages as we go.',
    },
    {
      route: '/servers',
      element: '[data-tour="servers"]',
      title: 'MCP Servers',
      description:
        'An MCP server is an external tool source. Here you connect them: "Installed" is what you\'ve added; the "Catalog" lets you browse 100+ ready integrations plus the built-in ones and connect in a click.',
    },
    {
      route: '/tools',
      element: '[data-tour="tools"]',
      title: 'Tools',
      description:
        'Tools are the individual actions your connected servers expose — "create issue", "search records", "send message". This is what your AI can actually DO once you publish it.',
    },
    {
      route: '/resources',
      element: '[data-tour="resources"]',
      title: 'Resources',
      description:
        'Resources are read-only data a server exposes — files, records, documents — that the AI can pull in as context (rather than an action it performs).',
    },
    {
      route: '/prompts',
      element: '[data-tour="prompts"]',
      title: 'Prompts',
      description:
        'Prompts are reusable prompt templates. Servers can provide them, and you can author your own custom prompts here — exposed to any client via prompts/list.',
    },
    {
      route: '/mcp-endpoints',
      element: '[data-tour="endpoints"]',
      title: 'MCP Endpoints',
      description:
        'An endpoint composes the tools, resources and prompts you choose into ONE governed URL your AI clients (Claude, your agents) point at — instead of a dozen scattered servers.',
    },
    {
      route: '/teams',
      element: '[data-tour="teams"]',
      title: 'Teams & access',
      description: 'Users, Teams and roles decide who can consume which endpoints and tools. Your corporate SSO/SCIM identity plugs straight in.',
    },
    {
      route: '/plugins',
      element: '[data-tour="plugins"]',
      title: 'Governance (Plugins)',
      description:
        'Plugins are governance hooks — redact secrets and PII, block prompt injection, keep a tamper-evident audit trail. They compose into pipelines that no single endpoint can switch off.',
    },
    {
      route: '/settings',
      element: '[data-tour="settings"]',
      title: 'Settings',
      description: 'Authentication, SSO, SSRF policy, rate limits and more live here and apply instantly — no redeploy. Only true infrastructure (database, secret) is environment config.',
    },
    {
      route: '/servers',
      element: '[data-tour="servers"]',
      title: 'Start here 🚀',
      description: 'Open the Catalog and connect your first integration — everything else builds on top. Replay this any time from “Take a tour”.',
    },
  ];
}

function serversPlan(): Step[] {
  return [
    {
      element: '[data-tour="catalog-tab"]',
      side: 'bottom',
      title: 'MCP Servers',
      description: 'This page manages the tool sources Kravn connects to. "Installed" shows what you\'ve connected; the "Catalog" is where you add more.',
    },
    {
      element: '[data-tour="catalog-tab"]',
      side: 'bottom',
      title: 'The Catalog',
      description: 'Browse 100+ public MCP servers plus the built-in integrations. Click a card for a detail view — what it does, how it connects, and how to get the token.',
      run: () => document.querySelector<HTMLElement>('[data-tour="catalog-tab"]')?.click(),
    },
    {
      element: '[data-tour="catalog-search"]',
      side: 'bottom',
      title: 'Find & install',
      description: 'Search or filter by category. Servers with no auth or an API key connect on Add; OAuth ones (e.g. GitHub) show a Connect button and let you paste the OAuth app details.',
    },
    {
      element: '[data-tour="catalog-grid"]',
      side: 'top',
      title: 'One click to add',
      description: 'Add a remote server or enable a built-in. It then appears under "Installed" and its tools flow into the registry, ready to compose into an endpoint.',
    },
  ];
}

function promptsPlan(): Step[] {
  return [
    {
      element: '[data-tour="prompt-new"]',
      side: 'left',
      title: 'Prompts',
      description: 'Prompts are reusable prompt templates your AI can call by name (via prompts/list). Servers can provide them — and you author your own custom ones here.',
    },
    {
      element: '[data-tour="prompt-new"]',
      side: 'left',
      title: 'Create a custom prompt',
      description: 'Click “+ New prompt”: give it a name, the template text, and optional {{arguments}} that get filled at call time. Save it, then include it in any MCP Endpoint to expose it.',
    },
  ];
}

function pagePlan(path?: string): Step[] | null {
  if (!path) return null;
  if (path.startsWith('/servers')) return serversPlan();
  if (path.startsWith('/prompts')) return promptsPlan();
  return null;
}

// ─── Runner ─────────────────────────────────────────────────────────────────────────────────────
export function startTour(router: Router, path?: string): void {
  const plan = pagePlan(path) ?? overviewPlan();
  let d: ReturnType<typeof driver>;

  const goTo = async (i: number): Promise<void> => {
    if (i < 0) return;
    if (i >= plan.length) {
      d.destroy();
      return;
    }
    const s = plan[i];
    if (s.route && router.currentRoute.value.path !== s.route) await router.push(s.route).catch(() => {});
    if (s.run) {
      try {
        s.run();
      } catch {
        /* best-effort */
      }
    }
    if (s.element) await waitFor(s.element);
    d.moveTo(i);
  };

  d = driver({
    showProgress: true,
    allowClose: true,
    overlayColor: 'rgba(0, 0, 0, 0.6)',
    stagePadding: 6,
    stageRadius: 10,
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    doneBtnText: 'Done',
    steps: plan.map((s) => ({
      element: s.element,
      popover: { title: s.title, description: s.description, side: (s.side ?? 'right') as Side, align: 'start' as const },
    })),
    // Take control of navigation so we change page + wait for the target before advancing.
    onNextClick: () => void goTo((d.getActiveIndex() ?? 0) + 1),
    onPrevClick: () => void goTo((d.getActiveIndex() ?? 0) - 1),
    onDestroyed: markSeen,
  });

  // Kick off (navigate/prepare the first step if it needs it).
  void (async () => {
    const first = plan[0];
    if (first?.route && router.currentRoute.value.path !== first.route) await router.push(first.route).catch(() => {});
    if (first?.run) {
      try {
        first.run();
      } catch {
        /* best-effort */
      }
    }
    if (first?.element) await waitFor(first.element);
    d.drive();
  })();
}
