import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import type { Analysis, ChannelResult } from '../types';
import { fmtClockShort, tempPolyline, cumulativePolyline, fmtF, fmtRate, cursorRows } from '../lib/render';
import type { CursorRow } from '../lib/render';

const MARGIN = { top: 14, right: 16, bottom: 26, left: 44 };
const TEMP_H = 270;
const F_H = 210;
const SAMPLE_POINTS = 460;

function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      setW(entries[0].contentRect.width);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(Math.round(v / step) * step);
  return out;
}

export interface ChartProps {
  analysis: Analysis;
  refTemp: number;
  zValue: number;
  targetF0: number;
  hidden: Set<string>;
  selectedId: string | null;
  cursorT: number | null;
  onCursor: (t: number | null) => void;
}

export function ProcessChart({
  analysis,
  refTemp,
  zValue,
  targetF0,
  hidden,
  selectedId,
  cursorT,
  onCursor,
}: ChartProps) {
  const { ref, w } = useMeasure<HTMLDivElement>();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; rows: CursorRow[]; t: number } | null>(null);

  const { windowStart: t0, windowEnd: t1, holdStart, holdEnd } = analysis;
  const visible = analysis.channels.filter((c) => !hidden.has(c.id));

  const geo = useMemo(() => {
    if (w <= 0) return null;
    const innerW = w - MARGIN.left - MARGIN.right;
    const x = (t: number) => MARGIN.left + ((t - t0) / Math.max(1, t1 - t0)) * innerW;
    const tAtPx = (px: number) => t0 + ((px - MARGIN.left) / innerW) * (t1 - t0);

    let tmin = Infinity;
    let tmax = -Infinity;
    let fmax = 0;
    for (const ch of visible) {
      for (const s of ch.segments) {
        if (s.T1 < tmin) tmin = s.T1;
        if (s.T2 < tmin) tmin = s.T2;
        if (s.T1 > tmax) tmax = s.T1;
        if (s.T2 > tmax) tmax = s.T2;
      }
      if (ch.totalF > fmax) fmax = ch.totalF;
    }
    if (!Number.isFinite(tmin)) {
      tmin = 0;
      tmax = 130;
    }
    tmin = Math.floor(tmin / 10) * 10;
    tmax = Math.ceil((tmax + 2) / 10) * 10;
    fmax = Math.max(fmax * 1.08, targetF0 * 1.1, 1);

    const innerTempH = TEMP_H - MARGIN.top - MARGIN.bottom;
    const innerFH = F_H - 10 - MARGIN.bottom;
    const yT = (v: number) => MARGIN.top + (1 - (v - tmin) / (tmax - tmin)) * innerTempH;
    const yF = (v: number) => 10 + (1 - Math.min(1, v / fmax)) * innerFH;
    return { x, tAtPx, yT, yF, tmin, tmax, fmax, innerW };
  }, [w, visible, t0, t1, targetF0]);

  const polys = useMemo(() => {
    if (!geo) return null;
    return analysis.channels.map((ch) => ({
      id: ch.id,
      temp: tempPolyline(ch, t0, t1, SAMPLE_POINTS).points,
      cum: cumulativePolyline(ch, t0, t1, SAMPLE_POINTS, refTemp, zValue).points,
    }));
  }, [geo, analysis.channels, t0, t1, refTemp, zValue]);

  const xTicks = useMemo(() => {
    if (!geo) return [];
    const count = Math.max(4, Math.floor(geo.innerW / 110));
    return niceTicks(t0, t1, count);
  }, [geo, t0, t1]);

  const rowsAt = useCallback(
    (t: number): CursorRow[] => cursorRows(visible, t, refTemp, zValue),
    [visible, refTemp, zValue],
  );

  if (w <= 0 || !geo || !polys) {
    return <div ref={ref} style={{ height: TEMP_H + F_H }} />;
  }

  const colorOf = (ch: ChannelResult) =>
    ch.kind === 'retort' ? 'var(--retort)' : `var(--series-${probeIndex(ch.id)})`;
  const probeIndex = (id: string) => {
    const i = analysis.channels.filter((c) => c.kind === 'probe').findIndex((c) => c.id === id);
    return Math.max(1, (i % 6) + 1);
  };

  const pathFor = (pts: ({ x: number; y: number } | null)[], yScale: (v: number) => number) => {
    let d = '';
    let pen = false;
    for (const p of pts) {
      if (p === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${geo.x(p.x).toFixed(1)},${yScale(p.y).toFixed(1)} `;
      pen = true;
    }
    return d;
  };

  const gapRects = () => {
    const rects: { x: number; w: number; ch: ChannelResult }[] = [];
    for (const ch of analysis.channels) {
      if (hidden.has(ch.id)) continue;
      for (const g of ch.longGaps) {
        const x1 = geo.x(Math.max(g.from, t0));
        const x2 = geo.x(Math.min(g.to, t1));
        if (x2 > x1) rects.push({ x: x1, w: x2 - x1, ch });
      }
    }
    return rects;
  };

  const handleMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = Math.min(t1, Math.max(t0, geo.tAtPx(px)));
    onCursor(t);
    const wrap = wrapRef.current;
    const localX = e.clientX - (wrap?.getBoundingClientRect().left ?? 0);
    const localY = e.clientY - (wrap?.getBoundingClientRect().top ?? 0);
    setTip({ x: localX, y: localY, rows: rowsAt(t), t });
  };

  const cursorRowsNow = cursorT !== null ? rowsAt(cursorT) : [];
  const phaseLabels = [
    { a: t0, b: holdStart ?? t0 + (t1 - t0) / 3, label: '升温' },
    { a: holdStart, b: holdEnd, label: '保温' },
    { a: holdEnd, b: t1, label: '降温' },
  ].filter((p) => p.a !== null && p.b !== null && p.b! - p.a! > 60_000) as {
    a: number;
    b: number;
    label: string;
  }[];

  const tTicks = niceTicks(geo.tmin, geo.tmax, 6);
  const fTicks = niceTicks(0, geo.fmax, 4);

  const renderSeries = (panel: 'temp' | 'f') =>
    analysis.channels.map((ch) => {
      if (hidden.has(ch.id)) return null;
      const p = polys.find((x) => x.id === ch.id)!;
      const pts = panel === 'temp' ? p.temp : p.cum;
      const yScaleRaw = panel === 'temp' ? geo.yT : geo.yF;
      const yScale = panel === 'temp' ? yScaleRaw : (v: number) => yScaleRaw(v) + TEMP_H;
      const isSel = selectedId === ch.id;
      const dim = selectedId !== null && !isSel;
      return (
        <path
          key={ch.id}
          d={pathFor(pts, yScale)}
          fill="none"
          stroke={colorOf(ch)}
          strokeWidth={ch.kind === 'retort' ? 1.6 : isSel ? 3 : 2}
          strokeDasharray={ch.kind === 'retort' ? '6 4' : undefined}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={dim ? 0.25 : ch.disabled ? 0.4 : 1}
        />
      );
    });

  const cursorX = cursorT !== null ? geo.x(cursorT) : null;

  const tooltip = tip && (
    <div
      className="chart-tooltip"
      style={{
        left: tip.x > w * 0.62 ? undefined : tip.x + 14,
        right: tip.x > w * 0.62 ? w - tip.x + 14 : undefined,
        top: Math.min(tip.y + 12, TEMP_H + F_H - 40),
      }}
    >
      <div className="tt-time">{fmtClockShort(tip.t)}</div>
      {tip.rows.map((r) => (
        <div className="tt-row" key={r.id} style={{ opacity: r.disabled ? 0.45 : 1 }}>
          <span className="tt-key" style={{ borderColor: colorOf(analysis.channels.find((c) => c.id === r.id)!) }} />
          <span className="tt-name">{r.name}</span>
          <span className="tt-val">
            {r.temp === null ? '缺测' : `${r.temp.toFixed(1)}°C · L ${fmtRate(r.rate)} · F ${fmtF(r.cumulative)}`}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div ref={ref}>
        <svg
          className="chart-svg"
          width={w}
          height={TEMP_H + F_H + 18}
          role="img"
          aria-label="过程温度曲线与累计 F0 曲线，移动指针查看各通道瞬时致死率与累计贡献"
        >
          <defs>
            <pattern id="gap-hatch" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
              <rect width="7" height="7" fill="var(--gap-wash)" />
              <line x1="0" y1="0" x2="0" y2="7" stroke="var(--critical)" strokeWidth="1.4" opacity="0.5" />
            </pattern>
          </defs>

          {/* 阶段带与标签（温度面板） */}
          {holdStart !== null && holdEnd !== null && (
            <>
              <rect x={geo.x(holdStart)} y={MARGIN.top} width={geo.x(holdEnd) - geo.x(holdStart)} height={TEMP_H - MARGIN.top - MARGIN.bottom + F_H - 10} fill="var(--hold-wash)" />
              {phaseLabels.map((p) => (
                <text key={p.label} x={(geo.x(p.a) + geo.x(p.b)) / 2} y={MARGIN.top - 2} textAnchor="middle" fontSize="10.5" fill="var(--muted)">
                  {p.label}
                </text>
              ))}
              <line x1={geo.x(holdStart)} y1={MARGIN.top} x2={geo.x(holdStart)} y2={TEMP_H - MARGIN.bottom} stroke="var(--axis)" strokeWidth="1" />
              <line x1={geo.x(holdEnd)} y1={MARGIN.top} x2={geo.x(holdEnd)} y2={TEMP_H + F_H - MARGIN.bottom - 8} stroke="var(--axis)" strokeWidth="1" />
            </>
          )}

          {/* 温度面板网格与坐标 */}
          {tTicks.map((v) => (
            <g key={`tg${v}`}>
              <line x1={MARGIN.left} y1={geo.yT(v)} x2={w - MARGIN.right} y2={geo.yT(v)} stroke="var(--grid)" strokeWidth="1" />
              <text x={MARGIN.left - 6} y={geo.yT(v) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--muted)">
                {v}
              </text>
            </g>
          ))}
          <text x={MARGIN.left - 32} y={MARGIN.top - 2} fontSize="10.5" fill="var(--muted)">°C</text>

          {/* 长缺口纹理（温度面板，不连线、不补零的可视证据） */}
          {gapRects().map((r, i) => (
            <rect key={`gap${i}`} x={r.x} y={MARGIN.top} width={r.w} height={TEMP_H - MARGIN.top - MARGIN.bottom} fill="url(#gap-hatch)" opacity={0.8} />
          ))}

          {renderSeries('temp')}

          {/* F0 面板分隔与坐标 */}
          <line x1={MARGIN.left} y1={TEMP_H} x2={w - MARGIN.right} y2={TEMP_H} stroke="var(--axis)" strokeWidth="1" />
          {fTicks.map((v) => (
            <g key={`fg${v}`}>
              <line x1={MARGIN.left} y1={geo.yF(v) + TEMP_H} x2={w - MARGIN.right} y2={geo.yF(v) + TEMP_H} stroke="var(--grid)" strokeWidth="1" />
              <text x={MARGIN.left - 6} y={geo.yF(v) + TEMP_H + 3.5} textAnchor="end" fontSize="10.5" fill="var(--muted)">
                {v}
              </text>
            </g>
          ))}
          <text x={MARGIN.left - 30} y={TEMP_H + 8} fontSize="10.5" fill="var(--muted)">F0</text>
          {/* 目标 F0 线 */}
          <line
            x1={MARGIN.left}
            y1={geo.yF(targetF0) + TEMP_H}
            x2={w - MARGIN.right}
            y2={geo.yF(targetF0) + TEMP_H}
            stroke="var(--good)"
            strokeWidth="1.4"
            strokeDasharray="4 3"
          />
          <text x={w - MARGIN.right - 4} y={geo.yF(targetF0) + TEMP_H - 3} textAnchor="end" fontSize="10.5" fill="var(--good-text)">
            目标 {targetF0}
          </text>

          {renderSeries('f')}

          {/* X 轴时间刻度 */}
          {xTicks.map((t) => (
            <g key={`x${t}`}>
              <line x1={geo.x(t)} y1={TEMP_H + F_H - MARGIN.bottom - 8} x2={geo.x(t)} y2={TEMP_H + F_H - MARGIN.bottom - 3} stroke="var(--muted)" strokeWidth="1" />
              <text x={geo.x(t)} y={TEMP_H + F_H + 2} textAnchor="middle" fontSize="10.5" fill="var(--muted)">
                {fmtClockShort(t)}
              </text>
            </g>
          ))}

          {/* 十字游标 */}
          {cursorX !== null && (
            <line x1={cursorX} y1={MARGIN.top} x2={cursorX} y2={TEMP_H + F_H - MARGIN.bottom - 8} stroke="var(--ink-2)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" pointerEvents="none" />
          )}

          {/* 交互层（两个面板各一个透明命中区） */}
          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={w - MARGIN.left - MARGIN.right}
            height={TEMP_H + F_H - MARGIN.top - MARGIN.bottom}
            fill="transparent"
            onPointerMove={handleMove}
            onPointerLeave={() => {
              setTip(null);
              onCursor(null);
            }}
          />
        </svg>
      </div>
      {tooltip}
      {cursorRowsNow.length > 0 && cursorT !== null && (
        <div className="hint" style={{ marginTop: 2 }}>
          游标 {fmtClockShort(cursorT)}：在下游“游标瞬时读数”表中查看各通道瞬时致死率 L 与累计 F0
        </div>
      )}
    </div>
  );
}
