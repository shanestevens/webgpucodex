import createCppKernelModule from "./generated-wasm/cpp-kernel.mjs";
import cppKernelWasmUrl from "./generated-wasm/cpp-kernel.wasm?url";

export type PolygonAnalysis = {
  totalArea: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type HeightfieldAnalysis = {
  min: number;
  max: number;
  average: number;
  sum: number;
};

export type PackingAnalysis = {
  min: number;
  max: number;
  average: number;
  checksum: number;
  packed: Uint8Array;
};

export type HeightfieldMeshBuild = {
  vertexCount: number;
  triangleCount: number;
  min: number;
  max: number;
  average: number;
  checksum: number;
  positions: Float32Array;
  indices: Uint32Array;
};

export type SwarmRunner = {
  count: number;
  step: (delta: number, time: number, substeps: number, options?: { copyOut?: boolean }) => Float32Array;
  simulate: (frames: number, delta: number, startTime: number, substeps: number, options?: { copyOut?: boolean }) => Float32Array;
  reset: (baseState?: Float32Array) => void;
};

type CppKernelModule = {
  HEAPF32: Float32Array;
  HEAPU32: Uint32Array;
  HEAPU8: Uint8Array;
  _malloc: (byteLength: number) => number;
  _free: (ptr: number) => void;
  _analyze_polygon: (ptr: number, loops: number, verticesPerLoop: number, resultPtr: number) => void;
  _analyze_heightfield: (ptr: number, count: number, resultPtr: number) => void;
  _quantize_unit_f32: (ptr: number, count: number, outPtr: number, resultPtr: number) => void;
  _build_heightfield_mesh: (
    ptr: number,
    width: number,
    height: number,
    positionPtr: number,
    indexPtr: number,
    resultPtr: number,
  ) => void;
  _step_rotation: (angle: number, delta: number, speed: number) => number;
  _update_swarm: (
    statePtr: number,
    count: number,
    outputPtr: number,
    delta: number,
    time: number,
    substeps: number,
  ) => void;
  _simulate_swarm_frames: (
    statePtr: number,
    count: number,
    outputPtr: number,
    delta: number,
    startTime: number,
    substeps: number,
    frames: number,
  ) => void;
  wasmMemory?: WebAssembly.Memory;
};

type GeometryKernelInstance = {
  memory: WebAssembly.Memory;
  analyzePolygon: (points: Float32Array, loops: number, verticesPerLoop: number) => PolygonAnalysis;
  analyzeHeightfield: (values: Float32Array) => HeightfieldAnalysis;
  quantizeUnitFloats: (values: Float32Array) => PackingAnalysis;
  buildHeightfieldMesh: (
    values: Float32Array,
    width: number,
    height: number,
    options?: { copyOut?: boolean },
  ) => HeightfieldMeshBuild;
  stepRotation: (angle: number, delta: number, speed: number) => number;
  createSwarmRunner: (baseState: Float32Array) => SwarmRunner;
};

type ScratchBuffer = {
  ptr: number;
  capacity: number;
};

let cachedKernelPromise: Promise<GeometryKernelInstance> | null = null;

async function instantiateKernel(): Promise<GeometryKernelInstance> {
  const module = await createCppKernelModule({
    locateFile(path: string) {
      if (path.endsWith(".wasm")) {
        return cppKernelWasmUrl;
      }

      return path;
    },
  });

  const memory =
    module.wasmMemory ??
    ({
      get buffer() {
        return module.HEAPU8.buffer;
      },
    } as WebAssembly.Memory);

  const inputBuffer: ScratchBuffer = { ptr: 0, capacity: 0 };
  const outputBuffer: ScratchBuffer = { ptr: 0, capacity: 0 };
  const resultBuffer: ScratchBuffer = { ptr: 0, capacity: 0 };

  const ensureBuffer = (buffer: ScratchBuffer, byteLength: number) => {
    if (buffer.capacity >= byteLength) {
      return buffer.ptr;
    }

    if (buffer.ptr !== 0) {
      module._free(buffer.ptr);
    }

    buffer.ptr = module._malloc(byteLength);
    buffer.capacity = byteLength;
    return buffer.ptr;
  };

  const ensureInputBuffer = (byteLength: number) => ensureBuffer(inputBuffer, byteLength);
  const ensureOutputBuffer = (byteLength: number) => ensureBuffer(outputBuffer, byteLength);
  const ensureResultBuffer = (byteLength: number) => ensureBuffer(resultBuffer, byteLength);

  return {
    memory,
    analyzePolygon(points, loops, verticesPerLoop) {
      const inputPtr = ensureInputBuffer(points.byteLength);
      const resultPtr = ensureResultBuffer(5 * 4);

      module.HEAPF32.set(points, inputPtr >>> 2);
      module._analyze_polygon(inputPtr, loops, verticesPerLoop, resultPtr);

      const result = module.HEAPF32.subarray(resultPtr >>> 2, (resultPtr >>> 2) + 5);
      return {
        totalArea: result[0],
        minX: result[1],
        minY: result[2],
        maxX: result[3],
        maxY: result[4],
      };
    },
    analyzeHeightfield(values) {
      const inputPtr = ensureInputBuffer(values.byteLength);
      const resultPtr = ensureResultBuffer(4 * 4);

      module.HEAPF32.set(values, inputPtr >>> 2);
      module._analyze_heightfield(inputPtr, values.length, resultPtr);

      const result = module.HEAPF32.subarray(resultPtr >>> 2, (resultPtr >>> 2) + 4);
      return {
        min: result[0],
        max: result[1],
        average: result[2],
        sum: result[3],
      };
    },
    quantizeUnitFloats(values) {
      const inputPtr = ensureInputBuffer(values.byteLength);
      const outputPtr = ensureOutputBuffer(values.length);
      const resultPtr = ensureResultBuffer(4 * 4);

      module.HEAPF32.set(values, inputPtr >>> 2);
      module._quantize_unit_f32(inputPtr, values.length, outputPtr, resultPtr);

      const result = module.HEAPF32.subarray(resultPtr >>> 2, (resultPtr >>> 2) + 4);
      const packed = module.HEAPU8.slice(outputPtr, outputPtr + values.length);

      return {
        min: result[0],
        max: result[1],
        average: result[2],
        checksum: result[3],
        packed,
      };
    },
    buildHeightfieldMesh(values, width, height, options) {
      const vertexCount = width * height;
      const triangleCount = Math.max(width - 1, 0) * Math.max(height - 1, 0) * 2;
      const indexCount = triangleCount * 3;
      const positionsByteLength = vertexCount * 3 * 4;
      const indicesByteLength = indexCount * 4;
      const inputPtr = ensureInputBuffer(values.byteLength);
      const outputPtr = ensureOutputBuffer(positionsByteLength + indicesByteLength);
      const resultPtr = ensureResultBuffer(6 * 4);
      const positionsPtr = outputPtr;
      const indicesPtr = positionsPtr + positionsByteLength;

      module.HEAPF32.set(values, inputPtr >>> 2);
      module._build_heightfield_mesh(inputPtr, width, height, positionsPtr, indicesPtr, resultPtr);

      const result = module.HEAPF32.subarray(resultPtr >>> 2, (resultPtr >>> 2) + 6);
      const positionsView = module.HEAPF32.subarray(positionsPtr >>> 2, (positionsPtr >>> 2) + vertexCount * 3);
      const indicesView = module.HEAPU32.subarray(indicesPtr >>> 2, (indicesPtr >>> 2) + indexCount);
      const copyOut = options?.copyOut ?? false;

      return {
        vertexCount: result[0],
        triangleCount: result[1],
        min: result[2],
        max: result[3],
        average: result[4],
        checksum: result[5],
        positions: copyOut ? positionsView.slice() : positionsView,
        indices: copyOut ? indicesView.slice() : indicesView,
      };
    },
    stepRotation(angle, delta, speed) {
      return module._step_rotation(angle, delta, speed);
    },
    createSwarmRunner(baseState) {
      const stride = 10;
      const count = Math.trunc(baseState.length / stride);

      if (count <= 0 || count * stride !== baseState.length) {
        throw new Error("Swarm state must be a Float32Array with 10 floats per entity.");
      }

      const statePtr = module._malloc(baseState.byteLength);
      const outputPtr = module._malloc(count * 3 * 4);

      const copyIntoState = (source: Float32Array) => {
        module.HEAPF32.set(source, statePtr >>> 2);
      };

      copyIntoState(baseState);

      return {
        count,
        step(delta, time, substeps, options) {
          module._update_swarm(statePtr, count, outputPtr, delta, time, substeps);
          const positions = module.HEAPF32.subarray(outputPtr >>> 2, (outputPtr >>> 2) + count * 3);
          return options?.copyOut ? positions.slice() : positions;
        },
        simulate(frames, delta, startTime, substeps, options) {
          module._simulate_swarm_frames(statePtr, count, outputPtr, delta, startTime, substeps, frames);
          const positions = module.HEAPF32.subarray(outputPtr >>> 2, (outputPtr >>> 2) + count * 3);
          return options?.copyOut ? positions.slice() : positions;
        },
        reset(sourceState) {
          copyIntoState(sourceState ?? baseState);
        },
      };
    },
  };
}

export async function loadGeometryKernel(): Promise<GeometryKernelInstance> {
  cachedKernelPromise ??= instantiateKernel();
  return cachedKernelPromise;
}
