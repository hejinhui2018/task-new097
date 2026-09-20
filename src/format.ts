/** 秒 → m:ss（或 h:mm:ss）；输入框用 mm:ss */
export function fmtTime(t: number): string {
  const neg = t < 0;
  const s = Math.round(Math.abs(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const body = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

export function fmtClockInput(t: number): string {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function parseClockInput(v: string): number | null {
  const m = v.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
  if (!m) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const [, h, mm, ss] = m;
  const mins = Number(h ?? 0) * 60 + Number(mm);
  const secs = Number(ss);
  if (secs >= 60) return null;
  return mins * 60 + secs;
}

export function fmtF(x: number | null | undefined, digits = 2): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(digits);
}

export function fmtTemp(x: number | null | undefined): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(1);
}
