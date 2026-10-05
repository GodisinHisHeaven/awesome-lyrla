import { useEffect, useMemo, useRef, useState } from 'react';
import type { NavigationMapSnapshot } from '../../shared/contracts.js';
import { navigationRouteIsFresh } from '../../shared/navigation-map.js';
import { navigationMapGeometry } from '../navigation-map-geometry.js';
import { useNavigationMapMotion } from '../hooks/useNavigationMapMotion.js';

const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const tileUrl = import.meta.env.VITE_NAVIGATION_MAP_TILE_URL || DEFAULT_TILE_URL;
const attribution =
  import.meta.env.VITE_NAVIGATION_MAP_ATTRIBUTION || '© OpenStreetMap contributors';
const attributionUrl =
  import.meta.env.VITE_NAVIGATION_MAP_ATTRIBUTION_URL || 'https://www.openstreetmap.org/copyright';

export default function NavigationMap({ map, now }: { map: NavigationMapSnapshot; now: number }) {
  const element = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 400, height: 210 });
  const [tileStatus, setTileStatus] = useState<Record<string, 'loaded' | 'error'>>({});
  const routeIsFresh = navigationRouteIsFresh(map, now);
  const targetGeometry = useMemo(
    () => navigationMapGeometry(map, size.width, size.height, routeIsFresh),
    [map, size.width, size.height, routeIsFresh],
  );
  const targetFrame = useMemo(
    () => ({
      location: map.location,
      camera: targetGeometry.camera,
      direction: targetGeometry.routeDirectionDegrees,
    }),
    [map.location, targetGeometry],
  );
  const frame = useNavigationMapMotion(
    map,
    now,
    targetFrame,
    `${size.width}:${size.height}`,
    routeIsFresh,
  );
  const geometry = useMemo(
    () =>
      navigationMapGeometry(
        { ...map, location: frame.location },
        size.width,
        size.height,
        routeIsFresh,
        frame.camera,
      ),
    [frame, map, size, routeIsFresh],
  );
  useEffect(() => {
    if (!element.current) return;
    const resize = () => {
      const node = element.current;
      if (node && node.clientWidth && node.clientHeight)
        setSize({ width: node.clientWidth, height: node.clientHeight });
    };
    resize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  const tileKey = geometry.tiles.map((tile) => tile.key).join('|');
  useEffect(() => {
    const visible = new Set(tileKey.split('|'));
    setTileStatus((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => visible.has(key))),
    );
  }, [tileKey]);
  const hasErrors = geometry.tiles.some((tile) => tileStatus[tile.key] === 'error');
  const pending = geometry.tiles.some((tile) => tileStatus[tile.key] === undefined);
  const points = geometry.route.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  return (
    <div
      className="am-navigation-map"
      ref={element}
      role="img"
      aria-label="北向上的地图，车辆位置、目的地与特斯拉导航路线；箭头按路线方向显示"
    >
      <div className="am-navigation-map-tiles" aria-hidden="true">
        {geometry.tiles.map((tile) => (
          <img
            key={tile.key}
            alt=""
            draggable={false}
            width={256}
            height={256}
            src={tileUrl
              .replace('{z}', String(tile.zoom))
              .replace('{x}', String(tile.column))
              .replace('{y}', String(tile.row))}
            style={{ left: tile.x, top: tile.y, width: tile.size, height: tile.size }}
            onLoad={() => setTileStatus((previous) => ({ ...previous, [tile.key]: 'loaded' }))}
            onError={() => setTileStatus((previous) => ({ ...previous, [tile.key]: 'error' }))}
          />
        ))}
      </div>
      <svg
        className="am-navigation-map-overlay"
        viewBox={`0 0 ${size.width} ${size.height}`}
        aria-hidden="true"
      >
        {geometry.route.length >= 2 && (
          <>
            <polyline
              points={points}
              fill="none"
              stroke="#ffffff"
              strokeWidth="8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <polyline
              points={points}
              fill="none"
              stroke="#3e6ae1"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
        <g transform={`translate(${geometry.destination.x},${geometry.destination.y})`}>
          <circle r="11" fill="#ffffff" stroke="#34363a" strokeWidth="2" />
          <path
            d="M-3 6V-6H5V0H-3"
            fill="none"
            stroke="#34363a"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </g>
        <g
          className="am-navigation-map-location"
          transform={`translate(${geometry.location.x},${geometry.location.y})`}
        >
          {frame.direction === null || geometry.route.length < 2 ? (
            <circle r="8" fill="#e54b3d" stroke="#ffffff" strokeWidth="3" />
          ) : (
            <path
              d="M0 -14L10 10Q10.5 12 8 11L0 7L-8 11Q-10.5 12 -10 10Z"
              transform={`rotate(${frame.direction})`}
              fill="#e54b3d"
              stroke="#ffffff"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
          )}
        </g>
      </svg>
      <span className="am-navigation-map-north" aria-hidden="true">
        <svg width="10" height="12" viewBox="0 0 10 12">
          <path d="M5 0L10 12L5 9L0 12Z" fill="currentColor" />
        </svg>
        <span>N</span>
      </span>
      {(hasErrors || pending || geometry.route.length < 2) && (
        <span className="am-navigation-map-status">
          {hasErrors ? '底图暂不可用' : pending ? '正在加载地图…' : '等待车辆路线'}
        </span>
      )}
      <a
        className="am-navigation-map-attribution"
        href={attributionUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {attribution}
      </a>
    </div>
  );
}
