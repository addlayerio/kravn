import { defineStore } from 'pinia';
import { permissionMatches, PLATFORM_ADMIN_TEAM_ID, type AuthResponse, type LoginRequest, type SetupRequest } from '@kravn/contracts';
import { api, getToken, setToken } from '../api/client';

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: readonly string[];
  teams?: string[];
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken() as string | null,
    user: null as AuthUser | null,
    ready: false,
  }),
  getters: {
    isAuthenticated: (s) => !!s.token && !!s.user,
    // Mirrors the backend gate: a system admin (role) OR a Platform Administrator Team member may use the
    // console. A pure MCP consumer is authenticated but neither. The role check also keeps this robust if a
    // response ever omits teams.
    isPlatformAdmin: (s) => s.user?.role === 'admin' || !!s.user?.teams?.includes(PLATFORM_ADMIN_TEAM_ID),
  },
  actions: {
    can(permission: string): boolean {
      if (!this.user) return false;
      return permissionMatches(this.user.permissions, permission);
    },
    async loadMe(): Promise<void> {
      if (!this.token) {
        this.ready = true;
        return;
      }
      try {
        const res = await api.get<{ user: AuthUser }>('/api/auth/me');
        this.user = res.user;
      } catch {
        this.clear();
      } finally {
        this.ready = true;
      }
    },
    applyAuth(res: AuthResponse): void {
      this.token = res.token;
      setToken(res.token);
      this.user = res.user as AuthUser;
    },
    async login(payload: LoginRequest): Promise<void> {
      const res = await api.post<AuthResponse>('/api/auth/login', payload);
      this.applyAuth(res);
    },
    async setup(payload: SetupRequest): Promise<void> {
      const res = await api.post<AuthResponse>('/api/setup', payload);
      this.applyAuth(res);
    },
    async logout(): Promise<void> {
      try {
        await api.post('/api/auth/logout');
      } catch {
        /* ignore */
      }
      this.clear();
    },
    clear(): void {
      this.token = null;
      this.user = null;
      setToken(null);
    },
  },
});
