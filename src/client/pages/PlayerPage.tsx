import { Music2, Settings } from 'lucide-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';
import type {
  LyricLine,
  LyricsPayload,
  PlaybackStatus,
  PlayerSnapshot,
} from '../../shared/contracts.js';
import { lyricsLookupFingerprint } from '../../shared/track.js';
import {
  ambientFieldPalette,
  spatialFieldForSnapshot,
  type AmbientFieldPalette,
} from '../ambient-palette.js';
import { SpatialAmbientBackdrop } from '../SpatialAmbientBackdrop.js';
import { NavigationCard } from '../components/NavigationCard.js';
import { usePlayer } from '../hooks/usePlayer.js';
import {
  analyzeLyricText,
  type LyricTextAnalysis,
} from '../lyric-script.js';
import {
  computeLyricFrame,
  lyricGroupEnd,
  type LyricFrame,
} from '../lyrics-motion.js';
import {
  lyricTrackProgress,
  lyricVisualNeedsAnimation,
  resolveLyricLineVisual,
} from '../lyrics-visual.js';

const AMBIENT_CROSSFADE_MS = 1_400;
const CJK_FONT_REVEAL_TIMEOUT_MS = 900;

function LyricTextContent({ analysis }: { analysis: LyricTextAnalysis }) {
  if (analysis.script === 'latin' || analysis.script === 'neutral') {
    return analysis.runs.map((run) => run.text).join('');
  }
  return analysis.runs.map((run, index) => (
    <span
      className="am-lyric-script"
      data-script={run.script}
      lang={run.language}
      key={`${run.script}-${index}`}
    >
      {run.text}
    </span>
  ));
}

