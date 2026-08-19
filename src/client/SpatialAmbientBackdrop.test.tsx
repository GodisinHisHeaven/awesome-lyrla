// @vitest-environment jsdom

import { act, fireEvent, render } from '@testing-library/react';
import {
  SPATIAL_CROSSFADE_MS,
  SpatialAmbientBackdrop,
} from './SpatialAmbientBackdrop.js';
import {
  SPATIAL_FIELD_CANVAS_HEIGHT,
  SPATIAL_FIELD_CANVAS_WIDTH,
  type SpatialColorField,
} from './spatial-field.js';
import type {
  SpatialTextureWorkerRequest,
  SpatialTextureWorkerResponse,
} from './spatial-texture-worker.js';

const firstField: SpatialColorField = {
  id: 'first',
  columns: 2,
  rows: 2,
  colors: ['#704A3C', '#59485E', '#33495C', '#202834'],
  base: '#20232D',
};

const secondField: SpatialColorField = {
  id: 'second',
  columns: 2,
  rows: 2,
  colors: ['#83C2D1', '#6FAFC1', '#477B8E', '#234B5B'],
  base: '#315F70',
};

const thirdField: SpatialColorField = {
  id: 'third',
  columns: 2,
  rows: 2,
  colors: ['#A06361', '#7A4D65', '#315872', '#3D343C'],
  base: '#2A2635',
};

type BrowserMocks = {
  query: {
    matches: boolean;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };
  requestFrame: ReturnType<typeof vi.spyOn>;
  runNextFrame: () => void;
};

function installBrowserMocks(reducedMotion = false): BrowserMocks {
  const query = {
    matches: reducedMotion,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => query,
  });
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    value: undefined,
  });
  vi.stubGlobal('Worker', undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    }),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);

  let nextFrameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const frameId = ++nextFrameId;
    frames.set(frameId, callback);
    return frameId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
    frames.delete(frameId);
  });

  return {
    query,
    requestFrame,
    runNextFrame: () => {
      const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!entry) throw new Error('Expected a pending animation frame');
      frames.delete(entry[0]);
      act(() => entry[1](performance.now()));
    },
  };
}

function flushTexturePreparation(): void {
  for (let pass = 0; pass < 4; pass += 1) {
    act(() => vi.runOnlyPendingTimers());
  }
}

function revealPreparedTransition(browser: BrowserMocks): void {
  flushTexturePreparation();
  browser.runNextFrame();
  browser.runNextFrame();
}

function transitionSurface(container: HTMLElement): HTMLElement {
  const surface = container.querySelector<HTMLElement>('.spatial-field-surface.is-transitioning');
  if (!surface) throw new Error('Expected a transitioning spatial field');
  return surface;
}

