import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import type { ChannelDef, ProbeAnalysis, ProcessParams, StageDef } from "../types";
import { interpAt } from "../lib/lethality";
import { tokens, probeColor } from "../theme";
import { fmtTime } from "../format";

interface Props {
  channels: ChannelDef[];
  analyses: ProbeAnalysis[];
  stages: StageDef[];
  windowV: [number, number];
  params: ProcessParams;
  theme: "light" | "dark";
  cursor: number | null;
  onCursor: (t: number | null) => void;
  hidden: Set<string>;
  onToggle: (id: string) => void;
}

const M = { top: 26, right: 52, bottom: 24, left: 46 };
const H_TEMP = 290;
const H_F = 158;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(1000);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

export default function ProcessChart(props: Props) {
  const { channels, analyses, stages, windowV, params, theme, cursor, onCursor, hidden, onToggle } = props;
  const tk = tokens(theme);
  const { ref, w } = useWidth<HTMLDivElement>();
  const innerW = Math.max(320, w - M.left - M.right);
  const [w0, w1] = windowV;
  const x = useCallback((t: number) => M.left + ((t - w0) / (w1 - w0 || 1)) * innerW, [innerW, w0, w1]);
  const invert = useCallback((px: number) => w0 + ((px - M.left) / innerW) * (w1 - w0), [innerW, w0, w1]);

  const probeChs = channels.filter((c) => c.role === "probe");
  const retortCh = channels.find((c) => c.role === "retort");
  const colorOf = (id: string) => {
    const i = probeChs.findIndex((c) => c.id === id);
    return i >= 0 ? probeColor(tk, i) : tk.retort;
  };

  // 温度域
  const tempDomain = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of channels) {
      if (hidden.has(c.id)) continue;
      for (const s of c.samples) {
        if (s.t < w0 - 1 || s.t > w1 + 1) continue;
        if (s.temp < lo) lo = s.temp;
        if (s.temp > hi) hi = s.temp;
      }
    }
    if (!Number.isFinite(lo)) return [0, 130] as const;
    return [Math.floor(lo - 6), Math.ceil(hi + 4)] as const;
  }, [channels, hidden, w0, w1]);
  const yT = (v: number) => M.top + (1 - (v - tempDomain[0]) / (tempDomain[1] - tempDomain[0] || 1)) * (H_TEMP - M.top - M.bottom);

  // F 域
  const fMax = useMemo(() => {
    let m = params.targetF0;
    for (const a of analyses) {
      if (a.role !== "probe" || hidden.has(a.id)) continue;
      for (const n of a.cum) if (n.f !== null && n.f > m) m = n.f;
    }
    return m * 1.12;
  }, [analyses, hidden, params.targetF0]);
  const visibleCount = channels.filter((c) => !hidden.has(c.id)).length;
  const gapTrackH = 12 + visibleCount * 2;
  const fTop = H_TEMP + gapTrackH;
  const yF = (v: number) => fTop + (1 - v / (fMax || 1)) * (H_F - M.bottom - 6);

  // 折线分段（长缺口处断开，绝不连线掩盖）
  const tempSegments = useMemo(() => {
    const out: { id: string; d: string }[] = [];
    for (const c of channels) {
      if (hidden.has(c.id)) continue;
      const inWin = c.samples.filter((s) => s.t >= w0 - 1 && s.t <= w1 + 1);
      if (inWin.length < 2) continue;
      let d = "";
      let pen = false;
      for (let i = 0; i < inWin.length; i++) {
        const s = inWin[i];
        if (i > 0 && s.t - inWin[i - 1].t > params.maxGapSec) {
          d += `M ${x(s.t).toFixed(1)} ${yT(s.temp).toFixed(1)} `;
        } else {
          d += `${pen ? "L" : "M"} ${x(s.t).toFixed(1)} ${yT(s.temp).toFixed(1)} `;
        }
        pen = true;
      }
      out.push({ id: c.id, d });
    }
    return out;
  }, [channels, hidden, x, yT, params.maxGapSec, w0, w1]);

  const cumSegments = useMemo(() => {
    const out: { id: string; d: string }[] = [];
    for (const a of analyses) {
      if (a.role !== "probe" || hidden.has(a.id)) continue;
      let d = "";
      for (let i = 0; i < a.cum.length; i++) {
        const n = a.cum[i];
        if (n.f === null) continue;
        const prev = a.cum[i - 1];
        const broken = prev && prev.f === null;
        d += `${i === 0 || broken ? "M" : "L"} ${x(n.t).toFixed(1)} ${yF(n.f).toFixed(1)} `;
      }
      if (d) out.push({ id: a.id, d });
    }
    return out;
  }, [analyses, hidden, x, yF]);

  const gapRects = useMemo(() => {
    const rows: { y: number; rects: { id: string; x0: number; x1: number; blocking: boolean }[] }[] = [];
    const list = [
      ...(retortCh ? [{ ch: retortCh, an: analyses.find((a) => a.id === retortCh.id) ?? null }] : []),
      ...probeChs.map((ch) => ({ ch, an: analyses.find((a) => a.id === ch.id) ?? null })),
    ].filter((r) => !hidden.has(r.ch.id));
    list.forEach(({ ch, an }, row) => {
      const rects = (an?.gaps ?? []).map((g) => ({
        id: ch.id,
        x0: x(Math.max(g.start, w0)),
        x1: x(Math.min(g.end, w1)),
        blocking: g.blocking,
      }));
      rows.push({ y: H_TEMP + 2 + row * 2, rects });
    });
    return { rows, total: list.length };
  }, [analyses, retortCh, probeChs, hidden, x, w0, w1]);

  const tTicks = useMemo(() => {
    const step = (w1 - w0) / 6;
    const nice = step > 600 ? 600 : step > 240 ? 300 : 120;
    const out: number[] = [];
    for (let t = Math.ceil(w0 / nice) * nice; t <= w1; t += nice) out.push(t);
    return out;
  }, [w0, w1]);
  const yTicksT = ticks(tempDomain[0], tempDomain[1], 6);
  const yTicksF = ticks(0, fMax, 5);

  const cursorDots = useMemo(() => {
    if (cursor === null) return [];
    const out: { id: string; tx: number; ty: number; fy: number | null }[] = [];
    for (const c of channels) {
      if (hidden.has(c.id)) continue;
      const hit = interpAt(c.samples, cursor);
      if (!hit) continue;
      const an = analyses.find((a) => a.id === c.id);
      let fy: number | null = null;
      if (c.role === "probe") {
        // 在 cum 节点上线性取值（null 区间不出点）
        const cum = an?.cum ?? [];
        for (let i = 1; i < cum.length; i++) {
          if (cursor >= cum[i - 1].t && cursor <= cum[i].t) {
            if (cum[i - 1].f === null || cum[i].f === null) break;
            const r = cum[i].t === cum[i - 1].t ? 0 : (cursor - cum[i - 1].t) / (cum[i].t - cum[i - 1].t);
            fy = cum[i - 1].f! + r * (cum[i].f! - cum[i - 1].f!);
            break;
          }
        }
      }
      out.push({ id: c.id, tx: x(cursor), ty: yT(hit.temp), fy: fy === null ? null : yF(fy) });
    }
    return out;
  }, [cursor, channels, analyses, hidden, x, yT, yF]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const t = invert(px);
    onCursor(Math.max(w0, Math.min(w1, t)));
  };

  const totalH = H_TEMP + gapTrackH + H_F + 8;

  return (
    <div ref={ref} className="chart-scroll" style={{ position: "relative" }}>
      <Legend
        channels={channels}
        analyses={analyses}
        colorOf={colorOf}
        hidden={hidden}
        onToggle={onToggle}
      />
      <svg
        width={w}
        height={totalH}
        viewBox={`0 0 ${w} ${totalH}`}
        onPointerMove={onMove}
        onPointerLeave={() => onCursor(null)}
        style={{ display: "block", touchAction: "none" }}
      >
        {/* 阶段带 */}
        {stages.map((s) => (
          <g key={s.id}>
            {s.kind === "holding" && (
              <rect className="stage-band-hold" x={x(s.start)} y={M.top - 14} width={x(s.end) - x(s.start)} height={H_TEMP - M.top - M.bottom + H_F - 10} />
            )}
            <line className="stage-band-edge" x1={x(s.start)} y1={M.top - 14} x2={x(s.start)} y2={fTop + H_F - M.bottom} />
            <text className="stage-name" x={(x(s.start) + x(s.end)) / 2} y={M.top - 18}>{s.name}</text>
          </g>
        ))}

        {/* 温度面板网格与轴 */}
        {yTicksT.map((v) => (
          <g key={`yt${v}`}>
            <line className="gridline" x1={M.left} x2={w - M.right} y1={yT(v)} y2={yT(v)} />
            <text className="axis-label" x={M.left - 6} y={yT(v) + 3} textAnchor="end">{v}</text>
          </g>
        ))}
        <text className="axis-label" x={12} y={M.top - 12}>℃</text>
        <line className="target-line" x1={M.left} x2={w - M.right} y1={yT(params.refTemp)} y2={yT(params.refTemp)} />
        <text className="axis-label" x={w - M.right + 4} y={yT(params.refTemp) + 3} fill={tk.good}>Tref {params.refTemp}</text>

        {/* 温度线 */}
        {tempSegments.map((seg) => (
          <path
            key={seg.id}
            d={seg.d}
            fill="none"
            stroke={colorOf(seg.id)}
            strokeWidth={retortCh?.id === seg.id ? 2.4 : 1.8}
            strokeDasharray={retortCh?.id === seg.id ? "6 4" : undefined}
            opacity={retortCh?.id === seg.id ? 0.9 : 0.95}
          />
        ))}

        {/* 缺测轨道 */}
        <line className="axisline" x1={M.left} x2={w - M.right} y1={H_TEMP + gapTrackH} y2={H_TEMP + gapTrackH} />
        <text className="axis-label" x={12} y={H_TEMP + 10}>缺测</text>
        {gapRects.rows.flatMap((row) =>
          row.rects.map((r, i) => (
            <rect
              key={`${r.id}-${i}`}
              x={r.x0}
              y={row.y}
              width={Math.max(2, r.x1 - r.x0)}
              height={1.6}
              fill={r.blocking ? tk.critical : tk.warning}
              opacity={0.9}
            />
          )),
        )}

        {/* F 面板 */}
        {yTicksF.map((v) => (
          <g key={`yf${v}`}>
            <line className="gridline" x1={M.left} x2={w - M.right} y1={yF(v)} y2={yF(v)} />
            <text className="axis-label" x={M.left - 6} y={yF(v) + 3} textAnchor="end">{v}</text>
          </g>
        ))}
        <text className="axis-label" x={10} y={fTop + 2}>F0</text>
        <line className="target-line" x1={M.left} x2={w - M.right} y1={yF(params.targetF0)} y2={yF(params.targetF0)} />
        <text className="axis-label" x={w - M.right + 4} y={yF(params.targetF0) + 3} fill={tk.good}>目标 {params.targetF0}</text>
        {cumSegments.map((seg) => (
          <path key={seg.id} d={seg.d} fill="none" stroke={colorOf(seg.id)} strokeWidth={1.8} />
        ))}

        {/* X 轴 */}
        <line className="axisline" x1={M.left} x2={w - M.right} y1={fTop + H_F - M.bottom} y2={fTop + H_F - M.bottom} />
        {tTicks.map((t) => (
          <g key={`xt${t}`}>
            <line className="gridline" x1={x(t)} x2={x(t)} y1={fTop + H_F - M.bottom} y2={fTop + H_F - M.bottom + 4} />
            <text className="axis-label" x={x(t)} y={fTop + H_F - M.bottom + 15} textAnchor="middle">{fmtTime(t)}</text>
          </g>
        ))}

        {/* 游标 */}
        {cursor !== null && (
          <g>
            <line className="crosshair" x1={x(cursor)} x2={x(cursor)} y1={M.top - 14} y2={fTop + H_F - M.bottom} />
            {cursorDots.map((d) => (
              <g key={d.id}>
                <circle cx={d.tx} cy={d.ty} r={3.4} fill={tk.surface} stroke={colorOf(d.id)} strokeWidth={2} />
                {d.fy !== null && <circle cx={d.tx} cy={d.fy} r={3.2} fill={colorOf(d.id)} />}
              </g>
            ))}
          </g>
        )}
      </svg>
      {cursor !== null && (
        <div
          style={{
            position: "absolute",
            left: Math.min(w - 120, Math.max(M.left, x(cursor) + 10)),
            top: 4,
            background: tk.surface,
            border: `1px solid ${tk.axis}`,
            borderRadius: 6,
            padding: "2px 8px",
            fontSize: 11,
            color: tk.ink,
            pointerEvents: "none",
          }}
        >
          {fmtTime(cursor)}
        </div>
      )}
    </div>
  );
}

