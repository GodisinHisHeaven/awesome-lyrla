type Rgb = readonly [number, number, number];
type LinearRgb = readonly [number, number, number];

export const SPATIAL_FIELD_CANVAS_WIDTH = 192;
export const SPATIAL_FIELD_CANVAS_HEIGHT = 108;
const MAX_SPATIAL_FIELD_WIDTH = 512;
const MAX_SPATIAL_FIELD_HEIGHT = 288;

export interface SpatialColorField {
  id: string;
  schemaVersion?: 1;
  columns: number;
  rows: number;
  colors: string[];
  base: string;
  cycleA?: string;
  cycleB?: string;
  cycleC?: string;
  delayA?: string;
  delayB?: string;
  delayC?: string;
}

const SPATIAL_FIELD_PHASE_COUNT = 3;
const SPATIAL_BLUR_RADIUS = 9;
const SPATIAL_BLUR_SIGMA = 3;
const SPATIAL_FALLBACK_WIDTH = 48;
const SPATIAL_FALLBACK_HEIGHT = 27;
const TAU = Math.PI * 2;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseHex(value: string): Rgb | null {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return null;
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const value = clamp(channel);
  const encoded = value <= 0.0031308
    ? value * 12.92
    : 1.055 * value ** (1 / 2.4) - 0.055;
  return encoded * 255;
}

function linearRgb(value: Rgb): LinearRgb {
  return [
    srgbToLinear(value[0]),
    srgbToLinear(value[1]),
    srgbToLinear(value[2]),
  ];
}

function smoothstep(value: number): number {
  const bounded = clamp(value);
  return bounded * bounded * (3 - 2 * bounded);
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function hashFor(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashNoise(x: number, y: number, seed: number): number {
  let value = seed ^ Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 1, 0x119de1f3);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}

function mirroredIndex(value: number, size: number): number {
  if (size <= 1) return 0;
  const period = size * 2 - 2;
  const wrapped = ((value % period) + period) % period;
  return wrapped < size ? wrapped : period - wrapped;
}

function colorAt(colors: LinearRgb[], columns: number, column: number, row: number): LinearRgb {
  const rows = Math.max(1, Math.ceil(colors.length / columns));
  const safeColumn = mirroredIndex(column, columns);
  const safeRow = mirroredIndex(row, rows);
  return colors[safeRow * columns + safeColumn] ?? colors[0] ?? [0.02, 0.025, 0.035];
}

function bsplineWeights(value: number): readonly [number, number, number, number] {
  const t = clamp(value);
  const t2 = t * t;
  const t3 = t2 * t;
  const inverse = 1 - t;
  return [
    inverse * inverse * inverse / 6,
    (3 * t3 - 6 * t2 + 4) / 6,
    (-3 * t3 + 3 * t2 + 3 * t + 1) / 6,
    t3 / 6,
  ];
}

function colorDistance(left: LinearRgb, right: LinearRgb): number {
  return Math.hypot(
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2],
  );
}

function softenControls(
  colors: LinearRgb[],
  columns: number,
  rows: number,
): LinearRgb[] {
  let maximumNeighborDistance = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const color = colorAt(colors, columns, column, row);
      if (column + 1 < columns) {
        maximumNeighborDistance = Math.max(
          maximumNeighborDistance,
          colorDistance(color, colorAt(colors, columns, column + 1, row)),
        );
      }
      if (row + 1 < rows) {
        maximumNeighborDistance = Math.max(
          maximumNeighborDistance,
          colorDistance(color, colorAt(colors, columns, column, row + 1)),
        );
      }
    }
  }
  const blend = maximumNeighborDistance > 0.34 ? 0.42 : 0.32;
  const binomial = [1, 2, 1];
  return colors.map((color, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const blurred: [number, number, number] = [0, 0, 0];
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const weight = binomial[offsetX + 1] * binomial[offsetY + 1] / 16;
        const sample = colorAt(colors, columns, column + offsetX, row + offsetY);
        blurred[0] += sample[0] * weight;
        blurred[1] += sample[1] * weight;
        blurred[2] += sample[2] * weight;
      }
    }
    return [
      lerp(color[0], blurred[0], blend),
      lerp(color[1], blurred[1], blend),
      lerp(color[2], blurred[2], blend),
    ] as LinearRgb;
  });
}

