// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PlayerSnapshot } from '../../shared/contracts.js';
import { usePlayer } from '../hooks/usePlayer.js';
import { LyricsStage, PlayerPage } from './PlayerPage.js';

vi.mock('../hooks/usePlayer.js', () => ({ usePlayer: vi.fn() }));

const snapshot: PlayerSnapshot = {
  mode: 'live',
  connection: 'connected',
  track: {
    title: 'Midnight Circuit',
    artist: 'Local Drive',
    album: 'After Dark',
    durationMs: 214_000,
    source: 'Apple Music',
  },
  playbackStatus: 'playing',
  elapsedMs: 4_000,
  capturedAtMs: Date.now(),
  manualOffsetMs: 0,
  lyricsTrackMatchesCurrent: true,
  lyrics: {
    kind: 'synced',
    lines: [
      { id: '0', startMs: 0, text: 'Streetlights draw a silver line' },
      { id: '1', startMs: 12_000, text: 'The city folds behind the glass' },
    ],
    provider: 'lrclib',
  },
  artworkPalette: null,
  vehicleName: 'Model Y',
};

const canvasPutImageData = vi.fn();

function sampledField(
  id = '0123456789abcdef',
  left = '#123456',
  right = '#A0B0C0',
  base = '#17202A',
) {
  return {
    schemaVersion: 1 as const,
    id: `field:${id}`,
    columns: 6 as const,
    rows: 4 as const,
    base,
    colors: Array.from({ length: 24 }, (_, index) => index % 6 < 3 ? left : right),
  };
}

function lyricLine(text: string): HTMLElement {
  const line = screen.getByText(text).closest<HTMLElement>('.am-lyric-line');
  if (!line) throw new Error(`Missing lyric line: ${text}`);
  return line;
}

function installMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

