import {
  spatialFieldDriftPixels,
  spatialFieldFallbackPixels,
  spatialFieldFlowPixels,
  spatialFieldPixels,
  SPATIAL_FIELD_CANVAS_HEIGHT,
  SPATIAL_FIELD_CANVAS_WIDTH,
  type SpatialColorField,
} from './spatial-field.js';

const directionalField: SpatialColorField = {
  id: 'directional',
  columns: 2,
  rows: 1,
  colors: ['#D94A3A', '#315FCC'],
  base: '#10131A',
};

function pixelAt(pixels: Uint8ClampedArray, width: number, x: number, y: number) {
  const index = (y * width + x) * 4;
  return [...pixels.slice(index, index + 4)];
}

function lumaAt(pixels: Uint8ClampedArray, width: number, x: number, y: number): number {
  const [red, green, blue] = pixelAt(pixels, width, x, y);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function percentile(values: number[], progress: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * progress))] ?? 0;
}

describe('spatialFieldPixels', () => {
  it('renders a fixed low-resolution 16:9 texture by default', () => {
    const pixels = spatialFieldPixels(directionalField);

    expect(pixels).toHaveLength(SPATIAL_FIELD_CANVAS_WIDTH * SPATIAL_FIELD_CANVAS_HEIGHT * 4);
    expect(SPATIAL_FIELD_CANVAS_WIDTH).toBeLessThanOrEqual(512);
    expect(SPATIAL_FIELD_CANVAS_HEIGHT).toBeLessThanOrEqual(288);
  });

  it('is deterministic for the same field identity and colors', () => {
    const first = spatialFieldPixels(directionalField, 18, 10);
    const second = spatialFieldPixels({ ...directionalField }, 18, 10);

    expect(second).toEqual(first);
  });

  it('builds three deterministic phases that bend the field internally', () => {
    const base = spatialFieldPixels(directionalField, 36, 20);
    const flow = spatialFieldFlowPixels(directionalField, 36, 20);
    const drift = spatialFieldDriftPixels(directionalField, 36, 20);
    const repeated = spatialFieldFlowPixels({ ...directionalField }, 36, 20);

    expect(repeated).toEqual(flow);
    expect(flow).not.toEqual(base);
    expect(drift).not.toEqual(base);
    expect(drift).not.toEqual(flow);
    for (const phase of [base, flow, drift]) {
      for (let index = 3; index < phase.length; index += 4) expect(phase[index]).toBe(255);
    }
  });

  it('preserves the source field direction instead of collapsing to global colors', () => {
    const pixels = spatialFieldPixels(directionalField, 9, 3);
    const left = pixelAt(pixels, 9, 0, 1);
    const right = pixelAt(pixels, 9, 8, 1);

    expect(left[0]).toBeGreaterThan(left[2]);
    expect(right[2]).toBeGreaterThan(right[0]);
    expect(left).not.toEqual(right);
  });

  it('uses a bounded opaque fallback for invalid or missing cells', () => {
    const pixels = spatialFieldPixels({
      id: 'invalid',
      columns: 3,
      rows: 2,
      colors: ['not-a-color'],
      base: '#243040',
    }, 7, 5);

    expect(pixels).toHaveLength(7 * 5 * 4);
    expect([...pixels].every((value) => Number.isFinite(value) && value >= 0 && value <= 255)).toBe(true);
    for (let index = 3; index < pixels.length; index += 4) expect(pixels[index]).toBe(255);
  });

  it('bounds invalid or excessive output dimensions', () => {
    expect(spatialFieldPixels(directionalField, Number.POSITIVE_INFINITY, Number.NaN))
      .toHaveLength(SPATIAL_FIELD_CANVAS_WIDTH * SPATIAL_FIELD_CANVAS_HEIGHT * 4);
    expect(spatialFieldPixels(directionalField, 4_096, 4_096))
      .toHaveLength(512 * 288 * 4);
  });

  it('provides a deterministic full-size emergency texture from a compact render', () => {
    const first = spatialFieldFallbackPixels(directionalField);
    const second = spatialFieldFallbackPixels({ ...directionalField });

    expect(first).toHaveLength(
      SPATIAL_FIELD_CANVAS_WIDTH * SPATIAL_FIELD_CANVAS_HEIGHT * 4,
    );
    expect(second).toEqual(first);
    expect(first).not.toEqual(spatialFieldPixels(directionalField));
    for (let index = 3; index < first.length; index += 4) expect(first[index]).toBe(255);
  });

  it('does not expose theoretical control-grid seams for a high-contrast field', () => {
    const width = 192;
    const height = 108;
    const field: SpatialColorField = {
      id: 'checkerboard-stress',
      columns: 6,
      rows: 4,
      colors: Array.from(
        { length: 24 },
        (_, index) => (index + Math.floor(index / 6)) % 2 === 0 ? '#F04A36' : '#14285C',
      ),
      base: '#0A0E18',
    };
    const pixels = spatialFieldPixels(field, width, height);
    const verticalEnergy = Array.from({ length: width - 4 }, (_, offset) => {
      const x = offset + 2;
      let total = 0;
      for (let y = 2; y < height - 2; y += 1) {
        total += Math.abs(
          lumaAt(pixels, width, x - 1, y)
          - 2 * lumaAt(pixels, width, x, y)
          + lumaAt(pixels, width, x + 1, y),
        );
      }
      return total / (height - 4);
    });
    const horizontalEnergy = Array.from({ length: height - 4 }, (_, offset) => {
      const y = offset + 2;
      let total = 0;
      for (let x = 2; x < width - 2; x += 1) {
        total += Math.abs(
          lumaAt(pixels, width, x, y - 1)
          - 2 * lumaAt(pixels, width, x, y)
          + lumaAt(pixels, width, x, y + 1),
        );
      }
      return total / (width - 4);
    });
    const verticalLimit = percentile(verticalEnergy, 0.95) * 1.5 + 0.5;
    const horizontalLimit = percentile(horizontalEnergy, 0.95) * 1.5 + 0.5;
    const verticalGridLines = Array.from(
      { length: field.columns - 1 },
      (_, index) => Math.round((index + 1) / field.columns * (width - 1)),
    );
    const horizontalGridLines = Array.from(
      { length: field.rows - 1 },
      (_, index) => Math.round((index + 1) / field.rows * (height - 1)),
    );

    for (const x of verticalGridLines) {
      expect(verticalEnergy[x - 2]).toBeLessThanOrEqual(verticalLimit);
    }
    for (const y of horizontalGridLines) {
      expect(horizontalEnergy[y - 2]).toBeLessThanOrEqual(horizontalLimit);
    }
  });
});
