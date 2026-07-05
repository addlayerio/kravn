import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import type { Router } from 'vue-router';

/**
 * Interactive product tour (driver.js). Unlike a static walkthrough, it actually DRIVES the app: it navigates
 * to MCP Servers, opens the Catalog tab, and spotlights the real controls step by step — then covers
 * endpoints, access, governance and settings. Steps whose anchor isn't available (permission-limited users)
 * are skipped. Runs once per browser (localStorage) and is relaunchable from the sidebar.
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
    /* private mode: the tour just reappears next session */
  }
}

const has = (sel: string): boolean => !!document.querySelector(sel);
const waitFor = (sel: string, ms = 3500): Promise<void> =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (has(sel) || Date.now() - t0 > ms ? resolve() : window.setTimeout(tick, 60));
    tick();
  });

export function startTour(router: Router): void {
  const hasServers = has('[data-tour="servers"]');
  let d: ReturnType<typeof driver>;

  // Advance helpers used by steps that change the screen before moving on.
  const navThen = (path: string, waitSel: string) => async () => {
    if (router.currentRoute.value.path !== path) await router.push(path).catch(() => {});
    await waitFor(waitSel);
    d.moveNext();
  };
  const clickThen = (clickSel: string, waitSel: string) => async () => {
    document.querySelector<HTMLElement>(clickSel)?.click();
    await waitFor(waitSel);
    d.moveNext();
  };

  // driver.js step shape (loosely typed — the lib's types are permissive).
  type Step = { element?: string; popover: Record<string, unknown>; onNextClick?: () => void };
  const navStep = (element: string, title: string, description: string): Step => ({
    element,
    popover: { title, description, side: 'right', align: 'start' },
  });

  const steps: Step[] = [
    {
      popover: {
        title: 'Welcome to Kravn 🐦‍⬛',
        description:
          'Your self-hosted MCP gateway — connect AI tools to your systems, governed by your own policies, with nothing leaving your network. Let me walk you through it (I\'ll drive).',
      },
    },
  ];

  if (hasServers) {
    steps.push(
      {
        element: '[data-tour="servers"]',
        popover: {
          title: '1 · Connect integrations',
          description: 'Everything starts here, in MCP Servers. Hit Next and I\'ll open it for you.',
          side: 'right',
          align: 'start',
        },
        onNextClick: navThen('/servers', '[data-tour="catalog-tab"]'),
      },
      {
        element: '[data-tour="catalog-tab"]',
        popover: {
          title: 'The Catalog',
          description:
            'Not just what you\'ve installed — a catalog of 100+ ready integrations (Notion, Stripe, GitHub, Linear…) plus the built-in ones. Next opens it.',
          side: 'bottom',
        },
        onNextClick: clickThen('[data-tour="catalog-tab"]', '[data-tour="catalog-grid"]'),
      },
      {
        element: '[data-tour="catalog-search"]',
        popover: {
          title: 'Find & install in a click',
          description:
            'Search or filter by category. Click any card for a detail view — what it does, how it connects, and step-by-step how to get the token. Then Add, or Connect for OAuth ones.',
          side: 'bottom',
        },
      },
    );
  }

  if (has('[data-tour="endpoints"]'))
    steps.push(
      navStep(
        '[data-tour="endpoints"]',
        '2 · Publish endpoints',
        'Compose the tools you connect into one governed URL your AI clients (Claude, your agents) point at — instead of a dozen scattered servers.',
      ),
    );
  if (has('[data-tour="teams"]'))
    steps.push(
      navStep(
        '[data-tour="teams"]',
        '3 · Control who sees what',
        'Users, Teams and roles decide who can consume which endpoints and tools. Your corporate identity (SSO/SCIM) plugs straight in.',
      ),
    );
  if (has('[data-tour="plugins"]'))
    steps.push(
      navStep(
        '[data-tour="plugins"]',
        '4 · Govern every call',
        'Plugins are governance hooks — redact secrets and PII, block prompt injection, keep a tamper-evident audit trail. They compose into pipelines no endpoint can switch off.',
      ),
    );
  if (has('[data-tour="settings"]'))
    steps.push(
      navStep(
        '[data-tour="settings"]',
        '5 · Configure without redeploys',
        'Authentication, SSO, SSRF policy, rate limits and more live in Settings and apply instantly. Only true infrastructure (database, secret) is environment config.',
      ),
    );

  if (hasServers)
    steps.push({
      element: '[data-tour="catalog-grid"]',
      popover: {
        title: "You're ready 🚀",
        description:
          'Pick an integration from the Catalog and connect it — everything else builds on top. Replay this tour any time from “Take a tour” in the sidebar.',
        side: 'top',
      },
      onNextClick: navThen('/servers', '[data-tour="catalog-grid"]'),
    });

  if (steps.length <= 1) {
    markSeen();
    return;
  }

  d = driver({
    showProgress: true,
    allowClose: true,
    overlayColor: 'rgba(0, 0, 0, 0.65)',
    stagePadding: 6,
    stageRadius: 10,
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    doneBtnText: 'Done',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    steps: steps as any,
    onDestroyed: markSeen,
  });
  d.drive();
}
