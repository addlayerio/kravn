import { defineStore } from 'pinia';
import type { AuthResponse, BootstrapInfo, LoginRequest } from '@kravn/contracts';
import { api, getToken, setToken } from '../api';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken() as string | null,
    user: null as AuthUser | null,
    info: null as BootstrapInfo | null,
    ready: false,
  }),
  getters: {
    isAuthenticated: (s) => !!s.token && !!s.user,
  },
  actions: {
    async loadBootstrap() {
      this.info = await api.get<BootstrapInfo>('/api/bootstrap').catch(() => null);
    },
    async loadMe() {
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
    /**
     * Adopt a session the server just handed us. Both `/api/auth/login` and the SSO `/api/auth/exchange`
     * return the user alongside the token, so nothing here needs a follow-up `/api/auth/me` round trip.
     */
    applySession(token: string, user: AuthUser) {
      this.token = token;
      setToken(token);
      this.user = user;
      this.ready = true;
    },
    async login(payload: LoginRequest) {
      const res = await api.post<AuthResponse>('/api/auth/login', payload);
      this.applySession(res.token, res.user as AuthUser);
    },
    async logout() {
      try {
        await api.post('/api/auth/logout');
      } catch {
        /* ignore */
      }
      this.clear();
    },
    clear() {
      this.token = null;
      this.user = null;
      setToken(null);
    },
  },
});
