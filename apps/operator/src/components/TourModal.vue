<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { Sparkles, Boxes, Layers, UsersRound, ShieldCheck, SlidersHorizontal, Rocket } from 'lucide-vue-next';

/**
 * First-run guided product tour. A centered, self-contained stepper (no fragile element anchoring) that
 * explains what the console does and reinforces the integrations Catalog. Runs once per browser (localStorage)
 * and is relaunchable from the sidebar.
 */
const emit = defineEmits<{ (e: 'close'): void }>();
const router = useRouter();
const SEEN_KEY = 'kravn.tour.v1.seen';

interface Step {
  icon: unknown;
  title: string;
  body: string;
  star?: boolean; // the Catalog step — visually reinforced
  catalog?: boolean; // offer the "Open the Catalog" action
}

const steps: Step[] = [
  {
    icon: Sparkles,
    title: 'Welcome to Kravn',
    body: 'Your self-hosted MCP gateway — connect AI tools to your systems, governed by your own policies, with nothing leaving your network. Here is the 30-second tour.',
  },
  {
    icon: Boxes,
    title: 'Start in the Catalog',
    body: 'On MCP Servers → Catalog you browse every integration in one place — 100+ public MCP servers (Notion, Stripe, Linear, Sentry…) plus the built-in ones (Jira, Teams, SharePoint). Find one, click it for details, and install or connect in a click.',
    star: true,
    catalog: true,
  },
  {
    icon: Layers,
    title: 'Publish MCP Endpoints',
    body: 'Compose the tools you connected into curated Endpoints — one governed URL your AI clients (Claude, your agents) point at, instead of a dozen scattered servers.',
  },
  {
    icon: UsersRound,
    title: 'Control who sees what',
    body: 'Users, Teams and roles decide who can consume which endpoints and tools — your corporate identity (SSO/SCIM) plugs straight in.',
  },
  {
    icon: ShieldCheck,
    title: 'Govern every call',
    body: 'Plugins are governance hooks — redact secrets and PII, block prompt injection, and keep a tamper-evident audit trail. Compose them into Pipelines that no single endpoint can switch off.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Configure without redeploys',
    body: 'Authentication, SSRF policy, rate limits and more live in Settings and apply instantly. Only true infrastructure (database, secret) is environment config.',
  },
  {
    icon: Rocket,
    title: "You're ready",
    body: 'The best first step is connecting an integration. Open the Catalog and pick one — everything else builds on top.',
    catalog: true,
  },
];

const i = ref(0);
const step = () => steps[i.value];

function persist() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* private mode — the tour simply reappears next session */
  }
}
function next() {
  if (i.value < steps.length - 1) i.value += 1;
  else finish();
}
function back() {
  if (i.value > 0) i.value -= 1;
}
function finish() {
  persist();
  emit('close');
}
function openCatalog() {
  persist();
  emit('close');
  router.push('/servers');
}
</script>

<template>
  <div class="tour-backdrop" @click.self="finish">
    <div class="tour-card">
      <div class="tour-icon" :class="{ star: step().star }">
        <component :is="step().icon" :size="28" :stroke-width="1.8" />
      </div>
      <h2 class="tour-title">{{ step().title }}</h2>
      <p class="tour-body">{{ step().body }}</p>

      <div class="tour-dots">
        <span v-for="(s, idx) in steps" :key="idx" class="dot" :class="{ on: idx === i }"></span>
      </div>

      <div class="tour-actions">
        <button class="btn ghost" @click="finish">Skip</button>
        <div class="tour-right">
          <button v-if="i > 0" class="btn" @click="back">Back</button>
          <button v-if="step().catalog" class="btn accent" @click="openCatalog">Open the Catalog</button>
          <button class="btn primary" @click="next">{{ i === steps.length - 1 ? 'Done' : 'Next' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tour-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}
.tour-card {
  width: 100%;
  max-width: 440px;
  background: var(--bg-surface, #1a1d24);
  color: var(--text, #e6e6e6);
  border: 1px solid var(--border, #33384a);
  border-radius: 16px;
  padding: 28px;
  text-align: center;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}
.tour-icon {
  width: 60px;
  height: 60px;
  margin: 0 auto 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  background: var(--hover, rgba(255, 255, 255, 0.06));
  color: var(--text-muted, #9aa0aa);
}
.tour-icon.star {
  background: rgba(108, 140, 255, 0.14);
  color: var(--accent, #6c8cff);
}
.tour-title {
  margin: 0 0 8px;
  font-size: 1.25rem;
}
.tour-body {
  margin: 0 0 20px;
  color: var(--text-muted, #9aa0aa);
  line-height: 1.55;
  font-size: 0.95rem;
}
.tour-dots {
  display: flex;
  gap: 6px;
  justify-content: center;
  margin-bottom: 20px;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--border, #33384a);
}
.dot.on {
  background: var(--accent, #6c8cff);
  width: 20px;
}
.tour-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tour-right {
  display: flex;
  gap: 8px;
}
.btn.ghost {
  background: transparent;
  color: var(--text-muted, #9aa0aa);
}
.btn.accent {
  background: rgba(108, 140, 255, 0.16);
  color: var(--accent, #6c8cff);
  border-color: transparent;
}
</style>
