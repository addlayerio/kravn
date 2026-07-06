import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from './stores/auth';
import { useBootstrapStore } from './stores/bootstrap';

const routes: RouteRecordRaw[] = [
  { path: '/setup', name: 'setup', component: () => import('./views/SetupView.vue'), meta: { public: true } },
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  // Standalone full-page OAuth consent (requires auth -> the guard routes through login/SSO first).
  { path: '/oauth/consent', name: 'oauth-consent', component: () => import('./views/OAuthConsentView.vue') },
  {
    path: '/',
    component: () => import('./components/AppShell.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', name: 'dashboard', component: () => import('./views/DashboardView.vue') },
      { path: 'servers', name: 'servers', component: () => import('./views/ServersView.vue'), meta: { permission: 'servers.read' } },
      { path: 'tools', name: 'tools', component: () => import('./views/ToolsView.vue'), meta: { permission: 'registry.read' } },
      { path: 'resources', name: 'resources', component: () => import('./views/ResourcesView.vue'), meta: { permission: 'registry.read' } },
      { path: 'prompts', name: 'prompts', component: () => import('./views/PromptsView.vue'), meta: { permission: 'registry.read' } },
      { path: 'mcp-endpoints', name: 'mcp-endpoints', component: () => import('./views/McpEndpointsView.vue'), meta: { permission: 'endpoints.read' } },
      { path: 'mcp-endpoints/new', name: 'mcp-endpoint-new', component: () => import('./views/McpEndpointEditView.vue'), meta: { permission: 'endpoints.write' } },
      { path: 'mcp-endpoints/:id', name: 'mcp-endpoint-edit', component: () => import('./views/McpEndpointEditView.vue'), meta: { permission: 'endpoints.read' } },
      // Back-compat: the old /virtual-servers* URLs (renamed to /mcp-endpoints) still resolve.
      { path: 'virtual-servers', redirect: { name: 'mcp-endpoints' } },
      { path: 'virtual-servers/new', redirect: { name: 'mcp-endpoint-new' } },
      { path: 'virtual-servers/:id', redirect: (to) => ({ name: 'mcp-endpoint-edit', params: { id: to.params.id } }) },
      { path: 'llm-models', name: 'llm-models', component: () => import('./views/LlmModelsView.vue'), meta: { permission: 'settings.read' } },
      { path: 'users', name: 'users', component: () => import('./views/UsersView.vue'), meta: { permission: 'users.read' } },
      { path: 'teams', name: 'teams', component: () => import('./views/TeamsView.vue'), meta: { permission: 'teams.read' } },
      { path: 'plugins', name: 'plugins', component: () => import('./views/PluginsView.vue'), meta: { permission: 'settings.read' } },
      { path: 'pipelines', name: 'pipelines', component: () => import('./views/PipelinesView.vue'), meta: { permission: 'settings.read' } },
      { path: 'authentication', name: 'authentication', component: () => import('./views/AuthenticationView.vue'), meta: { permission: 'settings.read' } },
      { path: 'settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { permission: 'settings.read' } },
      { path: 'logs', name: 'logs', component: () => import('./views/LogsView.vue'), meta: { permission: 'logs.read' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  const bootstrap = useBootstrapStore();

  const info = await bootstrap.load().catch(() => null);
  if (!auth.ready) await auth.loadMe();

  if (info?.setupRequired) {
    return to.path === '/setup' ? true : { name: 'setup' };
  }

  // An authenticated user who is NOT in the Platform Administrator Team may hold a valid session (e.g. an
  // MCP consumer) but must not reach the admin console. Keep them on /login with a clear message instead of
  // a dashboard that 403s on every request. EXCEPTION: the standalone OAuth consent page exists FOR these
  // consumers — it authorizes only their own session (the backend consent API requires auth, not admin, and
  // approve() mints an MCP-scoped token for their own identity), so let them through or they can never
  // connect an MCP endpoint without being a platform admin.
  if (auth.isAuthenticated && !auth.isPlatformAdmin) {
    if (to.name === 'oauth-consent') return true;
    return to.path === '/login' ? true : { name: 'login', query: { denied: '1' } };
  }

  if (to.meta.public) {
    if (to.path === '/setup') return { name: 'login' }; // setup already done
    if (auth.isAuthenticated && to.path === '/login') return { name: 'dashboard' };
    return true;
  }

  if (!auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } };

  const required = to.meta.permission as string | undefined;
  if (required && !auth.can(required)) return { name: 'dashboard' };

  return true;
});
