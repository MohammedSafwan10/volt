/**
 * Toast notification store using Svelte 5 runes
 * Provides showToast() function for displaying notifications
 */

import { writable, type Writable } from 'svelte/store';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  message: string;
  type: ToastType;
  duration?: number;
  action?: ToastAction;
}

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
  action?: ToastAction;
  count: number;
  createdAt: number;
}

const MAX_VISIBLE_TOASTS = 5;
const DEFAULT_DURATION = 5000;
const RATE_LIMIT_MS = 500;
const DUPLICATE_WINDOW_MS = 2000;

class ToastStore {
  private readonly toastsStore: Writable<Toast[]>;
  toasts: Toast[] = [];
  private lastToastTime = 0;
  private lastToastMessage = '';

  constructor() {
    this.toastsStore = writable<Toast[]>([]);
    this.toastsStore.subscribe((value) => {
      this.toasts = value;
    });
  }

  private setToasts(next: Toast[]): void {
    this.toasts = next;
    this.toastsStore.set(next);
  }

  /**
   * Show a toast notification
   */
  show(options: ToastOptions): string | null {
    const now = Date.now();
    const { message, type, duration = DEFAULT_DURATION, action } = options;

    // Rate limiting: max 1 toast per 500ms for same message
    if (
      message === this.lastToastMessage &&
      now - this.lastToastTime < RATE_LIMIT_MS
    ) {
      return null;
    }

    // Check for duplicate messages within 2s - increment counter instead
    const existingToast = this.toasts.find(
      (t) =>
        t.message === message &&
        t.type === type &&
        now - t.createdAt < DUPLICATE_WINDOW_MS
    );

    if (existingToast) {
      existingToast.count += 1;
      existingToast.createdAt = now; // Reset timer
      this.setToasts([...this.toasts]);
      this.lastToastTime = now;
      this.lastToastMessage = message;
      return existingToast.id;
    }

    const id = crypto.randomUUID();
    const toast: Toast = {
      id,
      message,
      type,
      duration,
      action,
      count: 1,
      createdAt: now
    };

    // Add new toast at the end (bottom of stack)
    this.setToasts([...this.toasts, toast]);

    // Limit visible toasts
    if (this.toasts.length > MAX_VISIBLE_TOASTS) {
      this.setToasts(this.toasts.slice(-MAX_VISIBLE_TOASTS));
    }

    this.lastToastTime = now;
    this.lastToastMessage = message;

    // Auto-dismiss
    if (duration > 0) {
      setTimeout(() => {
        this.dismiss(id);
      }, duration);
    }

    return id;
  }

  /**
   * Dismiss a toast by ID
   */
  dismiss(id: string): void {
    this.setToasts(this.toasts.filter((t) => t.id !== id));
  }

  /**
   * Dismiss all toasts
   */
  dismissAll(): void {
    this.setToasts([]);
  }
}

// Singleton instance
export const toastStore = new ToastStore();

/**
 * Convenience function to show a toast
 */
export function showToast(options: ToastOptions): string | null {
  return toastStore.show(options);
}

/**
 * Convenience function to dismiss a toast
 */
export function dismissToast(id: string): void {
  toastStore.dismiss(id);
}

/**
 * Convenience function to dismiss all toasts
 */
export function dismissAllToasts(): void {
  toastStore.dismissAll();
}
