<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import {
  LayoutDashboard,
  Server,
  Wrench,
  FileText,
  MessageSquare,
  Layers,
  Bot,
  Cpu,
  Users,
  UsersRound,
  ShieldCheck,
  Puzzle,
  Workflow,
  Settings as SettingsIcon,
  Palette,
  ScrollText,
  Scale,
  Sun,
  Moon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Compass,
} from 'lucide-vue-next';
import RavenLogo from './RavenLogo.vue';
import { startTour, shouldAutoTour } from '../lib/tour';
import { useAuthStore } from '../stores/auth';
import { useBootstrapStore } from '../stores/bootstrap';
import { useThemeStore } from '../stores/theme';
import { useI18n } from 'vue-i18n';
import LocaleSwitcher from './LocaleSwitcher.vue';

const { t } = useI18n();
const auth = useAuthStore();
const bootstrap = useBootstrapStore();
const theme = useThemeStore();
const router = useRouter();
const route = useRoute();

const instanceName = computed(() => bootstrap.info?.instanceName || 'Kravn');
const collapsed = computed(() => theme.sidebarCollapsed);

// Map each nav route to its i18n key; falls back to the static English label if unmapped.
const NAV_KEY: Record<string, string> = {
  '/': 'dashboard', '/servers': 'servers', '/tools': 'tools', '/resources': 'resources',
  '/prompts': 'prompts', '/mcp-endpoints': 'endpoints', '/agents': 'agents', '/users': 'users', '/teams': 'teams',
  '/authentication': 'authentication', '/plugins': 'plugins', '/pipelines': 'pipelines',
  '/llm-models': 'llmModels', '/settings': 'settings', '/appearance': 'appearance',
  '/governance': 'governance', '/logs': 'logs',
};
function navLabel(i: { to: string; label: string }): string {
  const key = NAV_KEY[i.to];
  return key ? t(`nav.${key}`) : i.label;
}

interface NavItem {
  to: string;
  label: string;
  icon: unknown;
  perm: string | null;
  section: 'main' | 'admin';
  exact?: boolean;
  tour?: string; // anchor id for the guided tour
}

const items: NavItem[] = [
  // Main — the MCP data plane: connect sources → see the catalog → publish endpoints.
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, perm: null, section: 'main', exact: true },
  { to: '/servers', label: 'MCP Servers', icon: Server, perm: 'servers.read', section: 'main', tour: 'servers' },
  { to: '/tools', label: 'Tools', icon: Wrench, perm: 'registry.read', section: 'main', tour: 'tools' },
  { to: '/resources', label: 'Resources', icon: FileText, perm: 'registry.read', section: 'main', tour: 'resources' },
  { to: '/prompts', label: 'Prompts', icon: MessageSquare, perm: 'registry.read', section: 'main', tour: 'prompts' },
  { to: '/mcp-endpoints', label: 'MCP Endpoints', icon: Layers, perm: 'endpoints.read', section: 'main', tour: 'endpoints' },
  { to: '/agents', label: 'Agents', icon: Bot, perm: 'settings.read', section: 'main' },
  // Administration — identity → processing → platform.
  { to: '/users', label: 'Users', icon: Users, perm: 'users.read', section: 'admin' },
  { to: '/teams', label: 'Teams', icon: UsersRound, perm: 'teams.read', section: 'admin', tour: 'teams' },
  { to: '/authentication', label: 'Authentication', icon: ShieldCheck, perm: 'settings.read', section: 'admin' },
  { to: '/plugins', label: 'Plugins', icon: Puzzle, perm: 'settings.read', section: 'admin', tour: 'plugins' },
  { to: '/pipelines', label: 'Pipelines', icon: Workflow, perm: 'settings.read', section: 'admin' },
  { to: '/llm-models', label: 'LLM Models', icon: Cpu, perm: 'settings.read', section: 'admin' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, perm: 'settings.read', section: 'admin', tour: 'settings' },
  { to: '/appearance', label: 'Appearance', icon: Palette, perm: 'settings.write', section: 'admin' },
  { to: '/governance', label: 'Governance', icon: Scale, perm: 'servers.read', section: 'admin' },
  { to: '/logs', label: 'Logs', icon: ScrollText, perm: 'logs.read', section: 'admin' },
];

const visible = computed(() => items.filter((i) => !i.perm || auth.can(i.perm)));
const mainItems = computed(() => visible.value.filter((i) => i.section === 'main'));
const adminItems = computed(() => visible.value.filter((i) => i.section === 'admin'));

function isActive(i: NavItem): boolean {
  return i.exact ? route.path === i.to : route.path.startsWith(i.to);
}

async function logout() {
  await auth.logout();
  router.push('/login');
}

// First-run guided tour (once per browser); relaunchable from the sidebar. The short delay lets the sidebar
// finish rendering so driver.js can anchor to the nav items.
onMounted(() => {
  if (shouldAutoTour()) window.setTimeout(() => startTour(router), 500);
});
</script>

<template>
  <div class="shell">
    <aside class="sidebar" :class="{ collapsed }">
      <div class="brand">
        <RavenLogo :size="26" />
        <span class="brand-name">{{ instanceName }}</span>
      </div>

      <nav class="nav">
        <RouterLink
          v-for="i in mainItems"
          :key="i.to"
          :to="i.to"
          class="nav-link"
          :class="{ active: isActive(i) }"
          :title="collapsed ? i.label : undefined"
          :data-tour="i.tour"
        >
          <component :is="i.icon" :size="18" :stroke-width="2" />
          <span>{{ navLabel(i) }}</span>
        </RouterLink>

        <template v-if="adminItems.length">
          <div v-if="!collapsed" class="nav-section">Administration</div>
          <div v-else class="nav-divider"></div>
          <RouterLink
            v-for="i in adminItems"
            :key="i.to"
            :to="i.to"
            class="nav-link"
            :class="{ active: isActive(i) }"
            :title="collapsed ? i.label : undefined"
            :data-tour="i.tour"
          >
            <component :is="i.icon" :size="18" :stroke-width="2" />
            <span>{{ navLabel(i) }}</span>
          </RouterLink>
        </template>
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-user">
          <div class="u-name">{{ auth.user?.name || auth.user?.email }}</div>
          <small class="muted">{{ auth.user?.role }}</small>
        </div>
        <div v-if="!collapsed" style="padding: 4px 0 6px"><LocaleSwitcher /></div>
        <button class="ghost-btn" @click="startTour(router, route.path)">
          <Compass :size="16" />
          <span>Take a tour</span>
        </button>
        <button class="ghost-btn" @click="theme.toggleDark()">
          <component :is="theme.dark ? Sun : Moon" :size="16" />
          <span>{{ theme.dark ? 'Light mode' : 'Dark mode' }}</span>
        </button>
        <button class="ghost-btn" @click="logout">
          <LogOut :size="16" />
          <span>{{ t('common.signOut') }}</span>
        </button>
        <button class="ghost-btn" @click="theme.toggleSidebar()">
          <component :is="collapsed ? PanelLeftOpen : PanelLeftClose" :size="16" />
          <span>Collapse</span>
        </button>
      </div>
    </aside>

    <div class="shell-main">
      <main class="main">
        <div class="page-wrap">
          <RouterView />
        </div>
      </main>
    </div>

  </div>
</template>

<style scoped>
.nav-section {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 14px 12px 4px;
}
.nav-divider {
  height: 1px;
  background: var(--border);
  margin: 8px 12px;
}
</style>
