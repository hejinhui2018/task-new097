/** 简单的撤销/重做栈（纯函数式，与 UI 无关） */
export interface History<T> {
  present: T;
  past: { label: string; value: T }[];
  future: { label: string; value: T }[];
}

export function initHistory<T>(present: T): History<T> {
  return { present, past: [], future: [] };
}

export function pushState<T>(h: History<T>, next: T, label: string): History<T> {
  return { present: next, past: [...h.past, { label, value: h.present }].slice(-100), future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  const last = h.past[h.past.length - 1];
  if (!last) return h;
  return {
    present: last.value,
    past: h.past.slice(0, -1),
    future: [{ label: last.label, value: h.present }, ...h.future].slice(0, 100),
  };
}

export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0];
  if (!next) return h;
  return {
    present: next.value,
    past: [...h.past, { label: next.label, value: h.present }].slice(-100),
    future: h.future.slice(1),
  };
}
