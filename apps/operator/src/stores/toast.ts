import { defineStore } from 'pinia';

export type ToastType = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

let seq = 0;

export const useToastStore = defineStore('toast', {
  state: () => ({ items: [] as Toast[] }),
  actions: {
    push(message: string, type: ToastType = 'info', ttl = 3500): void {
      const id = ++seq;
      this.items.push({ id, type, message });
      if (ttl > 0) setTimeout(() => this.dismiss(id), ttl);
    },
    success(message: string): void {
      this.push(message, 'success');
    },
    error(message: string): void {
      this.push(message, 'error', 5000);
    },
    info(message: string): void {
      this.push(message, 'info');
    },
    dismiss(id: number): void {
      this.items = this.items.filter((t) => t.id !== id);
    },
  },
});
