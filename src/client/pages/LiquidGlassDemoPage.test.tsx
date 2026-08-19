// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LiquidGlassDemoPage } from './LiquidGlassDemoPage.js';

describe('LiquidGlassDemoPage', () => {
  let putImageData: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    putImageData = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData,
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the isolated Liquid Glass lyric treatment without backend data', () => {
    vi.useFakeTimers();
    const request = vi.spyOn(globalThis, 'fetch');
    const { container } = render(
      <MemoryRouter initialEntries={['/liquid-glass-demo']}>
        <LiquidGlassDemoPage />
      </MemoryRouter>,
    );
    act(() => vi.runAllTimers());

    expect(screen.getByText('玻璃把远处的光折进此刻')).toBeInTheDocument();
    expect(screen.getByText('The city bends into the glow')).toBeInTheDocument();
    expect(container.querySelector('.lg-demo--glass')).not.toBeNull();
    expect(container.querySelector('.ambient-demo--spatial')).toHaveAttribute('data-field-id', 'afterglow');
    expect(container.querySelector('[data-renderer="spatial-canvas"]')).not.toBeNull();
    expect(container.querySelector('.lg-glass-surface')).toBeNull();
    expect(screen.getByRole('status')).toHaveAttribute('class', 'am-connection');
    expect(screen.getByRole('link', { name: '打开歌词设置' })).toHaveAttribute('class', 'am-round-button');
    expect(container.querySelector('.am-lyrics-rail')).toHaveAttribute('data-running', 'false');
    expect(container.querySelector('.lg-demo--glass')).toHaveAttribute('data-preview-motion', 'true');
    expect(container.querySelector('.am-lyric-line[data-state="active"]')).toHaveTextContent('玻璃把远处的光折进此刻');

    const mixedLine = container.querySelector('.am-lyric-line[data-script="mixed"]');
    const mixedRuns = [...(mixedLine?.querySelectorAll('.am-lyric-script') ?? [])];
    expect(mixedRuns).toHaveLength(3);
    expect(mixedRuns.map((run) => run.textContent).join('')).toBe('霓虹与 the glow 同步呼吸。');
    const activeSurface = container.querySelector('.spatial-field-surface.is-active');
    const canvases = activeSurface?.querySelectorAll('canvas') ?? [];
    expect(canvases).toHaveLength(3);
    expect([...canvases].every((canvas) => canvas.width === 192 && canvas.height === 108)).toBe(true);
    expect(putImageData).toHaveBeenCalledTimes(6);
    const renderedImage = putImageData.mock.calls[0]?.[0] as ImageData | undefined;
    expect(renderedImage && [...renderedImage.data].some((value, index) => index % 4 !== 3 && value > 0))
      .toBe(true);
    expect(screen.getByRole('button', { name: '空间色场' })).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.ambient-demo-controls')).not.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('can render the current treatment for comparison', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/liquid-glass-demo?style=current']}>
        <LiquidGlassDemoPage />
      </MemoryRouter>,
    );

    expect(container.querySelector('.lg-demo--current')).not.toBeNull();
    expect(container.querySelector('.lg-demo--current')).not.toHaveAttribute('data-preview-motion');
    expect(screen.getByRole('link', { name: '打开歌词设置' })).toHaveAttribute('href', '/setup');
  });

  it('keeps the previous radial background available for direct comparison', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/liquid-glass-demo?background=current&field=glacier']}>
        <LiquidGlassDemoPage />
      </MemoryRouter>,
    );

    expect(container.querySelector('.ambient-demo--current')).toHaveAttribute('data-field-id', 'glacier');
    expect(container.querySelector('[data-renderer="spatial-canvas"]')).toBeNull();
    expect(container.querySelector('.ambient-palette-layer')).not.toBeNull();
    expect(screen.getByRole('button', { name: '当前背景' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches album fields without requesting backend data', () => {
    const request = vi.spyOn(globalThis, 'fetch');
    const { container } = render(
      <MemoryRouter initialEntries={['/liquid-glass-demo']}>
        <LiquidGlassDemoPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: '切换到青蓝色场' }));

    expect(container.querySelector('.ambient-demo')).toHaveAttribute('data-field-id', 'glacier');
    expect(screen.getByRole('button', { name: '切换到青蓝色场' })).toHaveAttribute('aria-pressed', 'true');
    expect(request).not.toHaveBeenCalled();
  });
});
