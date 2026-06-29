import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from './stores/auth';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'chat', component: () => import('./views/ChatView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.info) await auth.loadBootstrap();
  if (!auth.ready) await auth.loadMe();
  if (to.meta.public) {
    if (auth.isAuthenticated && to.path === '/login') return { name: 'chat' };
    return true;
  }
  if (!auth.isAuthenticated) return { name: 'login' };
  return true;
});
