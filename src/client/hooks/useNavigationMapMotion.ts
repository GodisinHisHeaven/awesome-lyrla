import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NavigationMapSnapshot } from '../../shared/contracts.js';
import { navigationMapIsFresh } from '../../shared/navigation-map.js';
import {
  navigationMapFrameAt,
  navigationMapMotion,
  sameNavigationFrame,
  type NavigationMapFrame,
  type NavigationMapMotion,
} from '../navigation-map-motion.js';

const motionQuery = '(prefers-reduced-motion: reduce)';

export function useNavigationMapMotion(
  map: NavigationMapSnapshot,
  now: number,
  target: NavigationMapFrame,
  sizeKey: string,
  routeIsFresh: boolean,
): NavigationMapFrame {
  const [frame, setFrame] = useState(target);
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(motionQuery).matches,
  );
  const frameRef = useRef(frame);
  const targetRef = useRef(target);
  const animationFrame = useRef(0);
  const motion = useRef<{ value: NavigationMapMotion; startedAt: number } | null>(null);
  const destinationKey = `${map.destination.latitude}:${map.destination.longitude}`;
  const previous = useRef({
    sampleAt: map.locationUpdatedAtMs,
    interval: 5_000,
    destinationKey,
    sizeKey,
    routeIsFresh,
  });
  const fresh = navigationMapIsFresh(map, now);
  const stop = useCallback(() => {
    window.cancelAnimationFrame(animationFrame.current);
    animationFrame.current = 0;
    motion.current = null;
  }, []);
  const commit = useCallback((next: NavigationMapFrame) => {
    frameRef.current = next;
    setFrame(next);
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(motionQuery);
    const update = () => setReducedMotion(media.matches);
    update();
    if (typeof media.addEventListener === 'function') media.addEventListener('change', update);
    else media.addListener?.(update);
    return () => {
      if (typeof media.removeEventListener === 'function')
        media.removeEventListener('change', update);
      else media.removeListener?.(update);
    };
  }, []);

  useLayoutEffect(() => {
    const last = previous.current;
    const reset = destinationKey !== last.destinationKey || sizeKey !== last.sizeKey;
    const interval = map.locationUpdatedAtMs - last.sampleAt;
    if (!reset && interval < 0) return;
    targetRef.current = target;
    previous.current = {
      sampleAt: map.locationUpdatedAtMs,
      interval: interval > 0 ? interval : last.interval,
      destinationKey,
      sizeKey,
      routeIsFresh,
    };
    if (
      reset ||
      !fresh ||
      (last.routeIsFresh && !routeIsFresh) ||
      reducedMotion ||
      document.hidden
    ) {
      stop();
      commit(target);
      return;
    }
    // A repeated SSE snapshot must not restart or cancel an in-flight move.
    if (sameNavigationFrame(motion.current?.value.to ?? frameRef.current, target)) return;
    const time = performance.now();
    const from = motion.current
      ? navigationMapFrameAt(motion.current.value, time - motion.current.startedAt)
      : frameRef.current;
    const next = navigationMapMotion(
      from,
      target,
      routeIsFresh ? (map.route ?? []) : [],
      interval || last.interval,
    );
    stop();
    if (!next) {
      commit(target);
      return;
    }
    motion.current = { value: next, startedAt: time };
    const tick = (timestamp: number) => {
      commit(navigationMapFrameAt(next, timestamp - time));
      if (timestamp - time < next.duration)
        animationFrame.current = window.requestAnimationFrame(tick);
      else {
        animationFrame.current = 0;
        motion.current = null;
      }
    };
    animationFrame.current = window.requestAnimationFrame(tick);
  }, [
    map.locationUpdatedAtMs,
    map.route,
    target,
    destinationKey,
    sizeKey,
    routeIsFresh,
    fresh,
    reducedMotion,
    stop,
    commit,
  ]);

  useEffect(() => {
    const onVisibilityChange = () => {
      stop();
      commit(targetRef.current);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [stop, commit]);
  return frame;
}