describe('SpatialAmbientBackdrop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reveals only after all three canvases are painted and a browser paint opportunity', () => {
    const browser = installBrowserMocks();
    const { container, rerender } = render(<SpatialAmbientBackdrop field={firstField} />);
    flushTexturePreparation();

    expect(container.querySelector('[data-renderer="spatial-canvas"]'))
      .toHaveAttribute('data-composite-state', 'steady');
    expect(container.querySelector('[data-renderer="spatial-canvas"]'))
      .toHaveStyle(`--spatial-crossfade-duration: ${SPATIAL_CROSSFADE_MS}ms`);
    expect(container.querySelector('.spatial-field-surface.is-active'))
      .toHaveAttribute('data-composite-role', 'active');
    expect(container.querySelector('.spatial-field-surface[data-state="inactive"]'))
      .toHaveAttribute('data-composite-role', 'standby');

    rerender(<SpatialAmbientBackdrop field={secondField} />);
    const incoming = transitionSurface(container);
    expect(incoming).toHaveAttribute('data-texture-state', 'preparing');
    expect(incoming).not.toHaveClass('is-visible');
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('first');

    flushTexturePreparation();
    expect(incoming).toHaveAttribute('data-texture-state', 'ready');
    expect(incoming).not.toHaveClass('is-visible');
    expect(browser.requestFrame).toHaveBeenCalledTimes(1);

    browser.runNextFrame();
    expect(incoming).not.toHaveClass('is-visible');
    browser.runNextFrame();

    expect(incoming).toHaveClass('is-visible');
    expect(container.querySelector('[data-renderer="spatial-canvas"]'))
      .toHaveAttribute('data-composite-state', 'crossfading');
    expect(container.querySelector('.spatial-field-surface.is-active')).toHaveAttribute('data-motion', 'paused');
    expect(incoming).toHaveAttribute('data-motion', 'running');
  });

  it('uses opacity transitionend as the primary completion signal', () => {
    const browser = installBrowserMocks();
    const { container, rerender } = render(<SpatialAmbientBackdrop field={firstField} />);
    flushTexturePreparation();

    rerender(<SpatialAmbientBackdrop field={secondField} />);
    revealPreparedTransition(browser);
    const incoming = transitionSurface(container);

    act(() => vi.advanceTimersByTime(SPATIAL_CROSSFADE_MS));
    expect(transitionSurface(container)).toBe(incoming);

    fireEvent.transitionEnd(incoming, { propertyName: 'transform' });
    expect(transitionSurface(container)).toBe(incoming);
    fireEvent.transitionEnd(incoming, { propertyName: 'opacity' });

    expect(container.querySelector('.spatial-field-surface.is-transitioning')).toBeNull();
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('second');
    expect(container.querySelector('[data-renderer="spatial-canvas"]'))
      .toHaveAttribute('data-composite-state', 'steady');
  });

  it('falls back to a safety timeout when transitionend is lost', () => {
    const browser = installBrowserMocks();
    const field = { ...secondField, id: 'safety-timeout' };
    const { container, rerender } = render(<SpatialAmbientBackdrop field={firstField} />);
    flushTexturePreparation();

    rerender(<SpatialAmbientBackdrop field={field} />);
    revealPreparedTransition(browser);

    act(() => vi.advanceTimersByTime(SPATIAL_CROSSFADE_MS + 699));
    expect(container.querySelector('.spatial-field-surface.is-transitioning')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector('.spatial-field-surface.is-transitioning')).toBeNull();
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('safety-timeout');
  });

  it('promotes a prepared field without animation frames in reduced motion', () => {
    const browser = installBrowserMocks(true);
    const field = { ...secondField, id: 'reduced' };
    const { container, rerender } = render(<SpatialAmbientBackdrop field={firstField} />);
    flushTexturePreparation();

    rerender(<SpatialAmbientBackdrop field={field} />);
    flushTexturePreparation();
    expect(container.querySelector('[data-renderer="spatial-canvas"]')).toHaveAttribute('data-motion', 'reduced');
    expect(container.querySelectorAll('.spatial-field-surface[data-motion="reduced"]')).toHaveLength(2);
    expect(browser.requestFrame).not.toHaveBeenCalled();
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('reduced');
  });

  it('finishes an active crossfade when reduced motion is enabled mid-transition', () => {
    const browser = installBrowserMocks();
    const field = { ...secondField, id: 'reduced-mid-transition' };
    const { container, rerender } = render(<SpatialAmbientBackdrop field={firstField} />);
    flushTexturePreparation();

    rerender(<SpatialAmbientBackdrop field={field} />);
    revealPreparedTransition(browser);
    expect(transitionSurface(container)).toHaveClass('is-visible');

    const listener = browser.query.addEventListener.mock.calls[0]?.[1] as (() => void) | undefined;
    act(() => {
      browser.query.matches = true;
      listener?.();
    });

    expect(container.querySelector('[data-renderer="spatial-canvas"]'))
      .toHaveAttribute('data-motion', 'reduced');
    expect(container.querySelector('.spatial-field-surface.is-transitioning')).toBeNull();
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('reduced-mid-transition');
  });

  it('interrupts a temporary incoming scene and reuses its mounted composite layer', () => {
    const browser = installBrowserMocks();
    const second = { ...secondField, id: 'temporary-second' };
    const third = { ...thirdField, id: 'latest-third' };
    const { container, rerender } = render(<SpatialAmbientBackdrop field={firstField} />);
    flushTexturePreparation();

    rerender(<SpatialAmbientBackdrop field={second} />);
    revealPreparedTransition(browser);
    const incoming = transitionSurface(container);
    expect(incoming).toHaveClass('is-visible');

    rerender(<SpatialAmbientBackdrop field={third} />);
    const reusedIncoming = transitionSurface(container);
    expect(reusedIncoming).toBe(incoming);
    expect(reusedIncoming.getAttribute('data-field-key')).toContain('latest-third');
    expect(reusedIncoming).not.toHaveClass('is-visible');
    expect(container.querySelector('[data-renderer="spatial-canvas"]'))
      .toHaveAttribute('data-composite-state', 'preparing');
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('first');

    revealPreparedTransition(browser);
    fireEvent.transitionEnd(reusedIncoming, { propertyName: 'opacity' });
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('latest-third');
  });

  it('reuses an already-painted standby texture when returning to the previous field', () => {
    const browser = installBrowserMocks();
    const initial = { ...firstField, id: 'roundtrip-first' };
    const next = { ...secondField, id: 'roundtrip-second' };
    const putImageData = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData,
    } as unknown as CanvasRenderingContext2D);
    const { container, rerender } = render(<SpatialAmbientBackdrop field={initial} />);
    flushTexturePreparation();

    rerender(<SpatialAmbientBackdrop field={next} />);
    revealPreparedTransition(browser);
    fireEvent.transitionEnd(transitionSurface(container), { propertyName: 'opacity' });
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('roundtrip-second');
    const paintCountBeforeReturn = putImageData.mock.calls.length;

    rerender(<SpatialAmbientBackdrop field={initial} />);
    const returning = transitionSurface(container);
    expect(returning).toHaveAttribute('data-texture-state', 'ready');
    expect(returning).not.toHaveClass('is-visible');
    browser.runNextFrame();
    browser.runNextFrame();
    expect(returning).toHaveClass('is-visible');
    expect(putImageData).toHaveBeenCalledTimes(paintCountBeforeReturn);

    fireEvent.transitionEnd(returning, { propertyName: 'opacity' });
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('roundtrip-first');
  });

  it('cancels stale Worker preparation and accepts only the newest result', () => {
    class FakeWorker {
      static instances: FakeWorker[] = [];
      onmessage: ((event: MessageEvent<SpatialTextureWorkerResponse>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;
      request: SpatialTextureWorkerRequest | null = null;
      terminate = vi.fn();

      constructor() {
        FakeWorker.instances.push(this);
      }

      postMessage(request: SpatialTextureWorkerRequest) {
        this.request = request;
      }

      respond() {
        if (!this.request) throw new Error('Worker has no request');
        const length = SPATIAL_FIELD_CANVAS_WIDTH * SPATIAL_FIELD_CANVAS_HEIGHT * 4;
        this.onmessage?.({
          data: {
            id: this.request.id,
            base: new Uint8ClampedArray(length),
            flow: new Uint8ClampedArray(length),
            drift: new Uint8ClampedArray(length),
          },
        } as MessageEvent<SpatialTextureWorkerResponse>);
      }
    }

    const browser = installBrowserMocks();
    vi.stubGlobal('Worker', FakeWorker);
    const initial = { ...firstField, id: 'worker-initial' };
    const temporary = { ...secondField, id: 'worker-temporary' };
    const latest = { ...thirdField, id: 'worker-latest' };
    const { container, rerender } = render(<SpatialAmbientBackdrop field={initial} />);

    expect(FakeWorker.instances).toHaveLength(1);
    act(() => FakeWorker.instances[0]?.respond());
    rerender(<SpatialAmbientBackdrop field={temporary} />);
    expect(FakeWorker.instances).toHaveLength(2);
    const temporaryWorker = FakeWorker.instances[1]!;

    rerender(<SpatialAmbientBackdrop field={latest} />);
    expect(temporaryWorker.terminate).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(3);
    expect(transitionSurface(container).getAttribute('data-field-key')).toContain('worker-latest');

    act(() => FakeWorker.instances[2]?.respond());
    browser.runNextFrame();
    browser.runNextFrame();
    fireEvent.transitionEnd(transitionSurface(container), { propertyName: 'opacity' });
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('worker-latest');
  });

  it('falls back to deferred main-thread preparation when Worker startup fails', () => {
    class FailingWorker {
      static instance: FailingWorker | null = null;
      onmessage: ((event: MessageEvent<SpatialTextureWorkerResponse>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;
      terminate = vi.fn();

      constructor() {
        FailingWorker.instance = this;
      }

      postMessage() {
        this.onerror?.(new ErrorEvent('error', { cancelable: true }));
      }
    }

    installBrowserMocks();
    vi.stubGlobal('Worker', FailingWorker);
    const putImageData = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData,
    } as unknown as CanvasRenderingContext2D);

    render(<SpatialAmbientBackdrop field={{ ...firstField, id: 'worker-fallback' }} />);
    expect(FailingWorker.instance?.terminate).toHaveBeenCalledTimes(1);
    expect(putImageData).not.toHaveBeenCalled();

    flushTexturePreparation();
    expect(putImageData).toHaveBeenCalledTimes(6);
  });

  it('keeps steady-state flow on compositor animations without repainting in JavaScript', () => {
    installBrowserMocks();
    const putImageData = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData,
    } as unknown as CanvasRenderingContext2D);
    render(<SpatialAmbientBackdrop field={{ ...firstField, id: 'steady-state' }} />);

    expect(putImageData).not.toHaveBeenCalled();
    flushTexturePreparation();
    expect(putImageData).toHaveBeenCalledTimes(6);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(60_000));
    expect(putImageData).toHaveBeenCalledTimes(6);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('removes its reduced-motion listener when unmounted', () => {
    const browser = installBrowserMocks();
    const view = render(<SpatialAmbientBackdrop field={{ ...firstField, id: 'unmount' }} />);

    expect(browser.query.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    view.unmount();
    expect(browser.query.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('treats motion timing changes as a new field presentation', () => {
    const browser = installBrowserMocks();
    const initial = { ...firstField, id: 'motion-timing' };
    const { container, rerender } = render(<SpatialAmbientBackdrop field={initial} />);
    flushTexturePreparation();

    rerender(<SpatialAmbientBackdrop field={{ ...initial, cycleA: '79s' }} />);
    revealPreparedTransition(browser);

    expect(transitionSurface(container).getAttribute('data-field-key')).toContain('79s');
  });
});