function interpolateColor(
  colors: LinearRgb[],
  columns: number,
  rows: number,
  normalizedX: number,
  normalizedY: number,
): LinearRgb {
  const fieldX = clamp(normalizedX) * columns - 0.5;
  const fieldY = clamp(normalizedY) * rows - 0.5;
  const left = Math.floor(fieldX);
  const top = Math.floor(fieldY);
  const weightsX = bsplineWeights(fieldX - left);
  const weightsY = bsplineWeights(fieldY - top);
  const output: [number, number, number] = [0, 0, 0];

  for (let offsetY = 0; offsetY < 4; offsetY += 1) {
    for (let offsetX = 0; offsetX < 4; offsetX += 1) {
      const weight = weightsX[offsetX] * weightsY[offsetY];
      const color = colorAt(
        colors,
        columns,
        left + offsetX - 1,
        top + offsetY - 1,
      );
      output[0] += color[0] * weight;
      output[1] += color[1] * weight;
      output[2] += color[2] * weight;
    }
  }
  return output;
}

function normalizedField(field: SpatialColorField): {
  base: LinearRgb;
  columns: number;
  rows: number;
  colors: LinearRgb[];
} {
  const fallback = parseHex(field.base) ?? [7, 9, 14];
  const columns = Number.isInteger(field.columns) ? clamp(field.columns, 1, 32) : 1;
  const rows = Number.isInteger(field.rows) ? clamp(field.rows, 1, 32) : 1;
  const colorCount = columns * rows;
  const colors = Array.from({ length: colorCount }, (_, index) =>
    linearRgb(parseHex(field.colors[index] ?? '') ?? fallback),
  );
  return {
    base: linearRgb(fallback),
    columns,
    rows,
    colors: softenControls(colors, columns, rows),
  };
}

function flowCoordinates(
  normalizedX: number,
  normalizedY: number,
  seed: number,
  phaseIndex: number,
): readonly [number, number] {
  const theta = phaseIndex / SPATIAL_FIELD_PHASE_COUNT * TAU;
  let horizontal = 0;
  let vertical = 0;
  let horizontalNormalizer = 0;
  let verticalNormalizer = 0;
  const frequencies = [0.58, 0.73, 0.91, 1.12];
  const strengths = [0.46, 0.31, 0.2, 0.14];

  for (let index = 0; index < frequencies.length; index += 1) {
    const direction = hashNoise(index, seed & 0xffff, seed ^ 0x7f4a7c15) * TAU;
    const frequency = frequencies[index];
    const waveX = Math.cos(direction) * frequency;
    const waveY = Math.sin(direction) * frequency;
    const phase = hashNoise(index, seed >>> 16, seed ^ 0x9e3779b9) * TAU
      + theta * (index % 2 === 0 ? 1 : -1);
    const derivative = Math.cos(
      TAU * (waveX * normalizedX + waveY * normalizedY) + phase,
    );
    const strength = strengths[index];
    horizontal += waveY * derivative * strength;
    vertical -= waveX * derivative * strength;
    horizontalNormalizer += Math.abs(waveY * strength);
    verticalNormalizer += Math.abs(waveX * strength);
  }

  const edgeDistance = Math.min(
    normalizedX,
    1 - normalizedX,
    normalizedY,
    1 - normalizedY,
  );
  const envelope = smoothstep(edgeDistance / 0.12);
  const warpX = horizontalNormalizer > 0
    ? horizontal / horizontalNormalizer * 0.038 * envelope
    : 0;
  const warpY = verticalNormalizer > 0
    ? vertical / verticalNormalizer * 0.046 * envelope
    : 0;
  return [clamp(normalizedX + warpX), clamp(normalizedY + warpY)];
}

