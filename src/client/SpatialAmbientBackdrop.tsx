import {
  type CSSProperties,
  type TransitionEvent as ReactTransitionEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  paintSpatialField,
  SPATIAL_FIELD_CANVAS_HEIGHT,
  SPATIAL_FIELD_CANVAS_WIDTH,
  spatialFieldDriftPixels,
  spatialFieldFallbackPixels,
  spatialFieldFlowPixels,
  spatialFieldPixels,
  type SpatialColorField,
} from './spatial-field.js';
import type {
  SpatialTextureWorkerRequest,
  SpatialTextureWorkerResponse,
} from './spatial-texture-worker.js';

export const SPATIAL_CROSSFADE_MS = 1_400;
const SPATIAL_CROSSFADE_SAFETY_MS = 700;
const REDUCED_MOTION_CROSSFADE_MS = 0;
const TEXTURE_CACHE_LIMIT = 16;
const TEXTURE_PIXEL_LENGTH = SPATIAL_FIELD_CANVAS_WIDTH * SPATIAL_FIELD_CANVAS_HEIGHT * 4;
type SpatialFieldTextures = {
  base: Uint8ClampedArray;
  flow: Uint8ClampedArray;
  drift: Uint8ClampedArray;
};
type TextureListener = (textures: SpatialFieldTextures) => void;
type TextureJob = {
  field: SpatialColorField;
  key: string;
  listeners: Set<TextureListener>;
  worker: Worker | null;
  cancelScheduledWork: (() => void) | null;
  settled: boolean;
};
const textureCache = new Map<string, SpatialFieldTextures>();
const textureJobs = new Map<string, TextureJob>();
let textureRequestId = 0;

function fieldKey(field: SpatialColorField): string {
  return [
    'organic-bspline-v2',
    field.id,
    field.schemaVersion ?? 0,
    `${field.columns}x${field.rows}`,
    field.base,
    field.colors.join(','),
    field.cycleA ?? '',
    field.cycleB ?? '',
    field.cycleC ?? '',
    field.delayA ?? '',
    field.delayB ?? '',
    field.delayC ?? '',
  ].join(':');
}

function rgbChannels(value: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return '7 9 14';
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ].join(' ');
}