function Legend(props: {
  channels: ChannelDef[];
  analyses: ProbeAnalysis[];
  colorOf: (id: string) => string;
  hidden: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { channels, analyses, colorOf, hidden, onToggle } = props;
  const retort = channels.find((c) => c.role === "retort");
  const probes = channels.filter((c) => c.role === "probe");
  const item = (c: ChannelDef, dashed: boolean) => {
    const an = analyses.find((a) => a.id === c.id);
    return (
      <span key={c.id} className={`item${hidden.has(c.id) ? " off" : ""}`} onClick={() => onToggle(c.id)}>
        <span className={dashed ? "swatch dashed" : "swatch"} style={dashed ? undefined : { background: colorOf(c.id) }} />
        {c.name}
        {an && !an.valid && c.role === "probe" && <span className="sev block" style={{ fontSize: 9, padding: "0 4px" }}>阻断</span>}
        {an?.valid === false && c.role === "retort" && <span className="sev block" style={{ fontSize: 9, padding: "0 4px" }}>阻断</span>}
        {an?.defects.some((d) => d.severity === "warn") && <span className="sev warn" style={{ fontSize: 9, padding: "0 4px" }}>警告</span>}
      </span>
    );
  };
  return (
    <div className="legend">
      {retort && item(retort, true)}
      {probes.map((c) => item(c, false))}
    </div>
  );
}

function ticks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Number(v.toFixed(4)));
  return out;
}

