import { defineStore } from 'pinia';
import type { BootstrapInfo } from '@kravn/contracts';
import { api } from '../api/client';

export const useBootstrapStore = defineStore('bootstrap', {
  state: () => ({
    info: null as BootstrapInfo | null,
  }),
  actions: {
    async load(force = false): Promise<BootstrapInfo> {
      if (this.info && !force) return this.info;
      this.info = await api.get<BootstrapInfo>('/api/bootstrap');
      return this.info;
    },
  },
});
