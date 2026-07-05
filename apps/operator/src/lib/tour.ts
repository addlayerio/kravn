import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import type { Router } from 'vue-router';

/**
 * Interactive product tour (driver.js). Spotlights the real sidebar controls and walks the user through the
 * console step by step, reinforcing the Catalog as the place to start, then drops them there. Runs once per
 * browser (localStorage) and is relaunchable from the sidebar.
 *
 * Steps anchor to `[data-tour="…"]` on the nav; steps whose element isn't visible (permission-limited users)
 * are dropped so the tour still works for everyone.
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

interface RawStep {
  element?: string;
  title: string;
  description: string;
}

export function startTour(router: Router): void {
  const SERVERS = '[data-tour="servers"]';
  const hasServers = !!document.querySelector(SERVERS);

  const raw: RawStep[] = [
    {
      title: 'Welcome to Kravn',
      description:
        'Your self-hosted MCP gateway — connect AI tools to your systems, governed by your own policies, with nothing leaving your network. Here is the 30-second tour.',
    },
    {
      element: SERVERS,
      title: 'Integrations live here ⭐',
      description:
        'MCP Servers → Catalog is where you browse 100+ public MCP servers (Notion, Stripe, Linear, Sentry…) plus the built-in ones (Jira, Teams, SharePoint), and connect in a click. Start here.',
    },
    {
      element: '[data-tour="endpoints"]',
      title: 'Publish MCP Endpoints',
      description:
        'Compose the tools you connect into one governed URL your AI clients (Claude, your agents) point at — instead of a dozen scattered servers.',
    },
    {
      element: '[data-tour="teams"]',
      title: 'Control who sees what',
      description:
        'Users, Teams and roles decide who can consume which endpoints and tools. Your corporate identity (SSO/SCIM) plugs straight in.',
    },
    {
      element: '[data-tour="plugins"]',
      title: 'Govern every call',
      description:
        'Plugins are governance hooks — redact secrets and PII, block prompt injection, and keep a tamper-evident audit trail. Compose them into pipelines no endpoint can switch off.',
    },
    {
      element: '[data-tour="settings"]',
      title: 'Configure without redeploys',
      description:
        'Authentication, SSRF policy, rate limits and more live in Settings and apply instantly. Only true infrastructure (database, secret) is environment config.',
    },
    {
      element: SERVERS,
      title: "You're ready",
      description: 'Head to the Catalog and connect your first integration — everything else builds on top.',
    },
  ];

  const steps = raw.filter((s) => !s.element || document.querySelector(s.element));
  if (!steps.length) return;
  const lastIsCatalog = steps[steps.length - 1]?.element === SERVERS && hasServers;
  let completed = false;

  const d = driver({
    showProgress: true,
    allowClose: true,
    overlayColor: 'rgba(0, 0, 0, 0.65)',
    stagePadding: 6,
    stageRadius: 10,
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    doneBtnText: lastIsCatalog ? 'Open the Catalog' : 'Done',
    steps: steps.map((s, idx) => ({
      element: s.element,
      popover: { title: s.title, description: s.description, side: 'right' as const, align: 'start' as const },
      onHighlightStarted:
        idx === steps.length - 1
          ? () => {
              completed = true;
            }
          : undefined,
    })),
    onDestroyed: () => {
      markSeen();
      if (completed && lastIsCatalog) router.push('/servers');
    },
  });
  d.drive();
}
