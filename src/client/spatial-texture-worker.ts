import {
  spatialFieldDriftPixels,
  spatialFieldFlowPixels,
  spatialFieldPixels,
  type SpatialColorField,
} from './spatial-field.js';

export interface SpatialTextureWorkerRequest {
  id: number;
  field: SpatialColorField;
}

export interface SpatialTextureWorkerResponse {
  id: number;
  base: Uint8ClampedArray;
  flow: Uint8ClampedArray;
  drift: Uint8ClampedArray;
}

type SpatialTextureWorkerScope = {
  onmessage: ((event: MessageEvent<SpatialTextureWorkerRequest>) => void) | null;
  postMessage: (message: SpatialTextureWorkerResponse, transfer: Transferable[]) => void;
};

const workerScope = globalThis as unknown as SpatialTextureWorkerScope;

workerScope.onmessage = ({ data }) => {
  const base = spatialFieldPixels(data.field);
  const flow = spatialFieldFlowPixels(data.field);
  const drift = spatialFieldDriftPixels(data.field);
  workerScope.postMessage(
    { id: data.id, base, flow, drift },
    [
      base.buffer as ArrayBuffer,
      flow.buffer as ArrayBuffer,
      drift.buffer as ArrayBuffer,
    ],
  );
};