export function AmbientBackdrop({ colors }: { colors: AmbientFieldPalette }) {
  const [layers, setLayers] = useState<[AmbientFieldPalette, AmbientFieldPalette]>(() => [colors, colors]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [transitionIndex, setTransitionIndex] = useState<number | null>(null);
  const [transitionVisible, setTransitionVisible] = useState(false);
  const activeIndexRef = useRef(0);
  const transitionIndexRef = useRef<number | null>(null);
  const targetColorKeyRef = useRef(colors.key);
  const pendingColorsRef = useRef<AmbientFieldPalette | null>(null);
  const frameRef = useRef(0);
  const timerRef = useRef(0);
  const colorKey = colors.key;

  const beginTransition = useCallback(function begin(nextColors: AmbientFieldPalette): void {
    const nextIndex = activeIndexRef.current === 0 ? 1 : 0;
    targetColorKeyRef.current = nextColors.key;
    transitionIndexRef.current = nextIndex;
    setLayers((current) => current.map((layer, index) =>
      index === nextIndex ? nextColors : layer,
    ) as [AmbientFieldPalette, AmbientFieldPalette]);
    setTransitionIndex(nextIndex);
    setTransitionVisible(false);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const reveal = () => {
      setTransitionVisible(true);
      timerRef.current = window.setTimeout(() => {
        activeIndexRef.current = nextIndex;
        transitionIndexRef.current = null;
        setActiveIndex(nextIndex);
        setTransitionIndex(null);
        setTransitionVisible(false);
        const pendingColors = pendingColorsRef.current;
        pendingColorsRef.current = null;
        if (pendingColors && pendingColors.key !== nextColors.key) {
          begin(pendingColors);
        }
      }, reducedMotion ? 0 : AMBIENT_CROSSFADE_MS);
    };
    frameRef.current = window.requestAnimationFrame(() => {
      if (reducedMotion) {
        reveal();
        return;
      }
      frameRef.current = window.requestAnimationFrame(reveal);
    });
  }, []);

  useEffect(() => {
    if (colorKey === targetColorKeyRef.current) {
      pendingColorsRef.current = null;
      return;
    }
    if (transitionIndexRef.current !== null) {
      pendingColorsRef.current = colors;
      return;
    }
    beginTransition(colors);
  }, [beginTransition, colorKey, colors]);

  useEffect(() => () => {
    window.cancelAnimationFrame(frameRef.current);
    window.clearTimeout(timerRef.current);
  }, []);

  return (
    <div className="am-ambient" aria-hidden="true">
      {layers.map((layer, index) => (
        <span
          className={[
            'ambient-palette-layer',
            index === activeIndex ? 'is-active' : '',
            index === transitionIndex ? 'is-transitioning' : '',
            index === transitionIndex && transitionVisible ? 'is-visible' : '',
          ].filter(Boolean).join(' ')}
          key={index}
          style={{
            '--palette-one-rgb': layer.primary,
            '--palette-two-rgb': layer.secondary,
            '--palette-bridge-rgb': layer.bridge,
            '--field-primary-alpha': layer.primaryAlpha,
            '--field-secondary-alpha': layer.secondaryAlpha,
            '--field-bridge-alpha': layer.bridgeAlpha,
            '--field-cycle-a': layer.cycleA,
            '--field-cycle-b': layer.cycleB,
            '--field-delay-a': layer.delayA,
            '--field-delay-b': layer.delayB,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}

function sameFrame(left: LyricFrame, right: LyricFrame): boolean {
  return left.anchorIndex === right.anchorIndex
    && left.anchorStartIndex === right.anchorStartIndex
    && left.focusIndex === right.focusIndex
    && left.focusStartIndex === right.focusStartIndex
    && left.incomingIndex === right.incomingIndex
    && left.incomingStartIndex === right.incomingStartIndex
    && left.outgoingIndex === right.outgoingIndex
    && left.outgoingStartIndex === right.outgoingStartIndex
    && left.outgoingStartsFocused === right.outgoingStartsFocused
    && left.phase === right.phase
    && left.phaseStartMs === right.phaseStartMs
    && left.phaseEndMs === right.phaseEndMs
    && left.activeStartMs === right.activeStartMs
    && left.activeEndMs === right.activeEndMs
    && left.focusImpactMs === right.focusImpactMs
    && left.nextEventMs === right.nextEventMs;
}

type LineState = 'active' | 'incoming' | 'outgoing' | 'past' | 'next' | 'future';

interface LyricsGeometry {
  railHeight: number;
  focusY: number;
  tops: number[];
  heights: number[];
  centers: number[];
}

interface VisualSample {
  frame: LyricFrame;
  lyricElapsedMs: number;
  reducedMotion: boolean;
}

interface TimelineFrameState {
  timelineKey: string;
  frame: LyricFrame;
}

interface MediaClock {
  baseElapsedMs: number;
  baseTimeMs: number;
  correctionMs: number;
  running: boolean;
}

interface MediaClockReport {
  elapsedMs: number;
  playbackStatus: PlaybackStatus;
  revision: number | undefined;
}

const CLOCK_SEEK_THRESHOLD_MS = 350;
const CLOCK_CORRECTION_WINDOW_MS = 1_000;

function sampleMediaClock(clock: MediaClock, nowMs: number): number {
  if (!clock.running) return clock.baseElapsedMs;
  const advancedMs = Math.max(0, nowMs - clock.baseTimeMs);
  const correctionProgress = Math.min(1, advancedMs / CLOCK_CORRECTION_WINDOW_MS);
  return clock.baseElapsedMs + advancedMs + clock.correctionMs * correctionProgress;
}

function rebaseMediaClock(
  clock: MediaClock,
  reportedElapsedMs: number,
  running: boolean,
  nowMs: number,
): MediaClock {
  const predictedElapsedMs = sampleMediaClock(clock, nowMs);
  const driftMs = reportedElapsedMs - predictedElapsedMs;
  if (clock.running !== running || !running || Math.abs(driftMs) > CLOCK_SEEK_THRESHOLD_MS) {
    return {
      baseElapsedMs: reportedElapsedMs,
      baseTimeMs: nowMs,
      correctionMs: 0,
      running,
    };
  }
  return {
    baseElapsedMs: predictedElapsedMs,
    baseTimeMs: nowMs,
    correctionMs: driftMs,
    running,
  };
}

function wallDelayForMediaDelta(
  clock: MediaClock,
  nowMs: number,
  mediaDeltaMs: number,
): number {
  const mediaDelta = Math.max(0, mediaDeltaMs);
  if (!clock.running || clock.correctionMs === 0) return mediaDelta;
  const advancedMs = Math.max(0, nowMs - clock.baseTimeMs);
  const correctionWallMs = Math.max(0, CLOCK_CORRECTION_WINDOW_MS - advancedMs);
  if (correctionWallMs === 0) return mediaDelta;
  const correctionRate = 1 + clock.correctionMs / CLOCK_CORRECTION_WINDOW_MS;
  const correctedMediaCapacityMs = correctionWallMs * correctionRate;
  if (mediaDelta <= correctedMediaCapacityMs) return mediaDelta / correctionRate;
  return correctionWallMs + mediaDelta - correctedMediaCapacityMs;
}

function lyricTimelineKey(lines: LyricLine[]): string {
  return lines
    .map((line) => `${line.id}\u001f${line.startMs}\u001f${line.text}`)
    .join('\u001e');
}

function lyricPayloadViewKey(lyrics: LyricsPayload): string {
  return [
    lyrics.kind,
    lyricTimelineKey(lyrics.lines),
    lyrics.notice ?? '',
    lyrics.retryable ? 'retryable' : '',
  ].join('\u001d');
}

function hasUsableLyrics(lyrics: LyricsPayload): boolean {
  return (lyrics.kind === 'synced' || lyrics.kind === 'plain')
    && lyrics.lines.length > 0;
}

function finiteGeneration(value: number | undefined): number | null {
  return Number.isFinite(value) ? value! : null;
}

function isInRange(lineIndex: number, startIndex: number | null, endIndex: number | null): boolean {
  return startIndex !== null
    && endIndex !== null
    && lineIndex >= startIndex
    && lineIndex <= endIndex;
}

function lineState(lineIndex: number, frame: LyricFrame, lines: LyricLine[]): LineState {
  if (frame.phase === 'handoff' || frame.phase === 'settle') {
    if (isInRange(lineIndex, frame.incomingStartIndex, frame.incomingIndex)) return 'incoming';
    if (isInRange(lineIndex, frame.outgoingStartIndex, frame.outgoingIndex)) return 'outgoing';
  }
  if (isInRange(lineIndex, frame.focusStartIndex, frame.focusIndex)) {
    return 'active';
  }
  if (frame.phase === 'preroll') {
    if (isInRange(lineIndex, frame.incomingStartIndex, frame.incomingIndex)) return 'incoming';
    return isInRange(lineIndex, frame.anchorStartIndex, frame.anchorIndex) ? 'next' : 'future';
  }
  if (lineIndex <= frame.anchorIndex) return 'past';
  const nextStartIndex = frame.anchorIndex + 1;
  if (
    nextStartIndex < lines.length
    && lineIndex <= lyricGroupEnd(lines, nextStartIndex)
  ) return 'next';
  return 'future';
}

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(query);
    const update = () => setReducedMotion(media.matches);
    update();
    if (typeof media.addEventListener === 'function') media.addEventListener('change', update);
    else media.addListener?.(update);
    return () => {
      if (typeof media.removeEventListener === 'function') media.removeEventListener('change', update);
      else media.removeListener?.(update);
    };
  }, []);

  return reducedMotion;
}

function groupCenter(geometry: LyricsGeometry, startIndex: number, endIndex: number): number {
  const top = geometry.tops[Math.max(0, startIndex)] ?? 0;
  const safeEnd = Math.max(0, endIndex);
  const bottom = (geometry.tops[safeEnd] ?? top) + (geometry.heights[safeEnd] ?? 0);
  return (top + bottom) / 2;
}

function rounded(value: number, precision = 3): string {
  return String(Number(value.toFixed(precision)));
}

export function LyricsStage({
  lines,
  elapsedMs,
  offsetMs,
  playbackStatus,
  durationMs,
  clockRevision,
}: {
  lines: LyricLine[];
  elapsedMs: number;
  offsetMs: number;
  playbackStatus: PlaybackStatus;
  durationMs: number;
  clockRevision?: number;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Array<HTMLDivElement | null>>([]);
  const reducedMotion = useReducedMotion();
  const positionedRef = useRef(false);
  const geometryRef = useRef<LyricsGeometry | null>(null);
  const visualCacheRef = useRef<string[]>([]);
  const trackVisualCacheRef = useRef('');
  const applyVisualRef = useRef<(sample: VisualSample, full?: boolean) => void>(() => undefined);
  const clockRef = useRef<MediaClock>({
    baseElapsedMs: elapsedMs,
    baseTimeMs: performance.now(),
    correctionMs: 0,
    running: playbackStatus === 'playing',
  });
  const clockReportRef = useRef<MediaClockReport>({
    elapsedMs,
    playbackStatus,
    revision: clockRevision,
  });
  const timelineKey = lyricTimelineKey(lines);
  const stableTimeline = useRef({ key: timelineKey, lines });
  if (stableTimeline.current.key !== timelineKey) {
    stableTimeline.current = { key: timelineKey, lines };
  }
  const textAnalyses = useMemo(
    () => stableTimeline.current.lines.map((line) => analyzeLyricText(line.text)),
    [timelineKey],
  );
  const [frameState, setFrameState] = useState<TimelineFrameState>(() => ({
    timelineKey,
    frame: computeLyricFrame(
      stableTimeline.current.lines,
      elapsedMs,
      offsetMs,
      durationMs,
      { reducedMotion },
    ),
  }));
  const timelineChanged = frameState.timelineKey !== timelineKey;
  const frame = timelineChanged
    ? computeLyricFrame(
        stableTimeline.current.lines,
        elapsedMs,
        offsetMs,
        durationMs,
        { reducedMotion },
      )
    : frameState.frame;
  const [positioned, setPositioned] = useState(false);
  const semanticFrameRef = useRef(frame);
  const visualSampleRef = useRef<VisualSample>({
    frame,
    lyricElapsedMs: elapsedMs + offsetMs,
    reducedMotion,
  });

  if (timelineChanged) {
    // React immediately retries this component render, so the new timeline's
    // frame and clock are established before its DOM reaches layout/paint.
    setFrameState({ timelineKey, frame });
    const nowMs = performance.now();
    clockRef.current = {
      baseElapsedMs: elapsedMs,
      baseTimeMs: nowMs,
      correctionMs: 0,
      running: playbackStatus === 'playing',
    };
    clockReportRef.current = {
      elapsedMs,
      playbackStatus,
      revision: clockRevision,
    };
    semanticFrameRef.current = frame;
    visualSampleRef.current = {
      frame,
      lyricElapsedMs: elapsedMs + offsetMs,
      reducedMotion,
    };
    geometryRef.current = null;
    visualCacheRef.current = [];
    trackVisualCacheRef.current = '';
  }

  applyVisualRef.current = (sample, full = false) => {
    const geometry = geometryRef.current;
    const lyricsTrack = track.current;
    if (!geometry || !lyricsTrack) return;

    const { frame: visualFrame, lyricElapsedMs, reducedMotion: reduceMotion } = sample;
    const targetY = (startIndex: number, endIndex: number) =>
      geometry.focusY - groupCenter(geometry, startIndex, endIndex);
    let trackProgress = 1;
    let trackY = targetY(visualFrame.anchorStartIndex, visualFrame.anchorIndex);
    if (
      visualFrame.phase === 'handoff'
      && visualFrame.outgoingStartIndex !== null
      && visualFrame.outgoingIndex !== null
      && visualFrame.incomingStartIndex !== null
      && visualFrame.incomingIndex !== null
    ) {
      trackProgress = lyricTrackProgress(visualFrame, lyricElapsedMs);
      const fromY = targetY(visualFrame.outgoingStartIndex, visualFrame.outgoingIndex);
      const toY = targetY(visualFrame.incomingStartIndex, visualFrame.incomingIndex);
      trackY = fromY + (toY - fromY) * trackProgress;
    }

    const trackVisualKey = `${rounded(trackY, 2)}:${rounded(trackProgress, 4)}`;
    if (trackVisualCacheRef.current !== trackVisualKey) {
      trackVisualCacheRef.current = trackVisualKey;
      lyricsTrack.style.transform = `translate3d(0, ${rounded(trackY, 2)}px, 0)`;
      lyricsTrack.style.setProperty('--lyrics-track-progress', rounded(trackProgress, 4));
    }

    const anchorIndices = [
      visualFrame.anchorStartIndex,
      visualFrame.anchorIndex,
      visualFrame.focusStartIndex,
      visualFrame.focusIndex,
      visualFrame.incomingStartIndex,
      visualFrame.incomingIndex,
      visualFrame.outgoingStartIndex,
      visualFrame.outgoingIndex,
    ].filter((index): index is number => index !== null && index >= 0);
    const overscan = 4;
    const startIndex = full || anchorIndices.length === 0
      ? 0
      : Math.max(0, Math.min(...anchorIndices) - overscan);
    const endIndex = full || anchorIndices.length === 0
      ? stableTimeline.current.lines.length - 1
      : Math.min(stableTimeline.current.lines.length - 1, Math.max(...anchorIndices) + overscan);

    for (let lineIndex = startIndex; lineIndex <= endIndex; lineIndex += 1) {
      const line = lineRefs.current[lineIndex];
      if (!line) continue;
      const screenCenter = (geometry.centers[lineIndex] ?? 0) + trackY;
      const normalizedDistance = Math.abs(screenCenter - geometry.focusY) / geometry.railHeight;
      const direction = visualFrame.phase === 'preroll'
        || isInRange(lineIndex, visualFrame.incomingStartIndex, visualFrame.incomingIndex)
        || lineIndex > visualFrame.anchorIndex
        ? 'future'
        : 'past';
      const visual = resolveLyricLineVisual({
        frame: visualFrame,
        lineIndex,
        lyricElapsedMs,
        normalizedDistance,
        direction,
        reducedMotion: reduceMotion,
      });
      const opacity = rounded(visual.opacity);
      const blurPx = Math.round(visual.blurPx * 20) / 20;
      const filter = blurPx >= 0.05 ? `blur(${rounded(blurPx, 2)}px)` : 'none';
      const scale = rounded(visual.scale, 4);
      const translateYPx = rounded(visual.translateYPx, 2);
      const glowAlpha = rounded(visual.glowAlpha, 2);
      const glowRadiusPx = rounded(visual.glowRadiusPx, 0);
      const visualKey = [
        opacity,
        filter,
        scale,
        translateYPx,
        glowAlpha,
        glowRadiusPx,
      ].join(':');
      if (visualCacheRef.current[lineIndex] === visualKey) continue;
      visualCacheRef.current[lineIndex] = visualKey;
      line.style.setProperty('--lyric-opacity', opacity);
      line.style.setProperty('--lyric-filter', filter);
      line.style.setProperty('--lyric-scale', scale);
      line.style.setProperty('--lyric-y', `${translateYPx}px`);
      line.style.setProperty('--lyric-glow-alpha', glowAlpha);
      line.style.setProperty('--lyric-glow-radius', `${glowRadiusPx}px`);
    }
  };

  useEffect(() => {
    const timeline = stableTimeline.current;
    const nextReport = { elapsedMs, playbackStatus, revision: clockRevision };
    const previousReport = clockReportRef.current;
    if (
      nextReport.elapsedMs !== previousReport.elapsedMs
      || nextReport.playbackStatus !== previousReport.playbackStatus
      || nextReport.revision !== previousReport.revision
    ) {
      const nowMs = performance.now();
      clockRef.current = rebaseMediaClock(
        clockRef.current,
        elapsedMs,
        playbackStatus === 'playing',
        nowMs,
      );
      clockReportRef.current = nextReport;
    }
    let timer = 0;
    let animationFrame = 0;
    let disposed = false;
    const cancelScheduledUpdate = () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(animationFrame);
    };
    const update = () => {
      if (disposed) return;
      cancelScheduledUpdate();
      const running = playbackStatus === 'playing';
      const nowMs = performance.now();
      const currentElapsedMs = Math.min(
        durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY,
        sampleMediaClock(clockRef.current, nowMs),
      );
      const nextFrame = computeLyricFrame(
        timeline.lines,
        currentElapsedMs,
        offsetMs,
        durationMs,
        { reducedMotion },
      );
      const lyricElapsedMs = currentElapsedMs + offsetMs;
      const frameChanged = !sameFrame(semanticFrameRef.current, nextFrame);
      semanticFrameRef.current = nextFrame;
      const sample = { frame: nextFrame, lyricElapsedMs, reducedMotion };
      visualSampleRef.current = sample;
      applyVisualRef.current(sample, frameChanged);
      setFrameState((current) =>
        current.timelineKey === timelineKey && sameFrame(current.frame, nextFrame)
          ? current
          : { timelineKey, frame: nextFrame },
      );
      if (
        running
        && document.visibilityState !== 'hidden'
      ) {
        if (!reducedMotion && lyricVisualNeedsAnimation(nextFrame, lyricElapsedMs)) {
          const untilNextEventMs = nextFrame.nextEventMs === null
            ? Number.POSITIVE_INFINITY
            : nextFrame.nextEventMs - lyricElapsedMs;
          const wallUntilNextEventMs = wallDelayForMediaDelta(
            clockRef.current,
            nowMs,
            untilNextEventMs,
          );
          if (untilNextEventMs > 0 && wallUntilNextEventMs <= 17) {
            timer = window.setTimeout(update, Math.max(1, wallUntilNextEventMs + 1));
          } else {
            animationFrame = window.requestAnimationFrame(update);
          }
        } else if (nextFrame.nextEventMs !== null) {
          const mediaDeltaMs = nextFrame.nextEventMs - lyricElapsedMs;
          const delayMs = Math.max(
            1,
            wallDelayForMediaDelta(clockRef.current, nowMs, mediaDeltaMs) + 1,
          );
          timer = window.setTimeout(update, delayMs);
        }
      }
    };
    const handleVisibility = () => update();
    update();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      disposed = true;
      cancelScheduledUpdate();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [clockRevision, durationMs, elapsedMs, offsetMs, playbackStatus, reducedMotion, timelineKey]);

  useLayoutEffect(() => {
    const container = rail.current;
    const lyricsTrack = track.current;
    if (!container || !lyricsTrack) return;

    let disposed = false;
    let animationFrame = 0;
    let revealTimer = 0;
    const waitsForCjkFont = textAnalyses.some((analysis) =>
      analysis.script === 'cjk' || analysis.script === 'mixed',
    );
    let canReveal = !waitsForCjkFont || typeof document.fonts === 'undefined';
    const measure = (reveal: boolean) => {
      if (disposed) return;
      const railHeight = Math.max(1, container.clientHeight);
      const narrowViewport = container.clientWidth > 0 && container.clientWidth <= 760;
      const focusY = railHeight * (narrowViewport ? 0.38 : 0.4);
      const tops = stableTimeline.current.lines.map((_, index) => lineRefs.current[index]?.offsetTop ?? 0);
      const heights = stableTimeline.current.lines.map((_, index) => lineRefs.current[index]?.offsetHeight ?? 0);
      geometryRef.current = {
        railHeight,
        focusY,
        tops,
        heights,
        centers: tops.map((top, index) => top + (heights[index] ?? 0) / 2),
      };
      visualCacheRef.current = [];
      trackVisualCacheRef.current = '';
      applyVisualRef.current(visualSampleRef.current, true);
      if (reveal && !positionedRef.current) {
        positionedRef.current = true;
        setPositioned(true);
      }
    };
    const handleResize = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => measure(canReveal));
    };
    measure(canReveal);
    window.addEventListener('resize', handleResize);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(handleResize);
    observer?.observe(container);
    observer?.observe(lyricsTrack);
    if (!canReveal) {
      revealTimer = window.setTimeout(() => {
        canReveal = true;
        measure(true);
      }, CJK_FONT_REVEAL_TIMEOUT_MS);
    }
    void document.fonts?.ready.then(() => {
      canReveal = true;
      window.clearTimeout(revealTimer);
      measure(true);
    });
    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(revealTimer);
      window.removeEventListener('resize', handleResize);
      observer?.disconnect();
    };
  }, [textAnalyses, timelineKey]);

  return (
    <div
      className="am-lyrics-rail"
      data-phase={frame.phase}
      data-running={playbackStatus === 'playing' ? 'true' : 'false'}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      ref={rail}
    >
      <div
        className={`am-lyrics-track ${frame.phase === 'handoff' && playbackStatus === 'playing' && !reducedMotion ? 'is-animated' : ''} ${positioned ? 'is-positioned' : ''}`}
        ref={track}
      >
        <div className="am-lyrics-spacer" />
        {stableTimeline.current.lines.map((line, lineIndex) => {
          const state = lineState(lineIndex, frame, stableTimeline.current.lines);
          const isCurrent = isInRange(lineIndex, frame.focusStartIndex, frame.focusIndex);
          const textAnalysis = textAnalyses[lineIndex] ?? analyzeLyricText(line.text);
          return (
            <div
              className={`am-lyric-line ${state === 'active' ? 'is-active' : ''}`}
              data-script={textAnalysis.script}
              data-state={state}
              aria-current={isCurrent ? 'true' : undefined}
              key={line.id}
              ref={(node) => {
                lineRefs.current[lineIndex] = node;
              }}
            >
              <span className="am-lyric-text"><LyricTextContent analysis={textAnalysis} /></span>
            </div>
          );
        })}
        <div className="am-lyrics-spacer" />
      </div>
    </div>
  );
}

function EmptyLyrics({ snapshot }: { snapshot: PlayerSnapshot }) {
  const loading = snapshot.lyrics.kind === 'loading';
  const waitingForTrack = !snapshot.track?.title;
  return (
    <div className="am-empty-lyrics" role="status">
      <Music2 size={38} strokeWidth={1.5} />
      <h2>{loading ? '正在载入歌词…' : waitingForTrack ? '等待播放' : '暂时没有同步歌词'}</h2>
      <p>{snapshot.lyrics.notice ?? '可以在设置页为当前歌曲粘贴 LRC。'}</p>
      {!loading && !waitingForTrack && <Link className="am-empty-action" to="/setup">在设置中添加 LRC</Link>}
    </div>
  );
}

function StableLyricsView({
  snapshot,
  elapsedMs,
}: {
  snapshot: PlayerSnapshot;
  elapsedMs: number;
}) {
  const incomingLyrics = snapshot.lyrics;
  const incomingViewKey = lyricPayloadViewKey(incomingLyrics);
  const trackGeneration = finiteGeneration(snapshot.trackGeneration);
  const lyricsGeneration = finiteGeneration(snapshot.lyricsGeneration);
  const hasGenerationPair = trackGeneration !== null && lyricsGeneration !== null;
  const incomingTrackKey = trackGeneration === null
    ? snapshot.track ? lyricsLookupFingerprint(snapshot.track) : ''
    : `generation:${trackGeneration}`;
  const incomingLyricsTrackKey = hasGenerationPair
    ? `generation:${lyricsGeneration}`
    : incomingTrackKey;
  const lyricsAreCurrent = !hasGenerationPair || trackGeneration === lyricsGeneration;
  const lyricsTrackMatchesCurrent = snapshot.lyricsTrackMatchesCurrent !== false;
  const [displayed, setDisplayed] = useState(() => ({
    lyrics: incomingLyrics,
    trackKey: incomingLyricsTrackKey,
  }));
  const displayedViewKey = lyricPayloadViewKey(displayed.lyrics);
  const trackChanged = displayed.trackKey !== incomingTrackKey;
  const viewChanged = displayedViewKey !== incomingViewKey;
  const retainsUsableLyrics = hasUsableLyrics(displayed.lyrics);
  const retainsDuringLoading = lyricsTrackMatchesCurrent
    && incomingLyrics.kind === 'loading'
    && retainsUsableLyrics;
  const sawLoadingRef = useRef(false);
  const generationIsReady = hasGenerationPair && lyricsAreCurrent && trackChanged;
  const shouldCommitIncoming = lyricsAreCurrent
    && !retainsDuringLoading
    && (
      viewChanged
      || sawLoadingRef.current
      || generationIsReady
      || (!retainsUsableLyrics && trackChanged)
    );
  const presentationIsCurrent = lyricsAreCurrent && !trackChanged && !viewChanged;
  const incomingTiming = {
    elapsedMs,
    offsetMs: snapshot.manualOffsetMs,
    playbackStatus: snapshot.playbackStatus,
    durationMs: snapshot.track?.durationMs ?? 0,
    clockRevision: snapshot.snapshotRevision ?? snapshot.capturedAtMs,
  };
  const playbackClockReady = snapshot.playbackClockReady !== false;
  const safeIncomingTiming = playbackClockReady
    ? incomingTiming
    : {
        ...incomingTiming,
        // Keep synced lyrics in an explicit preroll state. Zero would falsely
        // claim that the new track is at its first timestamp.
        elapsedMs: -incomingTiming.offsetMs - 1,
        playbackStatus: 'paused' as const,
      };
  const frozenTimingRef = useRef(safeIncomingTiming);

  useLayoutEffect(() => {
    // Fleet Telemetry publishes one track as a metadata burst, followed by
    // loading and the resolved lyrics. Once identity starts changing, freeze
    // the useful timeline until the replacement can be committed as one
    // presentation. The retained clock is paused below so animation state
    // from the previous track cannot keep advancing.
    if (retainsDuringLoading) {
      if (lyricsAreCurrent) sawLoadingRef.current = true;
      return;
    }
    if (shouldCommitIncoming) {
      sawLoadingRef.current = false;
      setDisplayed({
        lyrics: incomingLyrics,
        trackKey: incomingTrackKey,
      });
      return;
    }
    if (presentationIsCurrent) {
      sawLoadingRef.current = false;
      frozenTimingRef.current = safeIncomingTiming;
    }
  }, [
    incomingLyrics,
    incomingTrackKey,
    incomingViewKey,
    lyricsAreCurrent,
    presentationIsCurrent,
    retainsDuringLoading,
    shouldCommitIncoming,
    safeIncomingTiming.clockRevision,
    safeIncomingTiming.durationMs,
    safeIncomingTiming.elapsedMs,
    safeIncomingTiming.offsetMs,
    safeIncomingTiming.playbackStatus,
  ]);

  const displayedLyrics = lyricsTrackMatchesCurrent
    ? displayed.lyrics
    : {
        kind: 'loading' as const,
        lines: [],
        provider: null,
      };
  const timing = presentationIsCurrent
    ? safeIncomingTiming
    : {
        ...frozenTimingRef.current,
        playbackStatus: 'paused' as const,
      };

  const hasSyncedLyrics = displayedLyrics.kind === 'synced'
    && displayedLyrics.lines.length > 0;

  return (
    <div className="am-lyrics-view">
      {hasSyncedLyrics ? (
        <LyricsStage
          lines={displayedLyrics.lines}
          elapsedMs={timing.elapsedMs}
          offsetMs={timing.offsetMs}
          playbackStatus={timing.playbackStatus}
          durationMs={timing.durationMs}
          clockRevision={timing.clockRevision}
        />
      ) : displayedLyrics.kind === 'plain' && displayedLyrics.lines.length > 0 ? (
        <div className="am-plain-lyrics">
          {displayedLyrics.lines.map((line) => {
            const textAnalysis = analyzeLyricText(line.text);
            return (
              <p data-script={textAnalysis.script} key={line.id}>
                <LyricTextContent analysis={textAnalysis} />
              </p>
            );
          })}
        </div>
      ) : (
        <EmptyLyrics snapshot={{ ...snapshot, lyrics: displayedLyrics }} />
      )}
    </div>
  );
}

export function PlayerPage() {
  const {
    snapshot,
    elapsedMs,
    streamConnected,
    unauthorized,
    error,
  } = usePlayer();
  const ambientColors = useMemo(
    () => ambientFieldPalette(snapshot),
    [
      snapshot?.artworkPalette?.primary,
      snapshot?.artworkPalette?.secondary,
      snapshot?.track?.album,
      snapshot?.track?.artist,
      snapshot?.track?.title,
    ],
  );
  const artworkField = snapshot?.artworkPalette?.field;
  const artworkFieldColors = Array.isArray(artworkField?.colors)
    ? artworkField.colors.join(',')
    : '';
  const spatialField = useMemo(
    () => spatialFieldForSnapshot(snapshot, ambientColors),
    [
      ambientColors,
      artworkField?.schemaVersion,
      artworkField?.id,
      artworkField?.columns,
      artworkField?.rows,
      artworkField?.base,
      artworkFieldColors,
      snapshot?.artworkPalette?.source,
    ],
  );

  if (unauthorized) {
    return (
      <main className="centered-state">
        <div className="brand-mark">♪</div>
        <p className="eyebrow">屏幕尚未激活</p>
        <h1>在这块屏幕上打开设置</h1>
        <p>输入管理员 PIN，然后选择“激活此车机并打开歌词”。</p>
        <Link className="primary-button" to="/setup#vehicle-activation">打开设置</Link>
      </main>
    );
  }

  if (!snapshot || error) {
    return (
      <main className="centered-state">
        <div className="loading-road" aria-hidden="true"><span /></div>
        <p className="eyebrow">Awesome Lyrla</p>
        <h1>{error ?? '正在连接播放器'}</h1>
        <p>连接恢复后会自动继续。</p>
      </main>
    );
  }

  const connected = streamConnected && ['connected', 'demo'].includes(snapshot.connection);
  const connectionLabel = snapshot.mode === 'demo'
    ? '演示模式'
    : connected
      ? '实时同步'
      : snapshot.connection === 'offline'
        ? '连接中断 · 正在重连'
        : '等待车辆';
  return (
    <main
      className="am-player am-player--liquid-glass am-player--spatial-background"
      style={{
        '--lg-palette-primary': ambientColors.primary,
        '--lg-palette-secondary': ambientColors.secondary,
        '--lg-palette-bridge': ambientColors.bridge,
      } as CSSProperties}
    >
      <SpatialAmbientBackdrop field={spatialField} />

      <header className="am-toolbar">
        <div className="am-connection" role="status" title={snapshot.vehicleName}>
          <span className={`connection-dot ${connected ? 'is-online' : ''}`} />
          <span>{connectionLabel}</span>
        </div>
        <Link className="am-round-button" to="/setup" aria-label="打开歌词设置"><Settings size={21} /></Link>
      </header>

      <section className="am-lyrics-shell">
        <section className="am-lyrics-panel" aria-label="同步歌词">
          <StableLyricsView snapshot={snapshot} elapsedMs={elapsedMs} />
        </section>
      </section>

      {snapshot.navigation && <NavigationCard navigation={snapshot.navigation} />}
    </main>
  );
}
