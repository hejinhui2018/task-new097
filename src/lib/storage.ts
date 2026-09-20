import type { AppState, Snapshot } from './state';

const STORAGE_KEY = 'hpr-review-state-v1';

export interface PersistedState {
  dataset: AppState['dataset'];
  settings: AppState['settings'];
  adjustments: AppState['adjustments'];
  past: Snapshot[];
  future: Snapshot[];
  savedAt: number;
}

/** 本地保存（localStorage 不可用时静默降级为仅内存会话） */
export function persistState(state: AppState): boolean {
  try {
    const payload: PersistedState = {
      dataset: state.dataset,
      settings: state.settings,
      adjustments: state.adjustments,
      past: state.past,
      future: state.future,
      savedAt: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function loadPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed.dataset?.channels || !parsed.settings) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPersisted(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}