describe('PlayerPage Tesla companion layout', () => {
  beforeAll(() => {
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  beforeEach(() => {
    installMatchMedia(false);
    canvasPutImageData.mockClear();
    class ImmediateTextureWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;
      terminate = vi.fn();

      postMessage(request: { id: number }) {
        const pixelLength = 192 * 108 * 4;
        this.onmessage?.({
          data: {
            id: request.id,
            base: new Uint8ClampedArray(pixelLength),
            flow: new Uint8ClampedArray(pixelLength),
            drift: new Uint8ClampedArray(pixelLength),
          },
        } as MessageEvent);
      }
    }
    vi.stubGlobal('Worker', ImmediateTextureWorker);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData: canvasPutImageData,
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows lyrics and minimal utilities without duplicating Tesla media metadata', () => {
    vi.mocked(usePlayer).mockReturnValue({
      snapshot,
      elapsedMs: 4_000,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    const { container } = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
    const player = container.querySelector<HTMLElement>('.am-player');

    expect(screen.getByText('实时同步')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开歌词设置' })).toBeInTheDocument();
    expect(player).toHaveClass('am-player--liquid-glass');
    expect(player).toHaveClass('am-player--spatial-background');
    expect(container.querySelector('[data-renderer="spatial-canvas"]')).toBeInTheDocument();
    expect(container.querySelector('.spatial-field-surface.is-active')?.getAttribute('data-field-key'))
      .toContain('fallback:');
    expect(player).not.toHaveAttribute('data-preview-motion');
    expect(lyricLine('Streetlights draw a silver line')).toHaveAttribute('aria-current', 'true');
    expect(lyricLine('Streetlights draw a silver line')).toHaveAttribute('data-state', 'active');
    expect(lyricLine('Streetlights draw a silver line').style.getPropertyValue('--lyric-opacity')).toBe('0.99');
    expect(lyricLine('Streetlights draw a silver line').style.getPropertyValue('--lyric-scale')).toBe('1');
    expect(lyricLine('Streetlights draw a silver line').style.getPropertyValue('--lyric-glow-alpha')).toBe('0.02');
    expect(lyricLine('Streetlights draw a silver line').style.getPropertyValue('--lyric-breath-ms')).toBe('');
    expect(lyricLine('The city folds behind the glass')).toHaveAttribute('data-state', 'next');
    expect(lyricLine('Streetlights draw a silver line').style.getPropertyValue('--lyric-progress')).toBe('');
    expect(screen.queryByText('Midnight Circuit')).not.toBeInTheDocument();
    expect(screen.queryByText('Local Drive')).not.toBeInTheDocument();
    expect(screen.queryByText('After Dark')).not.toBeInTheDocument();
    expect(screen.queryByText('Apple Music')).not.toBeInTheDocument();
    expect(container.querySelector('.am-now-playing')).toBeNull();
    expect(container.querySelector('.am-progress')).toBeNull();
    expect(container.querySelector('.am-offset-control')).toBeNull();
    expect(container.querySelector('.am-navigation-card')).toBeNull();
    expect(container.querySelector('.ambient-grain')).toBeNull();
    expect(container.querySelector('.lg-glass-surface')).toBeNull();
  });

  it('shows the current navigation destination and ETA without duplicating media metadata', () => {
    vi.mocked(usePlayer).mockReturnValue({
      snapshot: {
        ...snapshot,
        navigation: {
          destinationName: '上海虹桥国际机场',
          minutesToArrival: 18.2,
          updatedAtMs: Date.now(),
          distanceToArrivalMiles: 12.4,
          arrivalBatteryPercent: 68,
        },
      },
      elapsedMs: 4_000,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    render(<MemoryRouter><PlayerPage /></MemoryRouter>);

    const navigation = screen.getByLabelText('当前导航');
    expect(navigation).toHaveTextContent('目的地');
    expect(navigation).toHaveTextContent('上海虹桥国际机场');
    expect(navigation).toHaveTextContent('剩余距离');
    expect(navigation).toHaveTextContent('12 mi');
    expect(navigation).toHaveTextContent('19 分钟');
    expect(navigation).toHaveTextContent('预计到达电量');
    expect(navigation).toHaveTextContent('68%');
    expect(navigation.querySelector('.am-navigation-route')).toBeNull();
    expect(navigation.querySelector('.am-navigation-battery-track')).toBeNull();
    expect(navigation.querySelector('.am-navigation-remaining')).not.toBeNull();
    expect(screen.queryByText('Midnight Circuit')).not.toBeInTheDocument();
  });

  it('removes stale lyrics during a metadata/loading burst and commits the new timeline once', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let observerConstructions = 0;
    class MockResizeObserver implements ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {
        observerConstructions += 1;
      }
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    globalThis.ResizeObserver = MockResizeObserver;

    const nextLyrics: PlayerSnapshot['lyrics'] = {
      kind: 'synced',
      lines: [
        { id: 'next-0', startMs: 0, text: 'New timeline first line' },
        { id: 'next-1', startMs: 9_000, text: 'New timeline second line' },
      ],
      provider: 'apple',
    };
    const initialSnapshot: PlayerSnapshot = {
      ...snapshot,
      elapsedMs: 13_000,
    };
    const playerState = (current: PlayerSnapshot, currentElapsedMs = 4_000) => ({
      snapshot: current,
      elapsedMs: currentElapsedMs,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    try {
      vi.mocked(usePlayer).mockReturnValue(playerState(initialSnapshot, 13_000));
      const view = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
      const lyricsView = view.container.querySelector('.am-lyrics-view');
      const lyricsStage = view.container.querySelector('.am-lyrics-rail');
      expect(observerConstructions).toBe(1);
      expect(lyricLine('The city folds behind the glass')).toHaveAttribute('aria-current', 'true');

      vi.mocked(usePlayer).mockReturnValue(playerState({
        ...initialSnapshot,
        track: {
          ...initialSnapshot.track!,
          title: 'Next Track',
          durationMs: 198_000,
        },
        playbackStatus: 'paused',
        manualOffsetMs: -10_000,
        lyricsTrackMatchesCurrent: false,
        capturedAtMs: initialSnapshot.capturedAtMs + 100,
      }, 100));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      expect(view.container.querySelector('.am-lyrics-view')).toBe(lyricsView);
      expect(view.container.querySelector('.am-lyrics-rail')).toBeNull();
      expect(screen.queryByText('Streetlights draw a silver line')).not.toBeInTheDocument();
      expect(screen.getByText('正在载入歌词…')).toBeInTheDocument();

      vi.mocked(usePlayer).mockReturnValue(playerState({
        ...initialSnapshot,
        track: {
          ...initialSnapshot.track!,
          title: 'Next Track',
          artist: 'Next Artist',
          durationMs: 198_000,
        },
        playbackStatus: 'paused',
        manualOffsetMs: -10_000,
        lyricsTrackMatchesCurrent: false,
        lyrics: { kind: 'loading', lines: [], provider: null },
        capturedAtMs: initialSnapshot.capturedAtMs + 200,
      }, 200));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      expect(view.container.querySelector('.am-lyrics-view')).toBe(lyricsView);
      expect(view.container.querySelector('.am-lyrics-rail')).toBeNull();
      expect(screen.queryByText('Streetlights draw a silver line')).not.toBeInTheDocument();
      expect(screen.getByText('正在载入歌词…')).toBeInTheDocument();

      vi.mocked(usePlayer).mockReturnValue(playerState({
        ...initialSnapshot,
        track: {
          ...initialSnapshot.track!,
          title: 'Next Track',
          artist: 'Next Artist',
          durationMs: 198_000,
        },
        playbackStatus: 'paused',
        manualOffsetMs: -10_000,
        lyricsTrackMatchesCurrent: false,
        lyrics: { kind: 'loading', lines: [], provider: null },
        capturedAtMs: initialSnapshot.capturedAtMs + 300,
      }, 300));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      expect(view.container.querySelector('.am-lyrics-rail')).toBeNull();
      expect(screen.getByText('正在载入歌词…')).toBeInTheDocument();
      expect(observerConstructions).toBe(1);

      vi.mocked(usePlayer).mockReturnValue(playerState({
        ...initialSnapshot,
        track: {
          ...initialSnapshot.track!,
          title: 'Next Track',
          artist: 'Next Artist',
          durationMs: 198_000,
        },
        elapsedMs: 400,
        playbackStatus: 'playing',
        manualOffsetMs: 0,
        lyricsTrackMatchesCurrent: true,
        lyrics: nextLyrics,
        capturedAtMs: initialSnapshot.capturedAtMs + 400,
      }, 400));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      const committedLine = screen.getByText('New timeline first line');
      const replacementLyricsStage = view.container.querySelector('.am-lyrics-rail');
      expect(view.container.querySelector('.am-lyrics-view')).toBe(lyricsView);
      expect(replacementLyricsStage).not.toBeNull();
      expect(replacementLyricsStage).not.toBe(lyricsStage);
      expect(screen.queryByText('Streetlights draw a silver line')).not.toBeInTheDocument();
      expect(lyricLine('New timeline first line')).toHaveAttribute('aria-current', 'true');
      expect(observerConstructions).toBe(2);

      vi.mocked(usePlayer).mockReturnValue(playerState({
        ...initialSnapshot,
        track: {
          ...initialSnapshot.track!,
          title: 'Next Track',
          artist: 'Next Artist',
          durationMs: 198_000,
        },
        elapsedMs: 500,
        lyrics: {
          ...nextLyrics,
          lines: nextLyrics.lines.map((line) => ({ ...line })),
        },
        capturedAtMs: initialSnapshot.capturedAtMs + 500,
      }, 500));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      expect(view.container.querySelector('.am-lyrics-rail')).toBe(replacementLyricsStage);
      expect(screen.getByText('New timeline first line')).toBe(committedLine);
      expect(observerConstructions).toBe(2);
      view.unmount();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('hides a stale timeline while replacement lyrics are loading', () => {
    vi.useFakeTimers();
    const initialSnapshot: PlayerSnapshot = {
      ...snapshot,
      elapsedMs: 0,
      capturedAtMs: 100,
      lyrics: {
        kind: 'synced',
        lines: [
          { id: 'old-0', startMs: 0, text: 'Retained first line' },
          { id: 'old-1', startMs: 1_000, text: 'Retained second line' },
        ],
        provider: 'lrclib',
      },
    };
    const playerState = (current: PlayerSnapshot) => ({
      snapshot: current,
      elapsedMs: current.elapsedMs,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    try {
      vi.mocked(usePlayer).mockReturnValue(playerState(initialSnapshot));
      const view = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
      expect(lyricLine('Retained first line')).toHaveAttribute('aria-current', 'true');

      vi.mocked(usePlayer).mockReturnValue(playerState({
        ...initialSnapshot,
        track: { ...initialSnapshot.track!, title: 'Replacement Track' },
        lyricsTrackMatchesCurrent: false,
        lyrics: { kind: 'loading', lines: [], provider: null },
        capturedAtMs: 200,
      }));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);

      const rail = view.container.querySelector('.am-lyrics-rail');
      expect(rail).toBeNull();
      expect(screen.queryByText('Retained first line')).not.toBeInTheDocument();
      expect(screen.getByText('正在载入歌词…')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1_500));
      expect(screen.queryByText('Retained first line')).not.toBeInTheDocument();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows resolved lyrics at rest until the new playback clock is ready', () => {
    vi.useFakeTimers();
    const initialSnapshot: PlayerSnapshot = {
      ...snapshot,
      elapsedMs: 40_000,
      capturedAtMs: 100,
      trackGeneration: 1,
      lyricsGeneration: 1,
      playbackClockReady: true,
      snapshotRevision: 1,
    };
    const playerState = (current: PlayerSnapshot) => ({
      snapshot: current,
      elapsedMs: current.elapsedMs,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });
    const unresolvedClockSnapshot: PlayerSnapshot = {
      ...initialSnapshot,
      track: {
        ...initialSnapshot.track!,
        title: 'Clock Pending Track',
        durationMs: 120_000,
      },
      elapsedMs: 80_000,
      capturedAtMs: 200,
      trackGeneration: 2,
      lyricsGeneration: 2,
      playbackClockReady: false,
      snapshotRevision: 2,
      lyrics: {
        kind: 'synced',
        lines: [
          { id: 'pending-0', startMs: 0, text: 'Clock pending first line' },
          { id: 'pending-1', startMs: 30_000, text: 'Clock pending later line' },
        ],
        provider: 'apple',
      },
    };

    try {
      vi.mocked(usePlayer).mockReturnValue(playerState(initialSnapshot));
      const view = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
      vi.mocked(usePlayer).mockReturnValue(playerState(unresolvedClockSnapshot));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);

      const rail = view.container.querySelector('.am-lyrics-rail');
      expect(screen.getByText('Clock pending first line')).toBeInTheDocument();
      expect(lyricLine('Clock pending first line')).not.toHaveAttribute('aria-current');
      expect(lyricLine('Clock pending first line')).toHaveAttribute('data-state', 'next');
      expect(lyricLine('Clock pending later line')).not.toHaveAttribute('aria-current');
      expect(rail).toHaveAttribute('data-running', 'false');
      act(() => vi.advanceTimersByTime(2_000));
      expect(lyricLine('Clock pending first line')).not.toHaveAttribute('aria-current');

      vi.mocked(usePlayer).mockReturnValue(playerState({
        ...unresolvedClockSnapshot,
        elapsedMs: 500,
        capturedAtMs: 300,
        playbackClockReady: true,
        snapshotRevision: 3,
      }));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      expect(rail).toHaveAttribute('data-running', 'true');
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps same-track lyrics through an album metadata generation change', () => {
    const initialSnapshot: PlayerSnapshot = {
      ...snapshot,
      capturedAtMs: 100,
      trackGeneration: 1,
      lyricsGeneration: 1,
      playbackClockReady: true,
      snapshotRevision: 1,
    };
    const playerState = (current: PlayerSnapshot) => ({
      snapshot: current,
      elapsedMs: current.elapsedMs,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    vi.mocked(usePlayer).mockReturnValue(playerState(initialSnapshot));
    const view = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
    const rail = view.container.querySelector('.am-lyrics-rail');

    vi.mocked(usePlayer).mockReturnValue(playerState({
      ...initialSnapshot,
      track: {
        ...initialSnapshot.track!,
        album: 'New Album Identity',
      },
      elapsedMs: 100,
      capturedAtMs: 200,
      trackGeneration: 2,
      lyricsGeneration: 2,
      lyricsTrackMatchesCurrent: true,
      snapshotRevision: 2,
      lyrics: {
        ...initialSnapshot.lyrics,
        lines: initialSnapshot.lyrics.lines.map((line) => ({ ...line })),
      },
    }));
    view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);

    expect(screen.getByText('Streetlights draw a silver line')).toBeInTheDocument();
    expect(view.container.querySelector('.am-lyrics-rail')).toBe(rail);
    expect(rail).toHaveAttribute('data-running', 'true');
  });

  it('keeps a positioned lyrics track visible when a replacement timeline introduces CJK text', async () => {
    const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    let resolveFonts!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready },
    });
    const playerState = (current: PlayerSnapshot) => ({
      snapshot: current,
      elapsedMs: current.elapsedMs,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    try {
      vi.mocked(usePlayer).mockReturnValue(playerState(snapshot));
      const view = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
      const lyricsView = view.container.querySelector('.am-lyrics-view');
      const lyricsStage = view.container.querySelector('.am-lyrics-rail');
      const lyricsTrack = view.container.querySelector('.am-lyrics-track');
      expect(lyricsTrack).toHaveClass('is-positioned');

      const loadingSnapshot: PlayerSnapshot = {
        ...snapshot,
        track: { ...snapshot.track!, title: '星河' },
        elapsedMs: 100,
        lyrics: { kind: 'loading', lines: [], provider: null },
      };
      vi.mocked(usePlayer).mockReturnValue(playerState(loadingSnapshot));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      expect(screen.getByText('Streetlights draw a silver line')).toBeInTheDocument();
      expect(view.container.querySelector('.am-lyrics-track')).toBe(lyricsTrack);
      expect(lyricsTrack).toHaveClass('is-positioned');

      const resolvedSnapshot: PlayerSnapshot = {
        ...loadingSnapshot,
        lyrics: {
          kind: 'synced',
          lines: [
            { id: 'zh-0', startMs: 0, text: '夜空中最亮的星' },
            { id: 'zh-1', startMs: 8_000, text: '照亮我前行' },
          ],
          provider: 'apple',
        },
      };
      vi.mocked(usePlayer).mockReturnValue(playerState(resolvedSnapshot));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);

      expect(screen.getByText('夜空中最亮的星')).toBeInTheDocument();
      expect(view.container.querySelector('.am-lyrics-view')).toBe(lyricsView);
      expect(view.container.querySelector('.am-lyrics-rail')).toBe(lyricsStage);
      expect(view.container.querySelector('.am-lyrics-track')).toBe(lyricsTrack);
      expect(lyricsTrack).toHaveClass('is-positioned');

      await act(async () => {
        resolveFonts();
        await ready;
      });
      expect(lyricsTrack).toHaveClass('is-positioned');
      view.unmount();
    } finally {
      if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('positions a replacement timeline from its own frame before the first layout completes', () => {
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function getClientHeight(this: HTMLElement) {
        return this.classList.contains('am-lyrics-rail') ? 600 : 0;
      });
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function getClientWidth(this: HTMLElement) {
        return this.classList.contains('am-lyrics-rail') ? 1_000 : 0;
      });
    const offsetTop = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get')
      .mockImplementation(function getOffsetTop(this: HTMLElement) {
        if (this.textContent === 'Old first line') return 100;
        if (this.textContent === 'Old second line') return 180;
        if (this.textContent === 'New first position') return 100;
        if (this.textContent === 'New focused position') return 320;
        return 0;
      });
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function getOffsetHeight(this: HTMLElement) {
        return this.classList.contains('am-lyric-line') ? 80 : 0;
      });

    try {
      const oldLines = [
        { id: 'old-0', startMs: 0, text: 'Old first line' },
        { id: 'old-1', startMs: 8_000, text: 'Old second line' },
      ];
      const newLines = [
        { id: 'new-0', startMs: 0, text: 'New first position' },
        { id: 'new-1', startMs: 5_000, text: 'New focused position' },
      ];
      const view = render(
        <LyricsStage
          lines={oldLines}
          elapsedMs={0}
          offsetMs={0}
          playbackStatus="paused"
          durationMs={20_000}
          clockRevision={1}
        />,
      );
      const rail = view.container.querySelector('.am-lyrics-rail');
      const track = view.container.querySelector<HTMLElement>('.am-lyrics-track');
      expect(track?.style.transform).toBe('translate3d(0, 100px, 0)');

      view.rerender(
        <LyricsStage
          lines={newLines}
          elapsedMs={6_000}
          offsetMs={0}
          playbackStatus="paused"
          durationMs={20_000}
          clockRevision={2}
        />,
      );

      expect(view.container.querySelector('.am-lyrics-rail')).toBe(rail);
      expect(view.container.querySelector('.am-lyrics-track')).toBe(track);
      expect(lyricLine('New focused position')).toHaveAttribute('aria-current', 'true');
      expect(lyricLine('New focused position')).toHaveAttribute('data-state', 'active');
      expect(lyricLine('New focused position').style.getPropertyValue('--lyric-opacity')).toBe('0.99');
      expect(track?.style.transform).toBe('translate3d(0, -120px, 0)');
    } finally {
      clientHeight.mockRestore();
      clientWidth.mockRestore();
      offsetTop.mockRestore();
      offsetHeight.mockRestore();
    }
  });

  it('keeps English typography intact while marking Chinese and mixed lyric runs', () => {
    const lines = [
      { id: 'zh', startMs: 0, text: '夜空中最亮的星' },
      { id: 'mixed', startMs: 10_000, text: 'I still 想你 every night' },
      { id: 'en', startMs: 20_000, text: 'Streetlights draw a silver line' },
    ];

    const { container } = render(
      <LyricsStage
        lines={lines}
        elapsedMs={0}
        offsetMs={0}
        playbackStatus="paused"
        durationMs={30_000}
      />,
    );

    const chineseLine = lyricLine('夜空中最亮的星');
    const mixedLine = container.querySelector<HTMLElement>('.am-lyric-line[data-script="mixed"]');
    const englishLine = lyricLine('Streetlights draw a silver line');

    expect(chineseLine).toHaveAttribute('data-script', 'cjk');
    expect(chineseLine.querySelector('[data-script="cjk"]')).toHaveAttribute('lang', 'zh-Hans');
    expect(mixedLine).toHaveTextContent('I still 想你 every night');
    expect([...mixedLine!.querySelectorAll<HTMLElement>('.am-lyric-script')].map((run) => ({
      language: run.getAttribute('lang'),
      script: run.dataset.script,
      text: run.textContent,
    }))).toEqual([
      { language: null, script: 'latin', text: 'I still ' },
      { language: 'zh-Hans', script: 'cjk', text: '想你 ' },
      { language: null, script: 'latin', text: 'every night' },
    ]);
    expect(englishLine).toHaveAttribute('data-script', 'latin');
    expect(englishLine.querySelector('.am-lyric-script')).toBeNull();
  });

  it('waits for the CJK font without letting ResizeObserver reveal fallback glyphs', async () => {
    const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    const originalResizeObserver = globalThis.ResizeObserver;
    let resolveFonts!: () => void;
    let frameCallback: FrameRequestCallback | undefined;
    let resizeCallback: ResizeObserverCallback | undefined;
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallback = callback;
      return 42;
    });
    const ready = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });
    class MockResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready },
    });
    globalThis.ResizeObserver = MockResizeObserver;

    try {
      const view = render(
        <LyricsStage
          lines={[{ id: 'zh', startMs: 0, text: '夜空中最亮的星' }]}
          elapsedMs={0}
          offsetMs={0}
          playbackStatus="paused"
          durationMs={10_000}
        />,
      );
      const track = view.container.querySelector('.am-lyrics-track');

      expect(track).not.toHaveClass('is-positioned');
      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
        frameCallback?.(16);
      });
      expect(track).not.toHaveClass('is-positioned');
      await act(async () => {
        resolveFonts();
        await ready;
      });
      expect(track).toHaveClass('is-positioned');
      view.unmount();
    } finally {
      if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor);
      else Reflect.deleteProperty(document, 'fonts');
      globalThis.ResizeObserver = originalResizeObserver;
      requestFrame.mockRestore();
    }
  });

  it('reveals CJK lyrics after a bounded wait when the font remains unavailable', () => {
    vi.useFakeTimers();
    const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise(() => undefined) },
    });

    try {
      const view = render(
        <LyricsStage
          lines={[{ id: 'zh', startMs: 0, text: '后来，我们终于明白。' }]}
          elapsedMs={0}
          offsetMs={0}
          playbackStatus="paused"
          durationMs={10_000}
        />,
      );
      const track = view.container.querySelector('.am-lyrics-track');

      expect(track).not.toHaveClass('is-positioned');
      act(() => vi.advanceTimersByTime(899));
      expect(track).not.toHaveClass('is-positioned');
      act(() => vi.advanceTimersByTime(1));
      expect(track).toHaveClass('is-positioned');
      view.unmount();
    } finally {
      if (fontsDescriptor) Object.defineProperty(document, 'fonts', fontsDescriptor);
      else Reflect.deleteProperty(document, 'fonts');
      vi.useRealTimers();
    }
  });

  it('applies the same script-aware typography to plain lyrics', () => {
    vi.mocked(usePlayer).mockReturnValue({
      snapshot: {
        ...snapshot,
        lyrics: {
          kind: 'plain',
          lines: [
            { id: 'zh', startMs: 0, text: '后来，我们终于明白。' },
            { id: 'mixed', startMs: 0, text: 'I still 想你' },
          ],
          provider: 'lrclib',
        },
      },
      elapsedMs: 4_000,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    const { container } = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
    const paragraphs = container.querySelectorAll<HTMLElement>('.am-plain-lyrics p');

    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toHaveAttribute('data-script', 'cjk');
    expect(paragraphs[0]?.querySelector('[data-script="cjk"]')).toHaveAttribute('lang', 'zh-Hans');
    expect(paragraphs[1]).toHaveAttribute('data-script', 'mixed');
    expect(paragraphs[1]).toHaveTextContent('I still 想你');
  });

  it('offers a direct settings action when lyrics are missing', () => {
    vi.mocked(usePlayer).mockReturnValue({
      snapshot: {
        ...snapshot,
        lyrics: { kind: 'missing', lines: [], provider: null, notice: '没有可靠匹配。' },
      },
      elapsedMs: 4_000,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    render(<MemoryRouter><PlayerPage /></MemoryRouter>);

    expect(screen.getByText('暂时没有同步歌词')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '在设置中添加 LRC' })).toHaveAttribute('href', '/setup');
  });

  it('renders a validated real artwork field in the persistent spatial backdrop', () => {
    vi.mocked(usePlayer).mockReturnValue({
      snapshot: {
        ...snapshot,
        artworkPalette: {
          primary: '#123456',
          secondary: '#A0B0C0',
          source: 'apple',
          field: sampledField(),
        },
      },
      elapsedMs: 4_000,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    const { container } = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
    const layer = container.querySelector<HTMLElement>('.spatial-field-surface.is-active');
    const player = container.querySelector<HTMLElement>('.am-player--liquid-glass');

    expect(player).toHaveClass('am-player--spatial-background');
    expect(container.querySelector('[data-renderer="spatial-canvas"]')).toBeInTheDocument();
    expect(container.querySelector('.ambient-palette-layer')).toBeNull();
    expect(layer?.getAttribute('data-field-key')).toContain('field:0123456789abcdef');
    expect(layer).toHaveAttribute('data-motion', 'running');
    expect(container.querySelector('[data-renderer="spatial-canvas"]')).toHaveAttribute('data-motion', 'full');
    expect(layer?.style.getPropertyValue('--spatial-base-rgb')).toBe('23 32 42');
    expect(Number.parseInt(layer?.style.getPropertyValue('--spatial-cycle-a') ?? ''))
      .toBeGreaterThanOrEqual(89);
    expect(Number.parseInt(layer?.style.getPropertyValue('--spatial-cycle-b') ?? ''))
      .toBeGreaterThanOrEqual(43);
    expect(Number.parseInt(layer?.style.getPropertyValue('--spatial-cycle-c') ?? ''))
      .toBeGreaterThanOrEqual(131);
    expect(container.querySelectorAll('canvas[data-spatial-layer]')).toHaveLength(6);
    expect(container.querySelectorAll('canvas[data-spatial-layer="flow-a"]')).toHaveLength(2);
    expect(container.querySelectorAll('canvas[data-spatial-layer="flow-b"]')).toHaveLength(2);
    expect(canvasPutImageData).toHaveBeenCalledTimes(3);
    expect(player?.style.getPropertyValue('--lg-palette-primary')).toBe('18 52 86');
    expect(player?.style.getPropertyValue('--lg-palette-secondary')).toBe('160 176 192');
    expect(player?.style.getPropertyValue('--lg-palette-bridge')).toBe('86 112 137');
  });

  it('crossfades real sampled fields for 2.2 seconds without restarting for metadata-only updates', () => {
    vi.useFakeTimers();
    let frameCallback: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallback = callback;
      return 7;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const missingLyrics: PlayerSnapshot['lyrics'] = {
      kind: 'missing',
      lines: [],
      provider: null,
    };
    const firstSnapshot: PlayerSnapshot = {
      ...snapshot,
      playbackStatus: 'paused',
      lyrics: missingLyrics,
      artworkPalette: {
        primary: '#123456',
        secondary: '#A0B0C0',
        source: 'apple',
        field: sampledField('0123456789abcdef'),
      },
    };
    const secondSnapshot: PlayerSnapshot = {
      ...firstSnapshot,
      track: { ...firstSnapshot.track!, title: 'Sunrise Circuit' },
      artworkPalette: {
        primary: '#CC5A38',
        secondary: '#F0B56A',
        source: 'apple',
        field: sampledField('fedcba9876543210', '#CC5A38', '#F0B56A', '#3A211B'),
      },
    };
    const sameColorMetadataUpdate: PlayerSnapshot = {
      ...secondSnapshot,
      track: { ...secondSnapshot.track!, title: 'Sunrise Circuit (Live)' },
      capturedAtMs: secondSnapshot.capturedAtMs + 700,
    };
    const playerState = (current: PlayerSnapshot) => ({
      snapshot: current,
      elapsedMs: 4_000,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    try {
      vi.mocked(usePlayer).mockReturnValue(playerState(firstSnapshot));
      const view = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
      expect(view.container.querySelector('.spatial-field-surface.is-transitioning')).toBeNull();

      vi.mocked(usePlayer).mockReturnValue(playerState(secondSnapshot));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      const incoming = view.container.querySelector<HTMLElement>('.spatial-field-surface.is-transitioning');
      expect(incoming?.getAttribute('data-field-key')).toContain('field:fedcba9876543210');
      expect(incoming).not.toHaveClass('is-visible');

      act(() => frameCallback?.(0));
      expect(incoming).not.toHaveClass('is-visible');
      act(() => frameCallback?.(16));
      expect(incoming).toHaveClass('is-visible');
      act(() => vi.advanceTimersByTime(700));
      vi.mocked(usePlayer).mockReturnValue(playerState(sameColorMetadataUpdate));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      expect(view.container.querySelector('.spatial-field-surface.is-transitioning')).toBe(incoming);
      expect(requestFrame).toHaveBeenCalledTimes(2);

      act(() => vi.advanceTimersByTime(699));
      expect(view.container.querySelector('.spatial-field-surface.is-transitioning')).toBe(incoming);
      act(() => vi.advanceTimersByTime(1));
      fireEvent.transitionEnd(incoming!, { propertyName: 'opacity' });
      const active = view.container.querySelector<HTMLElement>('.spatial-field-surface.is-active');
      expect(active?.getAttribute('data-field-key')).toContain('field:fedcba9876543210');
      expect(view.container.querySelector('.spatial-field-surface.is-transitioning')).toBeNull();
      view.unmount();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reuses the incoming layer and skips a superseded field during rapid updates', () => {
    vi.useFakeTimers();
    let frameCallback: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallback = callback;
      return requestFrame.mock.calls.length;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const initial: PlayerSnapshot = {
      ...snapshot,
      playbackStatus: 'paused',
      lyrics: { kind: 'missing', lines: [], provider: null },
      artworkPalette: {
        primary: '#16283A',
        secondary: '#29445C',
        source: 'apple',
        field: sampledField('1111111111111111', '#16283A', '#29445C'),
      },
    };
    const incomingSnapshot: PlayerSnapshot = {
      ...initial,
      track: { ...initial.track!, title: 'New Album Track' },
      artworkPalette: {
        primary: '#667788',
        secondary: '#8899AA',
        source: 'apple',
        field: sampledField('2222222222222222', '#667788', '#8899AA'),
      },
    };
    const resolved: PlayerSnapshot = {
      ...incomingSnapshot,
      artworkPalette: {
        primary: '#C43C54',
        secondary: '#F0A24C',
        source: 'apple',
        field: sampledField('3333333333333333', '#C43C54', '#F0A24C'),
      },
    };
    const playerState = (current: PlayerSnapshot) => ({
      snapshot: current,
      elapsedMs: 4_000,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    try {
      vi.mocked(usePlayer).mockReturnValue(playerState(initial));
      const view = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
      vi.mocked(usePlayer).mockReturnValue(playerState(incomingSnapshot));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      act(() => frameCallback?.(0));
      expect(view.container.querySelector('.spatial-field-surface.is-transitioning'))
        .not.toHaveClass('is-visible');
      act(() => frameCallback?.(16));
      act(() => vi.advanceTimersByTime(800));
      const visibleIncoming = view.container.querySelector<HTMLElement>('.spatial-field-surface.is-transitioning');
      expect(visibleIncoming?.getAttribute('data-field-key')).toContain('field:2222222222222222');
      expect(visibleIncoming).toHaveClass('is-visible');

      vi.mocked(usePlayer).mockReturnValue(playerState(resolved));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);
      const reusedLayer = view.container.querySelector<HTMLElement>('.spatial-field-surface.is-transitioning');
      expect(reusedLayer).toBe(visibleIncoming);
      expect(reusedLayer?.getAttribute('data-field-key')).toContain('field:3333333333333333');
      expect(reusedLayer).not.toHaveClass('is-visible');
      expect(view.container.querySelector<HTMLElement>('.spatial-field-surface.is-active')
        ?.getAttribute('data-field-key')).toContain('field:1111111111111111');
      expect(requestFrame).toHaveBeenCalledTimes(3);

      act(() => frameCallback?.(0));
      expect(reusedLayer).not.toHaveClass('is-visible');
      expect(requestFrame).toHaveBeenCalledTimes(4);
      act(() => frameCallback?.(16));
      expect(reusedLayer).toHaveClass('is-visible');
      fireEvent.transitionEnd(reusedLayer!, { propertyName: 'opacity' });
      expect(view.container.querySelector<HTMLElement>('.spatial-field-surface.is-active')
        ?.getAttribute('data-field-key')).toContain('field:3333333333333333');
      expect(view.container.querySelector('.spatial-field-surface.is-transitioning')).toBeNull();
      view.unmount();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not repaint or restart the spatial field for playback-only telemetry changes', () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const stillSnapshot: PlayerSnapshot = {
      ...snapshot,
      playbackStatus: 'paused',
      lyrics: { kind: 'missing', lines: [], provider: null },
      artworkPalette: {
        primary: '#123456',
        secondary: '#A0B0C0',
        source: 'apple',
        field: sampledField(),
      },
    };
    const playerState = (current: PlayerSnapshot, elapsedMs: number) => ({
      snapshot: current,
      elapsedMs,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    vi.mocked(usePlayer).mockReturnValue(playerState(stillSnapshot, 4_000));
    const view = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
    const active = view.container.querySelector('.spatial-field-surface.is-active');
    requestFrame.mockClear();
    canvasPutImageData.mockClear();

    vi.mocked(usePlayer).mockReturnValue(playerState({
      ...stillSnapshot,
      elapsedMs: 9_000,
      capturedAtMs: stillSnapshot.capturedAtMs + 5_000,
    }, 9_000));
    view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);

    expect(view.container.querySelector('.spatial-field-surface.is-active')).toBe(active);
    expect(view.container.querySelector('.spatial-field-surface.is-transitioning')).toBeNull();
    expect(requestFrame).not.toHaveBeenCalled();
    expect(canvasPutImageData).not.toHaveBeenCalled();
    requestFrame.mockRestore();
  });

  it('promotes a new static field immediately in reduced-motion mode', () => {
    installMatchMedia(true);
    vi.useFakeTimers();
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(11);
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const initial: PlayerSnapshot = {
      ...snapshot,
      playbackStatus: 'paused',
      lyrics: { kind: 'missing', lines: [], provider: null },
      artworkPalette: {
        primary: '#102030',
        secondary: '#304050',
        source: 'apple',
        field: sampledField('4444444444444444', '#102030', '#304050'),
      },
    };
    const next: PlayerSnapshot = {
      ...initial,
      track: { ...initial.track!, title: 'Reduced Sunrise' },
      artworkPalette: {
        primary: '#8090A0',
        secondary: '#B0C0D0',
        source: 'apple',
        field: sampledField('5555555555555555', '#8090A0', '#B0C0D0'),
      },
    };
    const playerState = (current: PlayerSnapshot) => ({
      snapshot: current,
      elapsedMs: 4_000,
      streamConnected: true,
      unauthorized: false,
      error: null,
      setOffset: vi.fn(),
      demoAction: vi.fn(),
    });

    try {
      vi.mocked(usePlayer).mockReturnValue(playerState(initial));
      const view = render(<MemoryRouter><PlayerPage /></MemoryRouter>);
      vi.mocked(usePlayer).mockReturnValue(playerState(next));
      view.rerender(<MemoryRouter><PlayerPage /></MemoryRouter>);

      expect(view.container.querySelector('[data-renderer="spatial-canvas"]'))
        .toHaveAttribute('data-motion', 'reduced');
      expect(view.container.querySelector('.spatial-field-surface.is-transitioning'))
        .toHaveClass('is-visible');
      expect(view.container.querySelector<HTMLElement>('.spatial-field-surface.is-active')
        ?.getAttribute('data-field-key')).toContain('field:4444444444444444');
      expect(requestFrame).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(0));
      expect(view.container.querySelector<HTMLElement>('.spatial-field-surface.is-active')
        ?.getAttribute('data-field-key')).toContain('field:5555555555555555');
      expect(view.container.querySelector('.spatial-field-surface.is-transitioning')).toBeNull();
      view.unmount();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.useRealTimers();
    }
  });

  it('advances only at a lyric boundary and stays fixed while paused', () => {
    vi.useFakeTimers();
    const lines = [
      { id: 'a', startMs: 0, text: 'First timed line' },
      { id: 'b', startMs: 1_000, text: 'Second timed line' },
    ];
    const { rerender, unmount } = render(
      <LyricsStage
        lines={lines}
        elapsedMs={0}
        offsetMs={0}
        playbackStatus="paused"
        durationMs={10_000}
      />,
    );

    act(() => vi.advanceTimersByTime(2_000));
    expect(lyricLine('First timed line')).toHaveAttribute('aria-current', 'true');
    expect(document.querySelector('.am-lyrics-rail')).toHaveAttribute('data-running', 'false');

    rerender(
      <LyricsStage
        lines={lines}
        elapsedMs={0}
        offsetMs={0}
        playbackStatus="playing"
        durationMs={10_000}
      />,
    );
    act(() => vi.advanceTimersByTime(640));
    expect(lyricLine('First timed line')).toHaveAttribute('data-state', 'outgoing');
    expect(lyricLine('First timed line').style.getPropertyValue('--lyric-opacity')).toBe('0.99');
    expect(lyricLine('Second timed line')).toHaveAttribute('data-state', 'incoming');
    act(() => vi.advanceTimersByTime(359));
    expect(lyricLine('First timed line')).toHaveAttribute('aria-current', 'true');
    expect(lyricLine('First timed line').style.getPropertyValue('--lyric-opacity')).toBe('0.99');
    expect(lyricLine('Second timed line')).toHaveAttribute('data-state', 'incoming');
    act(() => vi.advanceTimersByTime(2));
    expect(lyricLine('Second timed line')).toHaveAttribute('aria-current', 'true');
    unmount();
    vi.useRealTimers();
  });

  it('keeps one media-time handoff intact across equivalent telemetry snapshots', () => {
    vi.useFakeTimers();
    const lines = [
      { id: 'a', startMs: 0, text: 'Stable first line' },
      { id: 'b', startMs: 1_000, text: 'Stable second line' },
    ];
    const { container, rerender, unmount } = render(
      <LyricsStage
        lines={lines}
        elapsedMs={0}
        offsetMs={0}
        playbackStatus="playing"
        durationMs={10_000}
        clockRevision={100}
      />,
    );

    act(() => vi.advanceTimersByTime(850));
    const track = container.querySelector<HTMLElement>('.am-lyrics-track');
    const progressBefore = Number(track?.style.getPropertyValue('--lyrics-track-progress'));
    expect(track).toHaveClass('is-animated');
    expect(progressBefore).toBeGreaterThan(0);
    expect(progressBefore).toBeLessThan(1);
    expect(lyricLine('Stable first line')).toHaveAttribute('data-state', 'outgoing');
    expect(lyricLine('Stable first line')).toHaveAttribute('aria-current', 'true');
    expect(lyricLine('Stable second line')).toHaveAttribute('data-state', 'incoming');

    rerender(
      <LyricsStage
        lines={lines.map((line) => ({ ...line }))}
        elapsedMs={850}
        offsetMs={0}
        playbackStatus="playing"
        durationMs={10_000}
        clockRevision={101}
      />,
    );

    const progressAfterTelemetry = Number(track?.style.getPropertyValue('--lyrics-track-progress'));
    expect(progressAfterTelemetry).toBeGreaterThanOrEqual(progressBefore);
    expect(progressAfterTelemetry - progressBefore).toBeLessThan(0.02);

    rerender(
      <LyricsStage
        lines={lines}
        elapsedMs={700}
        offsetMs={0}
        playbackStatus="playing"
        durationMs={10_000}
        clockRevision={102}
      />,
    );
    const progressAfterSmallCorrection = Number(track?.style.getPropertyValue('--lyrics-track-progress'));
    expect(progressAfterSmallCorrection).toBeGreaterThanOrEqual(progressAfterTelemetry);
    act(() => vi.advanceTimersByTime(50));
    expect(Number(track?.style.getPropertyValue('--lyrics-track-progress'))).toBeGreaterThan(progressAfterSmallCorrection);
    unmount();
    vi.useRealTimers();
  });

  it('freezes an in-flight handoff while paused and resumes from the same sample', () => {
    vi.useFakeTimers();
    const lines = [
      { id: 'a', startMs: 0, text: 'Freeze first line' },
      { id: 'b', startMs: 1_000, text: 'Freeze second line' },
    ];
    const { container, rerender, unmount } = render(
      <LyricsStage
        lines={lines}
        elapsedMs={0}
        offsetMs={0}
        playbackStatus="playing"
        durationMs={10_000}
        clockRevision={1}
      />,
    );

    act(() => vi.advanceTimersByTime(850));
    const track = container.querySelector<HTMLElement>('.am-lyrics-track');
    rerender(
      <LyricsStage
        lines={lines}
        elapsedMs={850}
        offsetMs={0}
        playbackStatus="paused"
        durationMs={10_000}
        clockRevision={2}
      />,
    );
    const frozenProgress = track?.style.getPropertyValue('--lyrics-track-progress');
    const frozenTransform = track?.style.transform;
    const frozenOpacity = lyricLine('Freeze first line').style.getPropertyValue('--lyric-opacity');

    act(() => vi.advanceTimersByTime(500));
    expect(track?.style.getPropertyValue('--lyrics-track-progress')).toBe(frozenProgress);
    expect(track?.style.transform).toBe(frozenTransform);
    expect(lyricLine('Freeze first line').style.getPropertyValue('--lyric-opacity')).toBe(frozenOpacity);

    rerender(
      <LyricsStage
        lines={lines}
        elapsedMs={850}
        offsetMs={0}
        playbackStatus="playing"
        durationMs={10_000}
        clockRevision={3}
      />,
    );
    act(() => vi.advanceTimersByTime(50));
    expect(Number(track?.style.getPropertyValue('--lyrics-track-progress'))).toBeGreaterThan(Number(frozenProgress));
    unmount();
    vi.useRealTimers();
  });

  it('schedules the next handoff on corrected media time instead of wall time', () => {
    vi.useFakeTimers();
    const lines = [
      { id: 'a', startMs: 0, text: 'Corrected first line' },
      { id: 'b', startMs: 2_000, text: 'Corrected second line' },
    ];
    const { rerender, unmount } = render(
      <LyricsStage
        lines={lines}
        elapsedMs={0}
        offsetMs={0}
        playbackStatus="playing"
        durationMs={10_000}
        clockRevision={1}
      />,
    );

    act(() => vi.advanceTimersByTime(800));
    expect(lyricLine('Corrected first line')).toHaveAttribute('data-state', 'active');
    rerender(
      <LyricsStage
        lines={lines}
        elapsedMs={1_100}
        offsetMs={0}
        playbackStatus="playing"
        durationMs={10_000}
        clockRevision={2}
      />,
    );

    act(() => vi.advanceTimersByTime(445));
    expect(lyricLine('Corrected first line')).toHaveAttribute('data-state', 'active');
    act(() => vi.advanceTimersByTime(3));
    expect(lyricLine('Corrected first line')).toHaveAttribute('data-state', 'outgoing');
    expect(lyricLine('Corrected second line')).toHaveAttribute('data-state', 'incoming');
    unmount();
    vi.useRealTimers();
  });

  it('honors a same-value telemetry revision as a hard backward seek', () => {
    vi.useFakeTimers();
    const lines = [
      { id: 'a', startMs: 0, text: 'Seek first line' },
      { id: 'b', startMs: 1_000, text: 'Seek second line' },
    ];
    const { rerender, unmount } = render(
      <LyricsStage
        lines={lines}
        elapsedMs={0}
        offsetMs={0}
        playbackStatus="playing"
        durationMs={10_000}
        clockRevision={1}
      />,
    );

    act(() => vi.advanceTimersByTime(850));
    expect(lyricLine('Seek second line')).toHaveAttribute('data-state', 'incoming');
    rerender(
      <LyricsStage
        lines={lines}
        elapsedMs={0}
        offsetMs={0}
        playbackStatus="playing"
        durationMs={10_000}
        clockRevision={2}
      />,
    );
    expect(lyricLine('Seek first line')).toHaveAttribute('data-state', 'active');
    expect(lyricLine('Seek second line')).toHaveAttribute('data-state', 'next');
    unmount();
    vi.useRealTimers();
  });

  it('does not start a new track transition while paused in a handoff window', () => {
    const lines = [
      { id: 'a', startMs: 0, text: 'Paused first line' },
      { id: 'b', startMs: 1_000, text: 'Paused second line' },
    ];
    const { container, rerender } = render(
      <LyricsStage
        lines={lines}
        elapsedMs={0}
        offsetMs={0}
        playbackStatus="paused"
        durationMs={10_000}
      />,
    );

    rerender(
      <LyricsStage
        lines={lines}
        elapsedMs={850}
        offsetMs={0}
        playbackStatus="paused"
        durationMs={10_000}
      />,
    );

    const track = container.querySelector<HTMLElement>('.am-lyrics-track');
    expect(lyricLine('Paused first line')).toHaveAttribute('data-state', 'outgoing');
    expect(lyricLine('Paused second line')).toHaveAttribute('data-state', 'incoming');
    expect(track).not.toHaveClass('is-animated');
    expect(Number(track?.style.getPropertyValue('--lyrics-track-progress'))).toBeGreaterThan(0);
    expect(Number(track?.style.getPropertyValue('--lyrics-track-progress'))).toBeLessThan(1);
  });

  it('previews only the first line before lyrics begin', () => {
    render(
      <LyricsStage
        lines={[
          { id: 'a', startMs: 1_000, text: 'First preview line' },
          { id: 'b', startMs: 2_000, text: 'Later line' },
        ]}
        elapsedMs={0}
        offsetMs={0}
        playbackStatus="paused"
        durationMs={10_000}
      />,
    );

    expect(lyricLine('First preview line')).toHaveAttribute('data-state', 'next');
    expect(lyricLine('Later line')).toHaveAttribute('data-state', 'future');
  });

  it('marks every equal-timestamp lyric as current', () => {
    render(
      <LyricsStage
        lines={[
          { id: 'a', startMs: 0, text: 'Lead line' },
          { id: 'b', startMs: 1_000, text: 'Harmony line' },
          { id: 'c', startMs: 1_000, text: 'Main line' },
        ]}
        elapsedMs={1_000}
        offsetMs={0}
        playbackStatus="paused"
        durationMs={10_000}
      />,
    );

    expect(lyricLine('Harmony line')).toHaveAttribute('aria-current', 'true');
    expect(lyricLine('Harmony line')).toHaveAttribute('data-state', 'active');
    expect(lyricLine('Main line')).toHaveAttribute('aria-current', 'true');
    expect(lyricLine('Main line')).toHaveAttribute('data-state', 'active');
  });

  it('centers an equal-timestamp group as one visual cue', () => {
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function getClientHeight(this: HTMLElement) {
        return this.classList.contains('am-lyrics-rail') ? 600 : 0;
      });
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function getClientWidth(this: HTMLElement) {
        return this.classList.contains('am-lyrics-rail') ? 1_000 : 0;
      });
    const offsetTop = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get')
      .mockImplementation(function getOffsetTop(this: HTMLElement) {
        if (this.textContent === 'Harmony centered') return 200;
        if (this.textContent === 'Main centered') return 280;
        return 100;
      });
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function getOffsetHeight(this: HTMLElement) {
        if (this.textContent === 'Harmony centered') return 60;
        if (this.textContent === 'Main centered') return 100;
        return 80;
      });
    try {
      const { container } = render(
        <LyricsStage
          lines={[
            { id: 'a', startMs: 0, text: 'Lead centered' },
            { id: 'b', startMs: 1_000, text: 'Harmony centered' },
            { id: 'c', startMs: 1_000, text: 'Main centered' },
          ]}
          elapsedMs={1_000}
          offsetMs={0}
          playbackStatus="paused"
          durationMs={10_000}
        />,
      );

      expect(container.querySelector<HTMLElement>('.am-lyrics-track')?.style.transform)
        .toBe('translate3d(0, -50px, 0)');
    } finally {
      clientHeight.mockRestore();
      clientWidth.mockRestore();
      offsetTop.mockRestore();
      offsetHeight.mockRestore();
    }
  });

  it('snaps at the timestamp and removes depth effects with reduced motion', () => {
    installMatchMedia(true);
    const lines = [
      { id: 'a', startMs: 0, text: 'Reduced first line' },
      { id: 'b', startMs: 1_000, text: 'Reduced second line' },
    ];
    const { container, rerender } = render(
      <LyricsStage
        lines={lines}
        elapsedMs={850}
        offsetMs={0}
        playbackStatus="paused"
        durationMs={10_000}
      />,
    );

    expect(container.querySelector('.am-lyrics-rail')).toHaveAttribute('data-reduced-motion', 'true');
    expect(lyricLine('Reduced first line')).toHaveAttribute('data-state', 'active');
    expect(lyricLine('Reduced first line')).toHaveAttribute('aria-current', 'true');
    expect(lyricLine('Reduced second line')).toHaveAttribute('data-state', 'next');
    expect(lyricLine('Reduced first line').style.getPropertyValue('--lyric-filter')).toBe('none');
    expect(lyricLine('Reduced first line').style.getPropertyValue('--lyric-scale')).toBe('1');

    rerender(
      <LyricsStage
        lines={lines}
        elapsedMs={1_000}
        offsetMs={0}
        playbackStatus="paused"
        durationMs={10_000}
      />,
    );
    expect(lyricLine('Reduced second line')).toHaveAttribute('aria-current', 'true');
    expect(lyricLine('Reduced second line')).toHaveAttribute('data-state', 'active');
  });

  it('does not schedule another lyric event after the song ends with a negative offset', () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(window, 'setTimeout');

    render(
      <LyricsStage
        lines={[
          { id: 'a', startMs: 10_000, text: 'Closing line' },
        ]}
        elapsedMs={20_000}
        offsetMs={-500}
        playbackStatus="playing"
        durationMs={20_000}
      />,
    );

    expect(lyricLine('Closing line')).not.toHaveAttribute('aria-current');
    expect(timeout).not.toHaveBeenCalled();
    timeout.mockRestore();
    vi.useRealTimers();
  });
});
