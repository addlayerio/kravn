<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import {
  LayoutDashboard,
  Server,
  Wrench,
  FileText,
  MessageSquare,
  Layers,
  Cpu,
  Users,
  UsersRound,
  ShieldCheck,
  Puzzle,
  Workflow,
  Settings as SettingsIcon,
  ScrollText,
  Sun,
  Moon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-vue-next';
import RavenLogo from './RavenLogo.vue';
import { useAuthStore } from '../stores/auth';
import { useBootstrapStore } from '../stores/bootstrap';
import { useThemeStore } from '../stores/theme';

const auth = useAuthStore();
const bootstrap = useBootstrapStore();
const theme = useThemeStore();
const router = useRouter();
const route = useRoute();

const instanceName = computed(() => bootstrap.info?.instanceName || 'Kravn');
const collapsed = computed(() => theme.sidebarCollapsed);

interface NavItem {
  to: string;
  label: string;
  icon: unknown;
  perm: string | null;
  section: 'main' | 'admin';
  exact?: boolean;
}

const items: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, perm: null, section: 'main', exact: true },
  { to: '/servers', label: 'Servers', icon: Server, perm: 'servers.read', section: 'main' },
  { to: '/tools', label: 'Tools', icon: Wrench, perm: 'registry.read', section: 'main' },
  { to: '/resources', label: 'Resources', icon: FileText, perm: 'registry.read', section: 'main' },
  { to: '/prompts', label: 'Prompts', icon: MessageSquare, perm: 'registry.read', section: 'main' },
  { to: '/virtual-servers', label: 'Virtual servers', icon: Layers, perm: 'virtualservers.read', section: 'main' },
  { to: '/llm-models', label: 'LLM Models', icon: Cpu, perm: 'settings.read', section: 'main' },
  { to: '/users', label: 'Users', icon: Users, perm: 'users.read', section: 'admin' },
  { to: '/teams', label: 'Teams', icon: UsersRound, perm: 'teams.read', section: 'admin' },
  { to: '/plugins', label: 'Plugins', icon: Puzzle, perm: 'settings.read', section: 'admin' },
  { to: '/pipelines', label: 'Pipelines', icon: Workflow, perm: 'settings.read', section: 'admin' },
  { to: '/authentication', label: 'Authentication', icon: ShieldCheck, perm: 'settings.read', section: 'admin' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, perm: 'settings.read', section: 'admin' },
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
        >
          <component :is="i.icon" :size="18" :stroke-width="2" />
          <span>{{ i.label }}</span>
        </RouterLink>

        <template v-if="adminItems.length">
          <div v-if="!collapsed" class="nav-section">Workspace</div>
          <div v-else class="nav-divider"></div>
          <RouterLink
            v-for="i in adminItems"
            :key="i.to"
            :to="i.to"
            class="nav-link"
            :class="{ active: isActive(i) }"
            :title="collapsed ? i.label : undefined"
          >
            <component :is="i.icon" :size="18" :stroke-width="2" />
            <span>{{ i.label }}</span>
          </RouterLink>
        </template>
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-user">
          <div class="u-name">{{ auth.user?.name || auth.user?.email }}</div>
          <small class="muted">{{ auth.user?.role }}</small>
        </div>
        <button class="ghost-btn" @click="theme.toggleDark()">
          <component :is="theme.dark ? Sun : Moon" :size="16" />
          <span>{{ theme.dark ? 'Light mode' : 'Dark mode' }}</span>
        </button>
        <button class="ghost-btn" @click="logout">
          <LogOut :size="16" />
          <span>Sign out</span>
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
