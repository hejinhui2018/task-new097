import type { Adjustments, Dataset, Settings } from '../types';
import type { PersistedState } from './storage';

export interface Snapshot {
  dataset: Dataset;
  settings: Settings;
  adjustments: Adjustments;
  label: string;
}

export interface AppState {
  dataset: Dataset;
  settings: Settings;
  adjustments: Adjustments;
  past: Snapshot[];
  future: Snapshot[];
  /** 最近一次提交说明（用于提示） */
  lastLabel: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  refTemp: 121.1,
  zValue: 10,
  targetF0: 6,
  maxGapSeconds: 60,
  holdTemp: 120,
  holdStart: null,
  holdEnd: null,
  driftC: 1.5,
};

export const EMPTY_ADJUSTMENTS: Adjustments = { offsets: {}, disabled: {} };

const HISTORY_LIMIT = 50;

export type Action =
  | { type: 'commit'; label: string; patch: Partial<Pick<AppState, 'dataset' | 'settings' | 'adjustments'>> }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'hydrate'; state: PersistedState };

export function initState(dataset: Dataset, settings: Settings = DEFAULT_SETTINGS): AppState {
  return {
    dataset,
    settings,
    adjustments: { ...EMPTY_ADJUSTMENTS },
    past: [],
    future: [],
    lastLabel: null,
  };
}

function snapshot(s: AppState, label: string): Snapshot {
  return { dataset: s.dataset, settings: s.settings, adjustments: s.adjustments, label };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'commit': {
      const prev = snapshot(state, action.label);
      const next: AppState = {
        ...state,
        dataset: action.patch.dataset ?? state.dataset,
        settings: action.patch.settings ?? state.settings,
        adjustments: action.patch.adjustments ?? state.adjustments,
        past: [...state.past, prev].slice(-HISTORY_LIMIT),
        future: [],
        lastLabel: action.label,
      };
      return next;
    }
    case 'undo': {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      const current = snapshot(state, prev.label);
      return {
        ...state,
        dataset: prev.dataset,
        settings: prev.settings,
        adjustments: prev.adjustments,
        past: state.past.slice(0, -1),
        future: [current, ...state.future].slice(0, HISTORY_LIMIT),
        lastLabel: `撤销：${prev.label}`,
      };
    }
    case 'redo': {
      if (state.future.length === 0) return state;
      const nxt = state.future[0];
      const current = snapshot(state, nxt.label);
      return {
        ...state,
        dataset: nxt.dataset,
        settings: nxt.settings,
        adjustments: nxt.adjustments,
        past: [...state.past, current].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        lastLabel: `重做：${nxt.label}`,
      };
    }
    case 'hydrate': {
      const p = action.state;
      return {
        dataset: p.dataset,
        settings: { ...DEFAULT_SETTINGS, ...p.settings },
        adjustments: p.adjustments ?? { ...EMPTY_ADJUSTMENTS },
        past: (p.past ?? []).slice(-HISTORY_LIMIT),
        future: (p.future ?? []).slice(0, HISTORY_LIMIT),
        lastLabel: '已从本地恢复上次会话',
      };
    }
  }
}
