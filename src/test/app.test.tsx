import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import App from '../App';

// 轻量 DOM 冒烟：jsdom 不实现 ResizeObserver，图表以空容器兜底，其余面板应完整渲染。
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('App 首屏联动', () => {
  beforeEach(() => {
    localStorage.clear();
    (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  });

  it('首屏渲染示例数据：可放行结论、6 支探针排行、漂移与短缺测证据、候选面板', () => {
    const { getByText, getAllByText } = render(<App />);
    expect(getByText('热穿透放行复核台')).toBeTruthy();
    // 示例中 P6 漂移 → 结论悬置
    expect(getByText('结论悬置')).toBeTruthy();
    for (let i = 1; i <= 6; i++) expect(getAllByText(`探针 P${i}`).length).toBeGreaterThan(0);
    // P6 漂移证据存在
    expect(getAllByText(/疑似漂移/).length).toBeGreaterThan(0);
    // P5 短缺测插值留证
    expect(getAllByText(/缺测/).length).toBeGreaterThan(0);
    // 停用候选出现
    expect(getAllByText(/候选：停用 探针 P6/).length).toBe(1);
  });

  it('采用停用候选后结论变为可放行，撤销后回到悬置', () => {
    const { getByText, queryByText } = render(<App />);
    fireEvent.click(getByText('候选：停用 探针 P6'));
    fireEvent.click(getByText('采用该候选（可撤销）'));
    expect(getByText('可放行')).toBeTruthy();
    fireEvent.click(getByText(/^↶ 撤销/));
    expect(getByText('结论悬置')).toBeTruthy();
    expect(queryByText('可放行')).toBeNull();
  });

  it('法规免责声明始终可见', () => {
    const { getByText } = render(<App />);
    expect(getByText(/不替代法规规定的杀菌工艺放行/)).toBeTruthy();
  });

  it('参数面板包含参考温度、z 值、目标 F0 与允许缺测', () => {
    const { getByLabelText } = render(<App />);
    expect(getByLabelText('参考温度 Tref (°C)')).toBeTruthy();
    expect(getByLabelText('z 值 (°C)')).toBeTruthy();
    expect(getByLabelText('目标 F0 (min)')).toBeTruthy();
    expect(getByLabelText('允许缺测 (s)')).toBeTruthy();
  });
});
