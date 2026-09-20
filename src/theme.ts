/** 与 index.css 保持一致的十六进制令牌（SVG 无法直接用 CSS 变量做描边时用） */
export interface Tokens {
  series: string[];
  retort: string;
  grid: string;
  axis: string;
  muted: string;
  ink: string;
  surface: string;
  good: string;
  warning: string;
  critical: string;
}

export const LIGHT: Tokens = {
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"],
  retort: "#3a3a38",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  muted: "#898781",
  ink: "#0b0b0b",
  surface: "#fcfcfb",
  good: "#0ca30c",
  warning: "#b07800",
  critical: "#d03b3b",
};

export const DARK: Tokens = {
  series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#35a835"],
  retort: "#d8d7cf",
  grid: "#2c2c2a",
  axis: "#383835",
  muted: "#8f8d86",
  ink: "#ffffff",
  surface: "#1a1a19",
  good: "#35c735",
  warning: "#f4c24a",
  critical: "#e66767",
};

export function tokens(theme: "light" | "dark"): Tokens {
  return theme === "dark" ? DARK : LIGHT;
}

export function probeColor(t: Tokens, index: number): string {
  return t.series[index % t.series.length];
}