function gaussianKernel(): Float32Array {
  const output = new Float32Array(SPATIAL_BLUR_RADIUS * 2 + 1);
  let total = 0;
  for (let offset = -SPATIAL_BLUR_RADIUS; offset <= SPATIAL_BLUR_RADIUS; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * SPATIAL_BLUR_SIGMA ** 2));
    output[offset + SPATIAL_BLUR_RADIUS] = weight;
    total += weight;
  }
  for (let index = 0; index < output.length; index += 1) output[index] /= total;
  return output;
}

const SPATIAL_BLUR_KERNEL = gaussianKernel();

function blurLinearPixels(
  source: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let value = 0;
        for (
          let offset = -SPATIAL_BLUR_RADIUS;
          offset <= SPATIAL_BLUR_RADIUS;
          offset += 1
        ) {
          const sampleX = mirroredIndex(x + offset, width);
          value += source[(y * width + sampleX) * 3 + channel]
            * SPATIAL_BLUR_KERNEL[offset + SPATIAL_BLUR_RADIUS];
        }
        horizontal[(y * width + x) * 3 + channel] = value;
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let value = 0;
        for (
          let offset = -SPATIAL_BLUR_RADIUS;
          offset <= SPATIAL_BLUR_RADIUS;
          offset += 1
        ) {
          const sampleY = mirroredIndex(y + offset, height);
          value += horizontal[(sampleY * width + x) * 3 + channel]
            * SPATIAL_BLUR_KERNEL[offset + SPATIAL_BLUR_RADIUS];
        }
        output[(y * width + x) * 3 + channel] = value;
      }
    }
  }
  return output;
}

function renderSpatialFieldPixels(
  field: SpatialColorField,
  width: number,
  height: number,
  phaseIndex: number,
): Uint8ClampedArray {
  const safeWidth = Number.isFinite(width)
    ? Math.min(MAX_SPATIAL_FIELD_WIDTH, Math.max(1, Math.floor(width)))
    : SPATIAL_FIELD_CANVAS_WIDTH;
  const safeHeight = Number.isFinite(height)
    ? Math.min(MAX_SPATIAL_FIELD_HEIGHT, Math.max(1, Math.floor(height)))
    : SPATIAL_FIELD_CANVAS_HEIGHT;
  const normalized = normalizedField(field);
  const seed = hashFor(field.id);
  const phase = ((Math.round(phaseIndex) % SPATIAL_FIELD_PHASE_COUNT)
    + SPATIAL_FIELD_PHASE_COUNT) % SPATIAL_FIELD_PHASE_COUNT;
  const linearPixels = new Float32Array(safeWidth * safeHeight * 3);

  for (let y = 0; y < safeHeight; y += 1) {
    const normalizedY = safeHeight === 1 ? 0 : y / (safeHeight - 1);
    for (let x = 0; x < safeWidth; x += 1) {
      const normalizedX = safeWidth === 1 ? 0 : x / (safeWidth - 1);
      const [sampleX, sampleY] = flowCoordinates(normalizedX, normalizedY, seed, phase);
      const color = interpolateColor(
        normalized.colors,
        normalized.columns,
        normalized.rows,
        sampleX,
        sampleY,
      );
      const radial = ((normalizedX - 0.5) / 0.72) ** 2
        + ((normalizedY - 0.47) / 0.78) ** 2;
      const baseMix = 0.025 + smoothstep((radial - 0.2) / 0.8) * 0.105;
      const index = (y * safeWidth + x) * 3;
      linearPixels[index] = lerp(color[0], normalized.base[0], baseMix);
      linearPixels[index + 1] = lerp(color[1], normalized.base[1], baseMix);
      linearPixels[index + 2] = lerp(color[2], normalized.base[2], baseMix);
    }
  }
  const blurred = blurLinearPixels(linearPixels, safeWidth, safeHeight);
  const output = new Uint8ClampedArray(safeWidth * safeHeight * 4);
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      const inputIndex = (y * safeWidth + x) * 3;
      const outputIndex = (y * safeWidth + x) * 4;
      const dither = (hashNoise(x, y, seed ^ 0x6d2b79f5) - 0.5) * 0.9;
      output[outputIndex] = linearToSrgb(blurred[inputIndex]) + dither;
      output[outputIndex + 1] = linearToSrgb(blurred[inputIndex + 1]) + dither;
      output[outputIndex + 2] = linearToSrgb(blurred[inputIndex + 2]) + dither;
      output[outputIndex + 3] = 255;
    }
  }
  return output;
}

