import type {
  ArtworkSpatialField,
  PlayerSnapshot,
} from '../shared/contracts.js';
import type { SpatialColorField } from './spatial-field.js';

type Rgb = readonly [number, number, number];

export interface AmbientFieldPalette {
  primary: string;
  secondary: string;
  bridge: string;
  primaryAlpha: string;
  secondaryAlpha: string;
  bridgeAlpha: string;
  cycleA: string;
  cycleB: string;
  delayA: string;
  delayB: string;
  key: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function hashFor(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash >>> 0;
}

function rgb(red: number, green: number, blue: number): Rgb {
  return [
    Math.max(0, Math.min(255, Math.round(red))),
    Math.max(0, Math.min(255, Math.round(green))),
    Math.max(0, Math.min(255, Math.round(blue))),
  ];
}

function rgbChannels(value: Rgb): string {
  return value.join(' ');
}

function rgbHex(value: Rgb): string {
  return `#${value.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function hexRgb(value: string): Rgb | null {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return null;
  return rgb(
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  );
}

function channelsRgb(value: string): Rgb | null {
  const channels = value.split(' ').map(Number);
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
  return rgb(channels[0], channels[1], channels[2]);
}

function hslRgb(hue: number, saturation: number, lightness: number): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  let partial: [number, number, number];
  if (segment < 1) partial = [chroma, x, 0];
  else if (segment < 2) partial = [x, chroma, 0];
  else if (segment < 3) partial = [0, chroma, x];
  else if (segment < 4) partial = [0, x, chroma];
  else if (segment < 5) partial = [x, 0, chroma];
  else partial = [chroma, 0, x];
  const match = lightness - chroma / 2;
  return rgb(
    (partial[0] + match) * 255,
    (partial[1] + match) * 255,
    (partial[2] + match) * 255,
  );
}

function mixRgb(left: Rgb, right: Rgb, rightWeight: number): Rgb {
  const weight = clamp(rightWeight, 0, 1);
  return rgb(
    left[0] + (right[0] - left[0]) * weight,
    left[1] + (right[1] - left[1]) * weight,
    left[2] + (right[2] - left[2]) * weight,
  );
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(value: Rgb): number {
  return 0.2126 * linearChannel(value[0])
    + 0.7152 * linearChannel(value[1])
    + 0.0722 * linearChannel(value[2]);
}

function decimal(value: number): string {
  return String(Number(value.toFixed(3)));
}

export function ambientFieldPalette(snapshot: PlayerSnapshot | null): AmbientFieldPalette {
  const identity = [
    snapshot?.track?.title ?? 'night',
    snapshot?.track?.artist ?? '',
    snapshot?.track?.album ?? '',
  ].join('\u001f');
  const seed = hashFor(identity);
  const palette = snapshot?.artworkPalette;
  const artworkPrimary = palette ? hexRgb(palette.primary) : null;
  const artworkSecondary = palette ? hexRgb(palette.secondary) : null;
  const hue = seed % 360;
  const hasArtworkPair = artworkPrimary !== null && artworkSecondary !== null;
  const primaryRgb = hasArtworkPair ? artworkPrimary : hslRgb(hue, 0.62, 0.48);
  const secondaryRgb = hasArtworkPair
    ? artworkSecondary
    : hslRgb((hue + 54) % 360, 0.58, 0.42);
  const bridgeRgb = mixRgb(primaryRgb, secondaryRgb, 0.48);
  const peakLuminance = Math.max(
    relativeLuminance(primaryRgb),
    relativeLuminance(secondaryRgb),
    relativeLuminance(bridgeRgb),
  );
  const gain = clamp(0.98 - Math.max(0, peakLuminance - 0.24) * 0.55, 0.68, 0.98);
  const primary = rgbChannels(primaryRgb);
  const secondary = rgbChannels(secondaryRgb);
  const bridge = rgbChannels(bridgeRgb);

  return {
    primary,
    secondary,
    bridge,
    primaryAlpha: decimal(0.46 * gain),
    secondaryAlpha: decimal(0.34 * gain),
    bridgeAlpha: decimal(0.18 * gain),
    cycleA: `${31 + seed % 5}s`,
    cycleB: `${43 + (seed >>> 5) % 7}s`,
    delayA: `-${(seed >>> 11) % 29}s`,
    delayB: `-${(seed >>> 17) % 41}s`,
    key: `${primary}:${secondary}:${bridge}`,
  };
}

function validArtworkField(field: ArtworkSpatialField | undefined): field is ArtworkSpatialField {
  return field?.schemaVersion === 1
    && /^field:[0-9a-f]{16}$/.test(field.id)
    && field.columns === 6
    && field.rows === 4
    && /^#[0-9a-f]{6}$/i.test(field.base)
    && Array.isArray(field.colors)
    && field.colors.length === 24
    && field.colors.every((color) => /^#[0-9a-f]{6}$/i.test(color));
}

function motionForField(id: string) {
  const seed = hashFor(id);
  return {
    cycleA: `${89 + seed % 13}s`,
    cycleB: `${43 + (seed >>> 5) % 11}s`,
    cycleC: `${131 + (seed >>> 10) % 19}s`,
    delayA: `-${17 + (seed >>> 15) % 37}s`,
    delayB: `-${11 + (seed >>> 20) % 31}s`,
    delayC: `-${41 + (seed >>> 25) % 61}s`,
  };
}

function gaussianInfluence(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  spreadX: number,
  spreadY: number,
): number {
  const dx = (x - centerX) / spreadX;
  const dy = (y - centerY) / spreadY;
  return Math.exp(-0.5 * (dx * dx + dy * dy));
}

function weightedRgb(samples: Array<{ color: Rgb; weight: number }>): Rgb {
  const weight = samples.reduce((total, sample) => total + sample.weight, 0);
  return rgb(
    samples.reduce((total, sample) => total + sample.color[0] * sample.weight, 0) / weight,
    samples.reduce((total, sample) => total + sample.color[1] * sample.weight, 0) / weight,
    samples.reduce((total, sample) => total + sample.color[2] * sample.weight, 0) / weight,
  );
}

function fallbackSpatialField(colors: AmbientFieldPalette): SpatialColorField {
  const primary = channelsRgb(colors.primary) ?? [59, 62, 69];
  const secondary = channelsRgb(colors.secondary) ?? [25, 28, 34];
  const bridge = mixRgb(primary, secondary, 0.48);
  const night: Rgb = [7, 9, 14];
  const seed = hashFor(colors.key);
  const signedUnit = (shift: number) => ((seed >>> shift) & 0xff) / 255 - 0.5;
  const primaryAnchor = { x: 0.25 + signedUnit(0) * 0.1, y: 0.24 + signedUnit(8) * 0.1 };
  const secondaryAnchor = { x: 0.76 + signedUnit(16) * 0.1, y: 0.38 + signedUnit(24) * 0.1 };
  const bridgeAnchor = { x: 0.48 - signedUnit(8) * 0.08, y: 0.77 - signedUnit(16) * 0.1 };
  const fieldColors = Array.from({ length: 24 }, (_, index) => {
    const x = (index % 6 + 0.5) / 6;
    const y = (Math.floor(index / 6) + 0.5) / 4;
    const edge = Math.min(x, 1 - x, y, 1 - y);
    return rgbHex(weightedRgb([
      {
        color: primary,
        weight: 1.12 * gaussianInfluence(
          x,
          y,
          primaryAnchor.x,
          primaryAnchor.y,
          0.34,
          0.38,
        ),
      },
      {
        color: secondary,
        weight: 1.06 * gaussianInfluence(
          x,
          y,
          secondaryAnchor.x,
          secondaryAnchor.y,
          0.36,
          0.4,
        ),
      },
      {
        color: bridge,
        weight: 0.82 * gaussianInfluence(
          x,
          y,
          bridgeAnchor.x,
          bridgeAnchor.y,
          0.42,
          0.34,
        ),
      },
      { color: night, weight: 0.25 + Math.max(0, 0.18 - edge) * 2.2 },
    ]));
  });
  const id = `fallback:organic:${hashFor(`${colors.key}:${fieldColors.join(',')}`).toString(16).padStart(8, '0')}`;
  return {
    id,
    schemaVersion: 1,
    columns: 6,
    rows: 4,
    colors: fieldColors,
    base: rgbHex(mixRgb(bridge, night, 0.68)),
    ...motionForField(id),
  };
}

export function spatialFieldForSnapshot(
  snapshot: PlayerSnapshot | null,
  ambient = ambientFieldPalette(snapshot),
): SpatialColorField {
  const artwork = snapshot?.artworkPalette;
  if (artwork?.source === 'apple' && validArtworkField(artwork.field)) {
    return {
      id: artwork.field.id,
      schemaVersion: artwork.field.schemaVersion,
      columns: artwork.field.columns,
      rows: artwork.field.rows,
      colors: [...artwork.field.colors],
      base: artwork.field.base,
      ...motionForField(artwork.field.id),
    };
  }
  return fallbackSpatialField(ambient);
}