function reducedMotionEnabled(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function useReducedMotionPreference(): boolean {
  const [reducedMotion, setReducedMotion] = useState(reducedMotionEnabled);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return reducedMotion;
}

function cachedTextures(key: string): SpatialFieldTextures | null {
  const cached = textureCache.get(key);
  if (!cached) return null;
  textureCache.delete(key);
  textureCache.set(key, cached);
  return cached;
}

function cacheTextures(key: string, textures: SpatialFieldTextures): void {
  textureCache.set(key, textures);
  if (textureCache.size > TEXTURE_CACHE_LIMIT) {
    const oldest = textureCache.keys().next().value as string | undefined;
    if (oldest) textureCache.delete(oldest);
  }
}

function validTextures(textures: SpatialFieldTextures): boolean {
  return textures.base instanceof Uint8ClampedArray
    && textures.flow instanceof Uint8ClampedArray
    && textures.drift instanceof Uint8ClampedArray
    && textures.base.length === TEXTURE_PIXEL_LENGTH
    && textures.flow.length === TEXTURE_PIXEL_LENGTH
    && textures.drift.length === TEXTURE_PIXEL_LENGTH;
}

function scheduleTextureWork(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(callback, { timeout: 160 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 0);
  return () => window.clearTimeout(handle);
}

function stopTextureJob(job: TextureJob): void {
  job.cancelScheduledWork?.();
  job.cancelScheduledWork = null;
  if (job.worker) {
    job.worker.onmessage = null;
    job.worker.onerror = null;
    job.worker.onmessageerror = null;
    job.worker.terminate();
    job.worker = null;
  }
}

function settleTextureJob(job: TextureJob, textures: SpatialFieldTextures): void {
  if (job.settled || !validTextures(textures)) return;
  job.settled = true;
  stopTextureJob(job);
  textureJobs.delete(job.key);
  cacheTextures(job.key, textures);
  for (const listener of job.listeners) listener(textures);
  job.listeners.clear();
}

function abandonTextureJob(job: TextureJob): void {
  if (job.settled) return;
  job.settled = true;
  stopTextureJob(job);
  textureJobs.delete(job.key);
  job.listeners.clear();
}

function prepareTexturesOnMainThread(job: TextureJob): void {
  if (job.settled || job.listeners.size === 0) {
    abandonTextureJob(job);
    return;
  }
  job.cancelScheduledWork = scheduleTextureWork(() => {
    job.cancelScheduledWork = null;
    if (job.settled || job.listeners.size === 0) {
      abandonTextureJob(job);
      return;
    }
    try {
      const fallback = spatialFieldFallbackPixels(job.field);
      settleTextureJob(job, {
        base: fallback,
        flow: fallback,
        drift: fallback,
      });
    } catch {
      abandonTextureJob(job);
    }
  });
}

function startTextureJob(job: TextureJob): void {
  if (typeof Worker !== 'function') {
    prepareTexturesOnMainThread(job);
    return;
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL('./spatial-texture-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    prepareTexturesOnMainThread(job);
    return;
  }

  const requestId = ++textureRequestId;
  job.worker = worker;
  const fallBack = () => {
    if (job.settled) return;
    stopTextureJob(job);
    prepareTexturesOnMainThread(job);
  };
  worker.onmessage = ({ data }: MessageEvent<SpatialTextureWorkerResponse>) => {
    if (data.id !== requestId) return;
    if (!validTextures(data)) {
      fallBack();
      return;
    }
    settleTextureJob(job, { base: data.base, flow: data.flow, drift: data.drift });
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fallBack();
  };
  worker.onmessageerror = fallBack;
  const request: SpatialTextureWorkerRequest = { id: requestId, field: job.field };
  try {
    worker.postMessage(request);
  } catch {
    fallBack();
  }
}

function requestTextures(
  field: SpatialColorField,
  key: string,
  listener: TextureListener,
): () => void {
  const cached = cachedTextures(key);
  if (cached) {
    const timer = window.setTimeout(() => listener(cached), 0);
    return () => window.clearTimeout(timer);
  }

  let job = textureJobs.get(key);
  if (!job) {
    job = {
      field,
      key,
      listeners: new Set(),
      worker: null,
      cancelScheduledWork: null,
      settled: false,
    };
    textureJobs.set(key, job);
    job.listeners.add(listener);
    startTextureJob(job);
  } else {
    job.listeners.add(listener);
  }

  return () => {
    if (!job || job.settled) return;
    job.listeners.delete(listener);
    if (job.listeners.size === 0) abandonTextureJob(job);
  };
}

function SpatialFieldSurface({
  field,
  index,
  motion,
  onOpacityTransitionEnd,
  onTextureReady,
  state,
  visible,
}: {
  field: SpatialColorField;
  index: number;
  motion: 'running' | 'paused' | 'reduced';
  onOpacityTransitionEnd: (index: number, key: string) => void;
  onTextureReady: (index: number, key: string) => void;
  state: 'active' | 'transitioning' | 'inactive';
  visible: boolean;
}) {
  const mainCanvas = useRef<HTMLCanvasElement>(null);
  const flowCanvas = useRef<HTMLCanvasElement>(null);
  const driftCanvas = useRef<HTMLCanvasElement>(null);
  const [readyKey, setReadyKey] = useState('');
  const key = fieldKey(field);

  useEffect(() => requestTextures(field, key, (textures) => {
    const main = mainCanvas.current;
    const flow = flowCanvas.current;
    const drift = driftCanvas.current;
    if (!main || !flow || !drift) return;
    const mainPainted = paintSpatialField(main, field, textures.base);
    const flowPainted = paintSpatialField(flow, field, textures.flow);
    const driftPainted = paintSpatialField(drift, field, textures.drift);
    if (!mainPainted || !flowPainted || !driftPainted) return;
    setReadyKey(key);
  }), [key]);

  useEffect(() => {
    if (state !== 'transitioning' || readyKey !== key) return;
    onTextureReady(index, key);
  }, [index, key, onTextureReady, readyKey, state]);

  const handleTransitionEnd = (event: ReactTransitionEvent<HTMLSpanElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'opacity') return;
    onOpacityTransitionEnd(index, key);
  };

  return (
    <span
      className={[
        'spatial-field-surface',
        state === 'active' ? 'is-active' : '',
        state === 'transitioning' ? 'is-transitioning' : '',
        state === 'transitioning' && visible ? 'is-visible' : '',
      ].filter(Boolean).join(' ')}
      data-composite-role={state === 'transitioning'
        ? 'incoming'
        : state === 'active'
          ? 'active'
          : 'standby'}
      data-field-key={key}
      data-motion={motion}
      data-state={state}
      data-texture-state={readyKey === key ? 'ready' : 'preparing'}
      onTransitionEnd={handleTransitionEnd}
      style={{
        '--spatial-base-rgb': rgbChannels(field.base),
        '--spatial-cycle-a': field.cycleA ?? '97s',
        '--spatial-cycle-b': field.cycleB ?? '49s',
        '--spatial-cycle-c': field.cycleC ?? '139s',
        '--spatial-delay-a': field.delayA ?? '-23s',
        '--spatial-delay-b': field.delayB ?? '-17s',
        '--spatial-delay-c': field.delayC ?? '-61s',
      } as CSSProperties}
    >
      <canvas
        aria-hidden="true"
        className="spatial-field-canvas spatial-field-canvas--main"
        data-spatial-layer="main"
        height={SPATIAL_FIELD_CANVAS_HEIGHT}
        ref={mainCanvas}
        width={SPATIAL_FIELD_CANVAS_WIDTH}
      />
      <canvas
        aria-hidden="true"
        className="spatial-field-canvas spatial-field-canvas--flow-a"
        data-spatial-layer="flow-a"
        height={SPATIAL_FIELD_CANVAS_HEIGHT}
        ref={flowCanvas}
        width={SPATIAL_FIELD_CANVAS_WIDTH}
      />
      <canvas
        aria-hidden="true"
        className="spatial-field-canvas spatial-field-canvas--flow-b"
        data-spatial-layer="flow-b"
        height={SPATIAL_FIELD_CANVAS_HEIGHT}
        ref={driftCanvas}
        width={SPATIAL_FIELD_CANVAS_WIDTH}
      />
    </span>
  );
}

export function SpatialAmbientBackdrop({ field }: { field: SpatialColorField }) {
  const reducedMotion = useReducedMotionPreference();
  const [layers, setLayers] = useState<[SpatialColorField, SpatialColorField]>(() => [field, field]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [transitionIndex, setTransitionIndex] = useState<number | null>(null);
  const [transitionVisible, setTransitionVisible] = useState(false);
  const activeIndexRef = useRef(0);
  const transitionIndexRef = useRef<number | null>(null);
  const transitionKeyRef = useRef<string | null>(null);
  const transitionFieldRef = useRef<SpatialColorField | null>(null);
  const transitionGenerationRef = useRef(0);
  const transitionVisibleRef = useRef(false);
  const activeFieldRef = useRef(field);
  const targetKeyRef = useRef(fieldKey(field));
  const frameRef = useRef(0);
  const timerRef = useRef(0);
  const reducedMotionRef = useRef(reducedMotion);
  const key = fieldKey(field);

  const clearTransitionScheduling = useCallback(() => {
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    window.clearTimeout(timerRef.current);
    timerRef.current = 0;
  }, []);

  const finishTransition = useCallback((
    generation: number,
    nextIndex: number,
    nextKey: string,
  ) => {
    if (
      transitionGenerationRef.current !== generation
      || transitionIndexRef.current !== nextIndex
      || transitionKeyRef.current !== nextKey
      || !transitionVisibleRef.current
    ) return;
    const nextField = transitionFieldRef.current;
    if (!nextField) return;
    clearTransitionScheduling();
    activeIndexRef.current = nextIndex;
    activeFieldRef.current = nextField;
    transitionIndexRef.current = null;
    transitionKeyRef.current = null;
    transitionFieldRef.current = null;
    transitionVisibleRef.current = false;
    setActiveIndex(nextIndex);
    setTransitionIndex(null);
    setTransitionVisible(false);
  }, [clearTransitionScheduling]);

  const cancelTransition = useCallback(() => {
    transitionGenerationRef.current += 1;
    clearTransitionScheduling();
    const activeField = activeFieldRef.current;
    const inactiveIndex = activeIndexRef.current === 0 ? 1 : 0;
    transitionIndexRef.current = null;
    transitionKeyRef.current = null;
    transitionFieldRef.current = null;
    transitionVisibleRef.current = false;
    targetKeyRef.current = fieldKey(activeField);
    setLayers((current) => current.map((layer, index) =>
      index === inactiveIndex ? activeField : layer,
    ) as [SpatialColorField, SpatialColorField]);
    setTransitionIndex(null);
    setTransitionVisible(false);
  }, [clearTransitionScheduling]);

  const beginTransition = useCallback((nextField: SpatialColorField): void => {
    clearTransitionScheduling();
    const nextIndex = activeIndexRef.current === 0 ? 1 : 0;
    const nextKey = fieldKey(nextField);
    transitionGenerationRef.current += 1;
    targetKeyRef.current = nextKey;
    transitionIndexRef.current = nextIndex;
    transitionKeyRef.current = nextKey;
    transitionFieldRef.current = nextField;
    transitionVisibleRef.current = false;
    setLayers((current) => current.map((layer, index) =>
      index === nextIndex ? nextField : layer,
    ) as [SpatialColorField, SpatialColorField]);
    setTransitionIndex(nextIndex);
    setTransitionVisible(false);
  }, [clearTransitionScheduling]);

  const handleTextureReady = useCallback((nextIndex: number, nextKey: string) => {
    if (
      transitionIndexRef.current !== nextIndex
      || transitionKeyRef.current !== nextKey
    ) return;
    const generation = transitionGenerationRef.current;
    window.cancelAnimationFrame(frameRef.current);
    if (reducedMotionRef.current) {
      transitionVisibleRef.current = true;
      setTransitionVisible(true);
      timerRef.current = window.setTimeout(
        () => finishTransition(generation, nextIndex, nextKey),
        REDUCED_MOTION_CROSSFADE_MS,
      );
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      if (
        transitionGenerationRef.current !== generation
        || transitionIndexRef.current !== nextIndex
        || transitionKeyRef.current !== nextKey
      ) return;
      frameRef.current = window.requestAnimationFrame(() => {
        if (
          transitionGenerationRef.current !== generation
          || transitionIndexRef.current !== nextIndex
          || transitionKeyRef.current !== nextKey
        ) return;
        transitionVisibleRef.current = true;
        setTransitionVisible(true);
        timerRef.current = window.setTimeout(
          () => finishTransition(generation, nextIndex, nextKey),
          SPATIAL_CROSSFADE_MS + SPATIAL_CROSSFADE_SAFETY_MS,
        );
      });
    });
  }, [finishTransition]);

  const handleOpacityTransitionEnd = useCallback((nextIndex: number, nextKey: string) => {
    finishTransition(transitionGenerationRef.current, nextIndex, nextKey);
  }, [finishTransition]);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    if (
      !reducedMotion
      || transitionIndexRef.current === null
      || !transitionVisibleRef.current
      || !transitionKeyRef.current
    ) return;
    finishTransition(
      transitionGenerationRef.current,
      transitionIndexRef.current,
      transitionKeyRef.current,
    );
  }, [finishTransition, reducedMotion]);

  useEffect(() => {
    if (key === targetKeyRef.current) return;
    if (key === fieldKey(activeFieldRef.current)) {
      cancelTransition();
      return;
    }
    beginTransition(field);
  }, [beginTransition, cancelTransition, field, key]);

  useEffect(() => () => {
    transitionGenerationRef.current += 1;
    clearTransitionScheduling();
  }, [clearTransitionScheduling]);

  return (
    <div
      className="am-ambient spatial-ambient"
      data-composite-state={transitionIndex === null
        ? 'steady'
        : transitionVisible
          ? 'crossfading'
          : 'preparing'}
      data-motion={reducedMotion ? 'reduced' : 'full'}
      data-renderer="spatial-canvas"
      data-transition-key={transitionIndex === null ? undefined : transitionKeyRef.current ?? undefined}
      style={{
        '--spatial-crossfade-duration': `${SPATIAL_CROSSFADE_MS}ms`,
      } as CSSProperties}
      aria-hidden="true"
    >
      {layers.map((layer, index) => (
        <SpatialFieldSurface
          field={layer}
          index={index}
          key={index}
          motion={reducedMotion
            ? 'reduced'
            : index === transitionIndex || (transitionIndex === null && index === activeIndex)
              ? 'running'
              : 'paused'}
          state={index === activeIndex
            ? 'active'
            : index === transitionIndex
              ? 'transitioning'
              : 'inactive'}
          visible={index === transitionIndex && transitionVisible}
          onOpacityTransitionEnd={handleOpacityTransitionEnd}
          onTextureReady={handleTextureReady}
        />
      ))}
      <span className="spatial-field-veil" />
    </div>
  );
}