export function spatialFieldPixels(
  field: SpatialColorField,
  width = SPATIAL_FIELD_CANVAS_WIDTH,
  height = SPATIAL_FIELD_CANVAS_HEIGHT,
): Uint8ClampedArray {
  return renderSpatialFieldPixels(field, width, height, 0);
}

export function spatialFieldFlowPixels(
  field: SpatialColorField,
  width = SPATIAL_FIELD_CANVAS_WIDTH,
  height = SPATIAL_FIELD_CANVAS_HEIGHT,
): Uint8ClampedArray {
  return renderSpatialFieldPixels(field, width, height, 1);
}

export function spatialFieldDriftPixels(
  field: SpatialColorField,
  width = SPATIAL_FIELD_CANVAS_WIDTH,
  height = SPATIAL_FIELD_CANVAS_HEIGHT,
): Uint8ClampedArray {
  return renderSpatialFieldPixels(field, width, height, 2);
}

export function spatialFieldFallbackPixels(
  field: SpatialColorField,
): Uint8ClampedArray {
  const compact = renderSpatialFieldPixels(
    field,
    SPATIAL_FALLBACK_WIDTH,
    SPATIAL_FALLBACK_HEIGHT,
    0,
  );
  const output = new Uint8ClampedArray(
    SPATIAL_FIELD_CANVAS_WIDTH * SPATIAL_FIELD_CANVAS_HEIGHT * 4,
  );

  for (let y = 0; y < SPATIAL_FIELD_CANVAS_HEIGHT; y += 1) {
    const sourceY = y / (SPATIAL_FIELD_CANVAS_HEIGHT - 1) * (SPATIAL_FALLBACK_HEIGHT - 1);
    const top = Math.floor(sourceY);
    const bottom = Math.min(SPATIAL_FALLBACK_HEIGHT - 1, top + 1);
    const progressY = sourceY - top;
    for (let x = 0; x < SPATIAL_FIELD_CANVAS_WIDTH; x += 1) {
      const sourceX = x / (SPATIAL_FIELD_CANVAS_WIDTH - 1) * (SPATIAL_FALLBACK_WIDTH - 1);
      const left = Math.floor(sourceX);
      const right = Math.min(SPATIAL_FALLBACK_WIDTH - 1, left + 1);
      const progressX = sourceX - left;
      const outputIndex = (y * SPATIAL_FIELD_CANVAS_WIDTH + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const topColor = lerp(
          compact[(top * SPATIAL_FALLBACK_WIDTH + left) * 4 + channel],
          compact[(top * SPATIAL_FALLBACK_WIDTH + right) * 4 + channel],
          progressX,
        );
        const bottomColor = lerp(
          compact[(bottom * SPATIAL_FALLBACK_WIDTH + left) * 4 + channel],
          compact[(bottom * SPATIAL_FALLBACK_WIDTH + right) * 4 + channel],
          progressX,
        );
        output[outputIndex + channel] = lerp(topColor, bottomColor, progressY);
      }
      output[outputIndex + 3] = 255;
    }
  }
  return output;
}

export function paintSpatialField(
  canvas: HTMLCanvasElement,
  field: SpatialColorField,
  preparedPixels?: Uint8ClampedArray,
): boolean {
  if (
    canvas.width < 1
    || canvas.height < 1
    || canvas.width > MAX_SPATIAL_FIELD_WIDTH
    || canvas.height > MAX_SPATIAL_FIELD_HEIGHT
  ) return false;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return false;
  const image = context.createImageData(canvas.width, canvas.height);
  const pixels = preparedPixels?.length === image.data.length
    ? preparedPixels
    : spatialFieldPixels(field, canvas.width, canvas.height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return true;
}
