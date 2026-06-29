import { defineStore } from 'pinia';

const KEY = 'kravn.theme';

function applyDarkClass(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
}

export const useThemeStore = defineStore('theme', {
  state: () => ({ dark: false as boolean, sidebarCollapsed: false as boolean }),
  actions: {
    load() {
      const stored = localStorage.getItem(KEY);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          this.dark = !!parsed.dark;
          this.sidebarCollapsed = !!parsed.sidebarCollapsed;
        } catch {
          /* ignore */
        }
      } else {
        this.dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
      }
      applyDarkClass(this.dark);
    },
    toggleDark() {
      this.dark = !this.dark;
      applyDarkClass(this.dark);
      this.persist();
    },
    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      this.persist();
    },
    persist() {
      localStorage.setItem(KEY, JSON.stringify({ dark: this.dark, sidebarCollapsed: this.sidebarCollapsed }));
    },
  },
});
