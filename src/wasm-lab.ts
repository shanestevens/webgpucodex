import * as THREE from "three";
import {
  loadGeometryKernel,
  type HeightfieldMeshBuild,
  type PackingAnalysis,
  type PolygonAnalysis,
  type SwarmRunner,
} from "./wasm-geometry";
import { loadRapier } from "./wasm-rapier";

type WasmLabOptions = {
  prefersTouchInput: boolean;
  hasNativeWebGPU: boolean;
};

export type WasmLabHandle = {
  setVisible: (visible: boolean) => void;
  dispose: () => void;
};

type TrackId = "geometry" | "terrain" | "packing";
type WorkloadId = "small" | "medium" | "large" | "huge";

type WasmTrack = {
  id: TrackId;
  title: string;
  summary: string;
  why: string;
  dataIn: string;
  dataOut: string;
  milestone: string;
  liveTitle: string;
  liveSummary: string;
};

type WorkloadOption = {
  id: WorkloadId;
  label: string;
  description: string;
};

type GeometryDataset = {
  points: Float32Array;
  loops: number;
  verticesPerLoop: number;
};

type TerrainDataset = {
  values: Float32Array;
  width: number;
  height: number;
};

type PackingDataset = {
  values: Float32Array;
};

type SwarmDataset = {
  baseState: Float32Array;
  count: number;
};

type GeometryBenchmarkResult = PolygonAnalysis & {
  elapsed: number;
  loops: number;
  vertices: number;
  boundsWidth: number;
  boundsHeight: number;
};

type TerrainMeshBenchmarkResult = {
  elapsed: number;
  samples: number;
  vertexCount: number;
  triangleCount: number;
  min: number;
  max: number;
  average: number;
  checksum: number;
};

type TerrainMeshPreviewResult = HeightfieldMeshBuild & {
  width: number;
  height: number;
};

type PackingBenchmarkResult = PackingAnalysis & {
  elapsed: number;
  samples: number;
};

type SwarmBenchmarkResult = {
  elapsed: number;
  repeats: number;
  entities: number;
  frames: number;
  substeps: number;
  averageRadius: number;
  averageHeight: number;
  checksum: number;
};

type WasmBenchmarkResult =
  | GeometryBenchmarkResult
  | TerrainMeshBenchmarkResult
  | PackingBenchmarkResult;

type CubeDriver = "js" | "wasm";
type SwarmDriver = "js" | "wasm";

type TerrainPreviewDriver = "js" | "wasm";

type CubePreviewHandle = {
  setVisible: (visible: boolean) => void;
  setTrack: (trackId: TrackId) => void;
  setDriver: (driver: CubeDriver) => void;
  dispose: () => void;
};

type TerrainPreviewHandle = {
  setMesh: (mesh: TerrainMeshPreviewResult, driver: TerrainPreviewDriver) => void;
  setDriver: (driver: TerrainPreviewDriver) => void;
  dispose: () => void;
};

type SwarmPreviewHandle = {
  setVisible: (visible: boolean) => void;
  setDriver: (driver: SwarmDriver) => void;
  setBenchmarking: (benchmarking: boolean) => void;
  dispose: () => void;
};

type PhysicsPreviewHandle = {
  setVisible: (visible: boolean) => void;
  restack: () => void;
  burst: () => void;
  dispose: () => void;
};

const TRACKS: WasmTrack[] = [
  {
    id: "geometry",
    title: "Geometry Kernel",
    summary: "Small-kernel learning step: bounds and area scans for planning-style polygon loops.",
    why: "This is still a strong future WASM target for the project, but as a live benchmark it is intentionally small enough that JavaScript can stay very competitive.",
    dataIn: "Wall segment endpoints, room rectangles, wall thickness, and height values as flat typed arrays.",
    dataOut: "Closed loops, floor triangles, wall bands, and validation diagnostics ready for Three.js buffers.",
    milestone: "Use this to learn the boundary cost, then move next into heavier loop cleanup or triangulation.",
    liveTitle: "Polygon analysis kernel",
    liveSummary: "Compiled C++ reads flat XY point buffers, computes area with the shoelace formula, and returns min/max bounds.",
  },
  {
    id: "terrain",
    title: "Terrain Mesh Builder",
    summary: "Turn a heightfield chunk into render-ready vertex positions and indices that Three.js can consume directly.",
    why: "This is the first truly engine-shaped WASM example here: one batched kernel transforms raw samples into GPU-friendly mesh buffers.",
    dataIn: "Heightfield sample grids plus chunk width and height as plain typed arrays and integers.",
    dataOut: "Vertex positions, triangle indices, and per-chunk min/max/average stats ready for BufferGeometry creation.",
    milestone: "Generate one terrain chunk in WASM, validate it against JS, and hand the output straight to Three.js.",
    liveTitle: "Heightfield mesh kernel",
    liveSummary: "The live module builds a terrain chunk from raw height samples and emits render-ready mesh buffers.",
  },
  {
    id: "packing",
    title: "Data Packing",
    summary: "Buffer packing, export cleanup, plan simplification, and AI-reference prep before data leaves the app.",
    why: "Packing and quantization are perfect WASM work because they are hot loops over plain arrays with almost no UI coupling.",
    dataIn: "Normalized float channels, plan weights, masks, and later on real export buffers.",
    dataOut: "Packed byte buffers, checksums, and compact analysis that TypeScript can ship onward or render.",
    milestone: "Quantize float channels in WASM, prove correctness, then use the same path for future export prep.",
    liveTitle: "Packing / quantization kernel",
    liveSummary: "The live module converts unit floats into packed bytes and returns checksum and range information for verification.",
  },
];

const WORKLOADS: WorkloadOption[] = [
  { id: "small", label: "Small", description: "Good for correctness checks" },
  { id: "medium", label: "Medium", description: "Balanced default" },
  { id: "large", label: "Large", description: "Starts stressing the kernel" },
  { id: "huge", label: "Huge", description: "Pressure test" },
];

const BENCHMARK_REPEATS = 24;
const SWARM_STATE_STRIDE = 10;
const SWARM_PREVIEW_ENTITIES = 5000;
const SWARM_BENCHMARK_ENTITIES = 20000;
const SWARM_BENCHMARK_FRAMES = 180;
const SWARM_BENCHMARK_REPEATS = 6;
const SWARM_SUBSTEPS = 4;
const geometryBenchmarkDatasets = new Map<WorkloadId, GeometryDataset>();
let geometryPreviewDataset: GeometryDataset | null = null;
const terrainBenchmarkDatasets = new Map<WorkloadId, TerrainDataset>();
let terrainPreviewDataset: TerrainDataset | null = null;
const packingBenchmarkDatasets = new Map<WorkloadId, PackingDataset>();
let packingPreviewDataset: PackingDataset | null = null;
const swarmDatasetCache = new Map<number, SwarmDataset>();

function createGeometryDataset(loops: number, verticesPerLoop: number, columns: number, spacingX: number, spacingY: number) {
  const points = new Float32Array(loops * verticesPerLoop * 2);

  for (let loopIndex = 0; loopIndex < loops; loopIndex += 1) {
    const base = loopIndex * verticesPerLoop * 2;
    const centerX = (loopIndex % columns) * spacingX + 2.8;
    const centerY = Math.floor(loopIndex / columns) * spacingY + 2.8;
    const radiusX = 1.5 + (loopIndex % 3) * 0.28;
    const radiusY = 1.15 + (loopIndex % 4) * 0.2;
    const wobble = 0.16 + (loopIndex % 5) * 0.03;

    for (let vertex = 0; vertex < verticesPerLoop; vertex += 1) {
      const angle = (vertex / verticesPerLoop) * Math.PI * 2;
      const wave = 1 + Math.sin(angle * 3 + loopIndex * 0.65) * wobble;
      points[base + vertex * 2] = centerX + Math.cos(angle) * radiusX * wave;
      points[base + vertex * 2 + 1] = centerY + Math.sin(angle) * radiusY * wave;
    }
  }

  return { points, loops, verticesPerLoop };
}

function getGeometryBenchmarkDataset(workload: WorkloadId) {
  let dataset = geometryBenchmarkDatasets.get(workload);

  if (!dataset) {
    dataset =
      workload === "small"
        ? createGeometryDataset(400, 24, 20, 0.48, 0.38)
        : workload === "medium"
          ? createGeometryDataset(1600, 32, 40, 0.2, 0.2)
          : workload === "large"
            ? createGeometryDataset(3600, 36, 60, 0.14, 0.14)
            : createGeometryDataset(6400, 40, 80, 0.11, 0.11);
    geometryBenchmarkDatasets.set(workload, dataset);
  }

  return dataset;
}

function getGeometryPreviewDataset() {
  geometryPreviewDataset ??= createGeometryDataset(9, 24, 3, 6.4, 5.8);
  return geometryPreviewDataset;
}

function createTerrainDataset(width: number, height: number): TerrainDataset {
  const values = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / Math.max(width - 1, 1);
      const ny = y / Math.max(height - 1, 1);
      const dx = nx - 0.5;
      const dy = ny - 0.5;
      const ridge = Math.sin(nx * 8.2) * Math.cos(ny * 6.4) * 0.22;
      const mound = Math.exp(-(dx * dx * 7.5 + dy * dy * 10)) * 0.48;
      const wave = Math.sin((nx + ny) * 10.5) * 0.08;
      values[y * width + x] = ridge + mound + wave;
    }
  }

  return { values, width, height };
}

function getTerrainBenchmarkDataset(workload: WorkloadId) {
  let dataset = terrainBenchmarkDatasets.get(workload);

  if (!dataset) {
    dataset =
      workload === "small"
        ? createTerrainDataset(96, 96)
        : workload === "medium"
          ? createTerrainDataset(192, 192)
          : workload === "large"
            ? createTerrainDataset(320, 320)
            : createTerrainDataset(448, 448);
    terrainBenchmarkDatasets.set(workload, dataset);
  }

  return dataset;
}

function getTerrainPreviewDataset() {
  terrainPreviewDataset ??= createTerrainDataset(40, 28);
  return terrainPreviewDataset;
}

function createPackingDataset(count: number): PackingDataset {
  const values = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    const t = index / Math.max(count - 1, 1);
    const base = 0.5 + Math.sin(t * Math.PI * 10.4) * 0.22;
    const ripple = Math.cos(t * Math.PI * 26) * 0.08;
    const envelope = 0.2 + Math.sin(t * Math.PI * 2.2) * 0.18;
    values[index] = Math.min(1, Math.max(0, base + ripple + envelope));
  }

  return { values };
}

function getPackingBenchmarkDataset(workload: WorkloadId) {
  let dataset = packingBenchmarkDatasets.get(workload);

  if (!dataset) {
    dataset =
      workload === "small"
        ? createPackingDataset(4096)
        : workload === "medium"
          ? createPackingDataset(16384)
          : workload === "large"
            ? createPackingDataset(65536)
            : createPackingDataset(262144);
    packingBenchmarkDatasets.set(workload, dataset);
  }

  return dataset;
}

function getPackingPreviewDataset() {
  packingPreviewDataset ??= createPackingDataset(96);
  return packingPreviewDataset;
}

function createSwarmDataset(count: number): SwarmDataset {
  const baseState = new Float32Array(count * SWARM_STATE_STRIDE);

  for (let index = 0; index < count; index += 1) {
    const offset = index * SWARM_STATE_STRIDE;
    const t = index / Math.max(count - 1, 1);
    const ring = index % 5;
    const angle = t * Math.PI * 2 * 11 + ring * 0.37;
    const radius = 1.9 + ring * 0.38 + (index % 7) * 0.04;
    const homeX = Math.cos(angle) * radius;
    const homeY = 0.75 + (((index % 23) / 22) - 0.5) * 2.2;
    const homeZ = Math.sin(angle) * radius;

    baseState[offset] = homeX;
    baseState[offset + 1] = homeY;
    baseState[offset + 2] = homeZ;
    baseState[offset + 3] = homeX + Math.sin(index * 1.7) * 0.16;
    baseState[offset + 4] = homeY + Math.cos(index * 1.3) * 0.12;
    baseState[offset + 5] = homeZ + Math.sin(index * 1.1) * 0.16;
    baseState[offset + 6] = 0;
    baseState[offset + 7] = 0;
    baseState[offset + 8] = 0;
    baseState[offset + 9] = (index % 97) / 97;
  }

  return { baseState, count };
}

function getSwarmDataset(count: number) {
  let dataset = swarmDatasetCache.get(count);

  if (!dataset) {
    dataset = createSwarmDataset(count);
    swarmDatasetCache.set(count, dataset);
  }

  return dataset;
}

function copySwarmPositionsFromState(state: Float32Array, output: Float32Array) {
  const count = Math.trunc(state.length / SWARM_STATE_STRIDE);

  for (let index = 0; index < count; index += 1) {
    const stateOffset = index * SWARM_STATE_STRIDE;
    const outputOffset = index * 3;
    output[outputOffset] = state[stateOffset + 3];
    output[outputOffset + 1] = state[stateOffset + 4];
    output[outputOffset + 2] = state[stateOffset + 5];
  }
}

function updateSwarmInJs(state: Float32Array, output: Float32Array, delta: number, time: number, substeps: number) {
  const count = Math.trunc(state.length / SWARM_STATE_STRIDE);
  const steps = Math.max(1, Math.trunc(substeps));
  const subDelta = delta / steps;

  for (let index = 0; index < count; index += 1) {
    const offset = index * SWARM_STATE_STRIDE;
    const homeX = state[offset];
    const homeY = state[offset + 1];
    const homeZ = state[offset + 2];
    let posX = state[offset + 3];
    let posY = state[offset + 4];
    let posZ = state[offset + 5];
    let velX = state[offset + 6];
    let velY = state[offset + 7];
    let velZ = state[offset + 8];
    let phase = state[offset + 9];

    for (let step = 0; step < steps; step += 1) {
      phase += subDelta * (0.55 + homeY * 0.015);

      if (phase >= 1) {
        phase -= 1;
      }

      const pulse = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      const dx = homeX - posX;
      const dy = homeY - posY;
      const dz = homeZ - posZ;
      const swirlX = -dz * 0.48;
      const swirlZ = dx * 0.48;
      const lift = (pulse - 0.5) * 0.55 + (time + homeX * 0.12 + homeZ * 0.08) * 0.25;

      velX = velX * 0.94 + dx * (0.68 * subDelta) + swirlX * (0.42 * subDelta) + (homeY + 0.3) * (0.015 * subDelta);
      velY = velY * 0.92 + dy * (0.62 * subDelta) + lift * (0.38 * subDelta);
      velZ = velZ * 0.94 + dz * (0.68 * subDelta) + swirlZ * (0.42 * subDelta) - (homeX - homeZ) * (0.01 * subDelta);

      posX += velX * subDelta;
      posY += velY * subDelta;
      posZ += velZ * subDelta;
    }

    state[offset + 3] = posX;
    state[offset + 4] = posY;
    state[offset + 5] = posZ;
    state[offset + 6] = velX;
    state[offset + 7] = velY;
    state[offset + 8] = velZ;
    state[offset + 9] = phase;

    const outputOffset = index * 3;
    output[outputOffset] = posX;
    output[outputOffset + 1] = posY;
    output[outputOffset + 2] = posZ;
  }
}

function summarizeSwarmPositions(positions: Float32Array) {
  let radiusSum = 0;
  let heightSum = 0;
  let checksum = 0;
  const count = Math.trunc(positions.length / 3);

  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    radiusSum += Math.hypot(x, z);
    heightSum += y;
    checksum += x * 0.37 + y * 0.53 + z * 0.71;
  }

  return {
    averageRadius: radiusSum / Math.max(count, 1),
    averageHeight: heightSum / Math.max(count, 1),
    checksum,
  };
}

function analyzeGeometryInJs(points: Float32Array, loops: number, verticesPerLoop: number): PolygonAnalysis {
  let totalArea = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let loopIndex = 0; loopIndex < loops; loopIndex += 1) {
    const base = loopIndex * verticesPerLoop * 2;
    let area = 0;

    for (let vertex = 0; vertex < verticesPerLoop; vertex += 1) {
      const next = (vertex + 1) % verticesPerLoop;
      const x1 = points[base + vertex * 2];
      const y1 = points[base + vertex * 2 + 1];
      const x2 = points[base + next * 2];
      const y2 = points[base + next * 2 + 1];
      area += x1 * y2 - x2 * y1;
      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x1);
      maxY = Math.max(maxY, y1);
    }

    totalArea += Math.abs(area) * 0.5;
  }

  return { totalArea, minX, minY, maxX, maxY };
}

function createTerrainMeshBuffers(width: number, height: number) {
  const vertexCount = width * height;
  const triangleCount = Math.max(width - 1, 0) * Math.max(height - 1, 0) * 2;

  return {
    positions: new Float32Array(vertexCount * 3),
    indices: new Uint32Array(triangleCount * 3),
  };
}

function buildHeightfieldMeshInJs(
  values: Float32Array,
  width: number,
  height: number,
  buffers: ReturnType<typeof createTerrainMeshBuffers>,
) {
  const { positions, indices } = buffers;
  const widthDenominator = Math.max(width - 1, 1);
  const heightDenominator = Math.max(height - 1, 1);
  const scaleX = 8.4;
  const scaleZ = 6.4;
  const verticalScale = 2.6;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const value = values[index];
      const vertexOffset = index * 3;
      const fx = x / widthDenominator;
      const fy = y / heightDenominator;

      positions[vertexOffset] = fx * scaleX - scaleX * 0.5;
      positions[vertexOffset + 1] = value * verticalScale;
      positions[vertexOffset + 2] = fy * scaleZ - scaleZ * 0.5;

      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
    }
  }

  let writeIndex = 0;

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const a = y * width + x;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      const h00 = values[a];
      const h10 = values[b];
      const h01 = values[c];
      const h11 = values[d];

      if (Math.abs(h00 - h11) <= Math.abs(h10 - h01)) {
        indices[writeIndex] = a;
        indices[writeIndex + 1] = b;
        indices[writeIndex + 2] = d;
        indices[writeIndex + 3] = a;
        indices[writeIndex + 4] = d;
        indices[writeIndex + 5] = c;
      } else {
        indices[writeIndex] = a;
        indices[writeIndex + 1] = b;
        indices[writeIndex + 2] = c;
        indices[writeIndex + 3] = b;
        indices[writeIndex + 4] = d;
        indices[writeIndex + 5] = c;
      }

      writeIndex += 6;
    }
  }

  return {
    vertexCount: width * height,
    triangleCount: (width - 1) * (height - 1) * 2,
    min,
    max,
    average: sum / Math.max(values.length, 1),
    checksum: sum,
  };
}

function createTerrainPreviewMeshInJs(dataset: TerrainDataset): TerrainMeshPreviewResult {
  const buffers = createTerrainMeshBuffers(dataset.width, dataset.height);
  const stats = buildHeightfieldMeshInJs(dataset.values, dataset.width, dataset.height, buffers);

  return {
    ...stats,
    width: dataset.width,
    height: dataset.height,
    positions: buffers.positions.slice(),
    indices: buffers.indices.slice(),
  };
}

function quantizeUnitFloatsInJs(values: Float32Array): PackingAnalysis {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let checksum = 0;
  const packed = new Uint8Array(values.length);

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    const quantized = Math.max(0, Math.min(255, Math.trunc(value * 255)));
    packed[index] = quantized;
    checksum += quantized;
  }

  return { min, max, average: sum / Math.max(values.length, 1), checksum, packed };
}

function benchmark<T extends object>(run: () => T): T & { elapsed: number } {
  const started = performance.now();
  let result = run();

  for (let iteration = 1; iteration < BENCHMARK_REPEATS; iteration += 1) {
    result = run();
  }

  return {
    ...result,
    elapsed: (performance.now() - started) / BENCHMARK_REPEATS,
  };
}

function formatGeometryResult(label: string, result: GeometryBenchmarkResult) {
  return `${label}: ${result.elapsed.toFixed(2)} ms avg across ${BENCHMARK_REPEATS} runs for ${result.loops.toLocaleString()} loops / ${result.vertices.toLocaleString()} vertices (${result.boundsWidth.toFixed(1)} m x ${result.boundsHeight.toFixed(1)} m bounds, ${result.totalArea.toFixed(0)} m2 total area).`;
}

function formatTerrainResult(label: string, result: TerrainMeshBenchmarkResult) {
  return `${label}: ${result.elapsed.toFixed(2)} ms avg across ${BENCHMARK_REPEATS} runs for ${result.samples.toLocaleString()} samples -> ${result.vertexCount.toLocaleString()} vertices / ${result.triangleCount.toLocaleString()} triangles (min ${result.min.toFixed(3)}, max ${result.max.toFixed(3)}, avg ${result.average.toFixed(3)}).`;
}

function formatPackingResult(label: string, result: PackingBenchmarkResult) {
  return `${label}: ${result.elapsed.toFixed(2)} ms avg across ${BENCHMARK_REPEATS} runs for ${result.samples.toLocaleString()} floats (min ${result.min.toFixed(3)}, max ${result.max.toFixed(3)}, avg ${result.average.toFixed(3)}, checksum ${Math.round(result.checksum)}).`;
}

function formatGeometryCompare(jsResult: GeometryBenchmarkResult, wasmResult: GeometryBenchmarkResult) {
  const ratio = wasmResult.elapsed > 0 ? jsResult.elapsed / wasmResult.elapsed : 0;
  const areaDelta = Math.abs(jsResult.totalArea - wasmResult.totalArea);
  const boundsDelta = Math.max(
    Math.abs(jsResult.minX - wasmResult.minX),
    Math.abs(jsResult.minY - wasmResult.minY),
    Math.abs(jsResult.maxX - wasmResult.maxX),
    Math.abs(jsResult.maxY - wasmResult.maxY),
  );
  const suffix = ratio >= 1
    ? " This is the shape of workload where a heavier geometry kernel might benefit even more."
    : " That is normal here: this kernel is tiny, so JS↔WASM boundary and memory-copy cost dominate.";

  return `JS ${jsResult.elapsed.toFixed(2)} ms vs WASM ${wasmResult.elapsed.toFixed(2)} ms. ${ratio >= 1 ? `WASM is ${ratio.toFixed(2)}x faster.` : `WASM is ${(1 / Math.max(ratio, 0.0001)).toFixed(2)}x slower.`} Area delta ${areaDelta.toFixed(4)}, bounds delta ${boundsDelta.toFixed(4)}.${suffix}`;
}

function formatTerrainCompare(jsResult: TerrainMeshBenchmarkResult, wasmResult: TerrainMeshBenchmarkResult) {
  const ratio = wasmResult.elapsed > 0 ? jsResult.elapsed / wasmResult.elapsed : 0;
  const minDelta = Math.abs(jsResult.min - wasmResult.min);
  const maxDelta = Math.abs(jsResult.max - wasmResult.max);
  const avgDelta = Math.abs(jsResult.average - wasmResult.average);
  const checksumDelta = Math.abs(jsResult.checksum - wasmResult.checksum);
  const suffix = ratio >= 1
    ? " This is closer to a real engine task: one batched call emits render-ready buffers for a whole terrain chunk."
    : " This is normal for a single stats pass; the work is still too small to offset the JS↔WASM handoff.";

  return `JS ${jsResult.elapsed.toFixed(2)} ms vs WASM ${wasmResult.elapsed.toFixed(2)} ms. ${ratio >= 1 ? `WASM is ${ratio.toFixed(2)}x faster.` : `WASM is ${(1 / Math.max(ratio, 0.0001)).toFixed(2)}x slower.`} Min delta ${minDelta.toFixed(5)}, max delta ${maxDelta.toFixed(5)}, avg delta ${avgDelta.toFixed(5)}, checksum delta ${checksumDelta.toFixed(5)}.${suffix}`;
}

function formatPackingCompare(jsResult: PackingBenchmarkResult, wasmResult: PackingBenchmarkResult) {
  const ratio = wasmResult.elapsed > 0 ? jsResult.elapsed / wasmResult.elapsed : 0;
  const avgDelta = Math.abs(jsResult.average - wasmResult.average);
  const checksumDelta = Math.abs(jsResult.checksum - wasmResult.checksum);
  const suffix = ratio >= 1
    ? " This is the kind of bulk buffer work that can become a strong WASM candidate once it is chained together."
    : " This is normal for a small one-pass quantizer; the call boundary is a large fraction of the total work.";

  return `JS ${jsResult.elapsed.toFixed(2)} ms vs WASM ${wasmResult.elapsed.toFixed(2)} ms. ${ratio >= 1 ? `WASM is ${ratio.toFixed(2)}x faster.` : `WASM is ${(1 / Math.max(ratio, 0.0001)).toFixed(2)}x slower.`} Avg delta ${avgDelta.toFixed(5)}, checksum delta ${checksumDelta.toFixed(2)}.${suffix}`;
}

function benchmarkSwarmInJs(baseState: Float32Array): SwarmBenchmarkResult {
  const state = new Float32Array(baseState.length);
  const output = new Float32Array((baseState.length / SWARM_STATE_STRIDE) * 3);
  state.set(baseState);
  for (let warmup = 0; warmup < 24; warmup += 1) {
    updateSwarmInJs(state, output, 1 / 60, warmup / 60, SWARM_SUBSTEPS);
  }

  const started = performance.now();
  let summary = summarizeSwarmPositions(output);

  for (let repeat = 0; repeat < SWARM_BENCHMARK_REPEATS; repeat += 1) {
    state.set(baseState);
    let time = 0;
    copySwarmPositionsFromState(state, output);

    for (let frame = 0; frame < SWARM_BENCHMARK_FRAMES; frame += 1) {
      time += 1 / 60;
      updateSwarmInJs(state, output, 1 / 60, time, SWARM_SUBSTEPS);
    }

    summary = summarizeSwarmPositions(output);
  }

  return {
    elapsed: (performance.now() - started) / SWARM_BENCHMARK_REPEATS,
    repeats: SWARM_BENCHMARK_REPEATS,
    entities: output.length / 3,
    frames: SWARM_BENCHMARK_FRAMES,
    substeps: SWARM_SUBSTEPS,
    ...summary,
  };
}

async function benchmarkSwarmInWasm(baseState: Float32Array): Promise<SwarmBenchmarkResult> {
  const kernel = await loadGeometryKernel();
  const runner = kernel.createSwarmRunner(baseState);
  runner.reset(baseState);
  runner.simulate(24, 1 / 60, 0, SWARM_SUBSTEPS);

  const started = performance.now();
  let summary = { averageRadius: 0, averageHeight: 0, checksum: 0 };

  for (let repeat = 0; repeat < SWARM_BENCHMARK_REPEATS; repeat += 1) {
    runner.reset(baseState);
    const positions = runner.simulate(SWARM_BENCHMARK_FRAMES, 1 / 60, 0, SWARM_SUBSTEPS);
    summary = summarizeSwarmPositions(positions);
  }

  return {
    elapsed: (performance.now() - started) / SWARM_BENCHMARK_REPEATS,
    repeats: SWARM_BENCHMARK_REPEATS,
    entities: baseState.length / SWARM_STATE_STRIDE,
    frames: SWARM_BENCHMARK_FRAMES,
    substeps: SWARM_SUBSTEPS,
    ...summary,
  };
}

function formatSwarmResult(label: string, result: SwarmBenchmarkResult) {
  const integrationSteps = result.entities * result.frames * result.substeps;
  return `${label}: ${result.elapsed.toFixed(2)} ms avg across ${result.repeats} runs for ${result.entities.toLocaleString()} entities x ${result.frames} frames (${integrationSteps.toLocaleString()} integration steps). Avg radius ${result.averageRadius.toFixed(2)}, avg height ${result.averageHeight.toFixed(2)}, checksum ${result.checksum.toFixed(2)}.`;
}

function formatSwarmCompare(jsResult: SwarmBenchmarkResult, wasmResult: SwarmBenchmarkResult) {
  const ratio = wasmResult.elapsed > 0 ? jsResult.elapsed / wasmResult.elapsed : 0;
  const radiusDelta = Math.abs(jsResult.averageRadius - wasmResult.averageRadius);
  const heightDelta = Math.abs(jsResult.averageHeight - wasmResult.averageHeight);
  const checksumDelta = Math.abs(jsResult.checksum - wasmResult.checksum);
  const suffix = ratio >= 1
    ? " This is the kind of workload where WASM starts to make sense: persistent state, a lot of arithmetic, and very few JS↔WASM crossings."
    : " If this ever loses, it usually means the per-frame workload is still too small or the render-side matrix updates are dominating what you notice.";

  return `JS ${jsResult.elapsed.toFixed(2)} ms vs WASM ${wasmResult.elapsed.toFixed(2)} ms. ${ratio >= 1 ? `WASM is ${ratio.toFixed(2)}x faster.` : `WASM is ${(1 / Math.max(ratio, 0.0001)).toFixed(2)}x slower.`} Radius delta ${radiusDelta.toFixed(4)}, height delta ${heightDelta.toFixed(4)}, checksum delta ${checksumDelta.toFixed(2)}.${suffix}`;
}

function renderGeometryPreview(dataset: GeometryDataset, jsResult: GeometryBenchmarkResult | null, wasmResult: GeometryBenchmarkResult | null) {
  const width = 700;
  const height = 360;
  const padding = 24;
  const baseAnalysis = analyzeGeometryInJs(dataset.points, dataset.loops, dataset.verticesPerLoop);
  const spanX = Math.max(baseAnalysis.maxX - baseAnalysis.minX, 1);
  const spanY = Math.max(baseAnalysis.maxY - baseAnalysis.minY, 1);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const mapX = (x: number) => padding + (x - baseAnalysis.minX) * scale;
  const mapY = (y: number) => height - padding - (y - baseAnalysis.minY) * scale;

  const grid = Array.from({ length: 9 }, (_, index) => {
    const x = padding + ((width - padding * 2) / 8) * index;
    return `<line x1="${x}" y1="${padding}" x2="${x}" y2="${height - padding}" />`;
  }).join("") + Array.from({ length: 5 }, (_, index) => {
    const y = padding + ((height - padding * 2) / 4) * index;
    return `<line x1="${padding}" y1="${y}" x2="${width - padding}" y2="${y}" />`;
  }).join("");

  const polylines = Array.from({ length: dataset.loops }, (_, loopIndex) => {
    const base = loopIndex * dataset.verticesPerLoop * 2;
    const loopPoints: string[] = [];

    for (let vertex = 0; vertex < dataset.verticesPerLoop; vertex += 1) {
      loopPoints.push(`${mapX(dataset.points[base + vertex * 2]).toFixed(2)},${mapY(dataset.points[base + vertex * 2 + 1]).toFixed(2)}`);
    }

    loopPoints.push(loopPoints[0] ?? "");
    return `<polyline points="${loopPoints.join(" ")}" />`;
  }).join("");

  const boundsRect = (result: GeometryBenchmarkResult | null, className: string) => {
    if (!result) {
      return "";
    }

    const x = mapX(result.minX);
    const y = mapY(result.maxY);
    return `<rect class="${className}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${((result.maxX - result.minX) * scale).toFixed(2)}" height="${((result.maxY - result.minY) * scale).toFixed(2)}" />`;
  };

  return `
    <div class="wasm-preview-stack">
      <svg viewBox="0 0 ${width} ${height}" class="wasm-preview-svg" role="img" aria-label="Polygon analysis preview">
        <rect class="wasm-preview-bg" x="0" y="0" width="${width}" height="${height}" rx="20" ry="20" />
        <g class="wasm-preview-grid">${grid}</g>
        <g class="wasm-preview-loops">${polylines}</g>
        ${boundsRect(jsResult, "wasm-preview-js-bounds")}
        ${boundsRect(wasmResult, "wasm-preview-wasm-bounds")}
      </svg>
      <div class="wasm-preview-legend">
        <span><i class="wasm-legend-chip wasm-legend-chip-js"></i> JavaScript bounds</span>
        <span><i class="wasm-legend-chip wasm-legend-chip-wasm"></i> WASM bounds</span>
        <span><i class="wasm-legend-chip wasm-legend-chip-loop"></i> Polygon loops</span>
      </div>
    </div>
  `;
}

function renderPackingPreview(dataset: PackingDataset, jsResult: PackingBenchmarkResult | null, wasmResult: PackingBenchmarkResult | null) {
  const values = dataset.values;
  const width = 700;
  const height = 360;
  const padding = 24;
  const chartWidth = width - padding * 2;
  const originalTop = 28;
  const packedTop = 198;
  const chartHeight = 112;
  const barWidth = chartWidth / values.length;

  const originalBars = Array.from(values, (value, index) => {
    const x = padding + index * barWidth;
    const y = originalTop + chartHeight - value * chartHeight;
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(barWidth - 1, 1).toFixed(2)}" height="${Math.max(value * chartHeight, 1).toFixed(2)}" fill="rgba(171, 210, 255, 0.85)" />`;
  }).join("");

  const packedPolyline = (packed: Uint8Array | null, className: string) => {
    if (!packed) {
      return "";
    }

    const points = Array.from(packed, (value, index) => {
      const x = padding + index * barWidth + barWidth * 0.5;
      const y = packedTop + chartHeight - (value / 255) * chartHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });

    return `<polyline class="${className}" points="${points.join(" ")}" />`;
  };

  return `
    <div class="wasm-preview-stack">
      <svg viewBox="0 0 ${width} ${height}" class="wasm-preview-svg" role="img" aria-label="Packing and quantization preview">
        <rect class="wasm-preview-bg" x="0" y="0" width="${width}" height="${height}" rx="20" ry="20" />
        <text class="wasm-preview-label" x="${padding}" y="18">Original floats</text>
        <text class="wasm-preview-label" x="${padding}" y="188">Packed bytes</text>
        <g>${originalBars}</g>
        <line class="wasm-preview-axis" x1="${padding}" y1="${originalTop + chartHeight}" x2="${width - padding}" y2="${originalTop + chartHeight}" />
        <line class="wasm-preview-axis" x1="${padding}" y1="${packedTop + chartHeight}" x2="${width - padding}" y2="${packedTop + chartHeight}" />
        ${packedPolyline(jsResult?.packed ?? null, "wasm-preview-js-line")}
        ${packedPolyline(wasmResult?.packed ?? null, "wasm-preview-wasm-line")}
      </svg>
      <div class="wasm-preview-legend">
        <span><i class="wasm-legend-chip wasm-legend-chip-loop"></i> Original float bars</span>
        <span><i class="wasm-legend-chip wasm-legend-chip-js"></i> JavaScript packed bytes</span>
        <span><i class="wasm-legend-chip wasm-legend-chip-wasm"></i> WASM packed bytes</span>
      </div>
    </div>
  `;
}

function createCubeTheme(trackId: TrackId) {
  if (trackId === "terrain") {
    return {
      background: 0x07120d,
      fog: 0x07120d,
      floor: 0x0f1f18,
      floorAccent: 0x163329,
      cube: 0x8ddf9b,
      emissive: 0x14301f,
      edge: 0xdfffe3,
      light: 0xb8ffc7,
    };
  }

  if (trackId === "packing") {
    return {
      background: 0x130b07,
      fog: 0x130b07,
      floor: 0x24140b,
      floorAccent: 0x3c2416,
      cube: 0xffb15f,
      emissive: 0x4a2408,
      edge: 0xffe2bf,
      light: 0xffddb6,
    };
  }

  return {
    background: 0x06101a,
    fog: 0x06101a,
    floor: 0x0a1623,
    floorAccent: 0x14293f,
    cube: 0x71d4ff,
    emissive: 0x0b2644,
    edge: 0xe2f7ff,
    light: 0xa8ebff,
  };
}

function mountSwarmPreview(
  target: HTMLElement,
  driverLabel: HTMLElement,
  driverHint: HTMLElement,
  statusNode: HTMLElement,
  metricsNode: HTMLElement,
): SwarmPreviewHandle {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.domElement.className = "wasm-cube-canvas";
  target.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07110c);
  scene.fog = new THREE.Fog(0x07110c, 8, 18);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40);
  camera.position.set(0, 4.7, 8.6);
  camera.lookAt(0, 1.6, 0);

  scene.add(new THREE.HemisphereLight(0xc5ffe1, 0x05100b, 0.76));

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
  keyLight.position.set(4.5, 6.4, 3.2);
  scene.add(keyLight);

  const fillLight = new THREE.PointLight(0x84ffd7, 10, 18, 2);
  fillLight.position.set(-4.2, 2.8, -2.8);
  scene.add(fillLight);

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x0d1d16,
    roughness: 0.92,
    metalness: 0.05,
  });
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 6.4, 0.14, 80), floorMaterial);
  floor.position.y = -0.1;
  scene.add(floor);

  const innerPad = new THREE.Mesh(
    new THREE.CylinderGeometry(2.8, 3.3, 0.08, 72),
    new THREE.MeshStandardMaterial({
      color: 0x102a20,
      roughness: 0.8,
      metalness: 0.08,
    }),
  );
  innerPad.position.y = 0.02;
  scene.add(innerPad);

  const grid = new THREE.GridHelper(12, 24, 0x214d3b, 0x11281f);
  grid.position.y = -0.015;
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.26;
  scene.add(grid);

  const accentRing = new THREE.Mesh(
    new THREE.TorusGeometry(3.4, 0.06, 22, 128),
    new THREE.MeshBasicMaterial({
      color: 0x96ffe0,
      transparent: true,
      opacity: 0.18,
    }),
  );
  accentRing.rotation.x = Math.PI / 2;
  accentRing.position.y = 0.12;
  scene.add(accentRing);

  const count = SWARM_PREVIEW_ENTITIES;
  const geometry = new THREE.BoxGeometry(0.1, 0.08, 0.18);
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x86e8ff,
    roughness: 0.28,
    metalness: 0.34,
    clearcoat: 0.5,
    clearcoatRoughness: 0.16,
    emissive: 0x0b2a22,
    emissiveIntensity: 0.3,
  });
  const swarm = new THREE.InstancedMesh(geometry, material, count);
  swarm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  swarm.frustumCulled = false;
  scene.add(swarm);

  const dataset = getSwarmDataset(count);
  const jsState = new Float32Array(dataset.baseState);
  const jsOutput = new Float32Array(count * 3);
  copySwarmPositionsFromState(jsState, jsOutput);

  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let index = 0; index < count; index += 1) {
    tint.setHSL(0.56 - (index / Math.max(count - 1, 1)) * 0.18, 0.82, 0.62);
    swarm.setColorAt(index, tint);
  }

  let visible = true;
  let benchmarking = false;
  let disposed = false;
  let driver: SwarmDriver = "js";
  let time = 0;
  let lastTime = performance.now();
  let lastWidth = 0;
  let lastHeight = 0;
  let wasmRunner: SwarmRunner | null = null;
  let kernelPromise: Promise<Awaited<ReturnType<typeof loadGeometryKernel>>> | null = null;
  let kernelLoaded = false;

  const updateDriverCopy = () => {
    driverLabel.textContent = driver === "wasm" ? "Driver: WASM update_swarm()" : "Driver: JavaScript swarm step";
    driverHint.textContent = driver === "wasm"
      ? kernelLoaded
        ? "The GPU still renders one instanced batch. WASM now owns the CPU-side flock integration that updates all 5,000 entity positions."
        : "Loading the WASM kernel. Once ready, it will advance the whole swarm while Three.js keeps rendering the same instanced batch."
      : "JavaScript is updating the same swarm rules on the CPU, then Three.js uploads the transforms and the GPU draws them as one instanced batch.";
    statusNode.textContent = driver === "wasm"
      ? kernelLoaded
        ? "WASM memory owns persistent swarm state between frames."
        : "Preparing persistent swarm state inside WASM memory..."
      : "JavaScript arrays own the swarm state; each frame updates the same typed buffers.";
  };

  const ensureWasmRunner = async () => {
    if (wasmRunner) {
      return wasmRunner;
    }

    kernelPromise ??= loadGeometryKernel();
    const kernel = await kernelPromise;
    wasmRunner = kernel.createSwarmRunner(dataset.baseState);
    kernelLoaded = true;
    updateDriverCopy();
    return wasmRunner;
  };

  const resetSimulation = () => {
    jsState.set(dataset.baseState);
    copySwarmPositionsFromState(jsState, jsOutput);
    wasmRunner?.reset(dataset.baseState);
    time = 0;
  };

  const resizeRenderer = () => {
    const width = Math.max(target.clientWidth, 10);
    const height = Math.max(target.clientHeight, 10);

    if (width === lastWidth && height === lastHeight) {
      return;
    }

    lastWidth = width;
    lastHeight = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const applyPositions = (positions: ArrayLike<number>, phaseTime: number) => {
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const x = positions[offset];
      const y = positions[offset + 1];
      const z = positions[offset + 2];
      dummy.position.set(x, y, z);
      dummy.rotation.set(
        Math.sin(phaseTime * 1.4 + index * 0.013) * 0.18,
        Math.atan2(z, x) + phaseTime * 0.45,
        Math.cos(phaseTime * 1.2 + index * 0.009) * 0.12,
      );
      dummy.updateMatrix();
      swarm.setMatrixAt(index, dummy.matrix);
    }

    swarm.instanceMatrix.needsUpdate = true;
    accentRing.rotation.z = phaseTime * 0.22;
  };

  const animate = (now: number) => {
    if (disposed) {
      return;
    }

    requestAnimationFrame(animate);

    const delta = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    if (!visible) {
      return;
    }

    resizeRenderer();
    if (benchmarking) {
      return;
    }
    time += delta;
    let positions: ArrayLike<number> = jsOutput;

    if (driver === "wasm") {
      if (wasmRunner) {
        positions = wasmRunner.step(delta, time, SWARM_SUBSTEPS);
      }
    } else {
      updateSwarmInJs(jsState, jsOutput, delta, time, SWARM_SUBSTEPS);
    }

    applyPositions(positions, time);
    renderer.render(scene, camera);
  };

  metricsNode.textContent = `${count.toLocaleString()} instanced entities, one shared geometry/material, CPU updates via JS or WASM.`;
  resetSimulation();
  updateDriverCopy();
  applyPositions(jsOutput, 0);
  resizeRenderer();
  requestAnimationFrame(animate);

  return {
    setVisible(nextVisible) {
      visible = nextVisible;
      lastTime = performance.now();
    },
    setDriver(nextDriver) {
      driver = nextDriver;
      resetSimulation();
      updateDriverCopy();

      if (driver === "wasm") {
        void ensureWasmRunner().then(() => {
          resetSimulation();
          updateDriverCopy();
        });
      }
    },
    setBenchmarking(nextBenchmarking) {
      benchmarking = nextBenchmarking;
      lastTime = performance.now();
    },
    dispose() {
      disposed = true;
      geometry.dispose();
      material.dispose();
      floor.geometry.dispose();
      floorMaterial.dispose();
      innerPad.geometry.dispose();
      (innerPad.material as THREE.Material).dispose();
      grid.geometry.dispose();
      gridMaterial.dispose();
      (accentRing.geometry as THREE.BufferGeometry).dispose();
      (accentRing.material as THREE.Material).dispose();
      renderer.dispose();
      target.replaceChildren();
    },
  };
}

function mountPhysicsPreview(
  target: HTMLElement,
  statusNode: HTMLElement,
  jsStepNode: HTMLElement,
  wasmStepNode: HTMLElement,
  noteNode: HTMLElement,
): PhysicsPreviewHandle {
  target.innerHTML = `
    <div class="wasm-physics-shell">
      <div class="wasm-physics-overlay">
        <span class="wasm-preview-badge wasm-preview-badge-js">Naive JS integrator</span>
        <span class="wasm-preview-badge wasm-preview-badge-wasm">Rapier rigid-body world</span>
      </div>
    </div>
  `;

  const shell = target.querySelector<HTMLElement>(".wasm-physics-shell");
  if (!shell) {
    throw new Error("Missing physics preview shell.");
  }

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = "wasm-physics-canvas";
  shell.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06100c);
  scene.fog = new THREE.Fog(0x06100c, 10, 28);

  const stageCenterOffset = 2.9;
  const platformHalfExtent = 2.2;
  const platformWorldSize = platformHalfExtent * 2;

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 60);
  camera.position.set(0, 5.8, 11.4);
  camera.lookAt(0, 1.95, 0);

  scene.add(new THREE.HemisphereLight(0xd6ffe8, 0x07100c, 0.85));

  const keyLight = new THREE.DirectionalLight(0xfff8ef, 2.4);
  keyLight.position.set(6.8, 10.5, 5.2);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 36;
  keyLight.shadow.camera.left = -14;
  keyLight.shadow.camera.right = 14;
  keyLight.shadow.camera.top = 14;
  keyLight.shadow.camera.bottom = -14;
  keyLight.shadow.bias = -0.0002;
  scene.add(keyLight);

  const fillLight = new THREE.PointLight(0x84ffd7, 18, 24, 2);
  fillLight.position.set(-7.5, 3.8, -3.2);
  scene.add(fillLight);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(14, 96),
    new THREE.MeshStandardMaterial({
      color: 0x0d1914,
      roughness: 0.95,
      metalness: 0.02,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.12;
  floor.receiveShadow = true;
  scene.add(floor);

  const floorRing = new THREE.Mesh(
    new THREE.TorusGeometry(4.9, 0.08, 18, 96),
    new THREE.MeshBasicMaterial({
      color: 0x9ef6d9,
      transparent: true,
      opacity: 0.22,
    }),
  );
  floorRing.rotation.x = Math.PI / 2;
  floorRing.position.y = 0.05;
  scene.add(floorRing);

  const divider = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 2.2, 6.4),
    new THREE.MeshBasicMaterial({
      color: 0x6fb7ff,
      transparent: true,
      opacity: 0.14,
    }),
  );
  divider.position.set(0, 1.15, 0);
  scene.add(divider);

  const sideLabelMaterial = new THREE.MeshBasicMaterial({ color: 0x99dbc1, transparent: true, opacity: 0.4 });
  const leftLabel = new THREE.Mesh(new THREE.RingGeometry(2.4, 2.52, 96), sideLabelMaterial);
  leftLabel.rotation.x = -Math.PI / 2;
  leftLabel.position.set(-stageCenterOffset, 0.06, 0);
  scene.add(leftLabel);

  const rightLabel = new THREE.Mesh(new THREE.RingGeometry(2.4, 2.52, 96), sideLabelMaterial.clone());
  rightLabel.rotation.x = -Math.PI / 2;
  rightLabel.position.set(stageCenterOffset, 0.06, 0);
  scene.add(rightLabel);

  const platformMaterial = new THREE.MeshStandardMaterial({
    color: 0x10261c,
    roughness: 0.82,
    metalness: 0.08,
  });
  const platformGeometry = new THREE.BoxGeometry(platformWorldSize, 0.28, platformWorldSize);
  const leftPlatform = new THREE.Mesh(platformGeometry, platformMaterial);
  leftPlatform.position.set(-stageCenterOffset, 0, 0);
  leftPlatform.receiveShadow = true;
  leftPlatform.castShadow = true;
  scene.add(leftPlatform);

  const rightPlatform = new THREE.Mesh(platformGeometry, platformMaterial.clone());
  rightPlatform.position.set(stageCenterOffset, 0, 0);
  rightPlatform.receiveShadow = true;
  rightPlatform.castShadow = true;
  scene.add(rightPlatform);

  const boxGeometry = new THREE.BoxGeometry(0.44, 0.44, 0.44);
  const jsMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffae62,
    roughness: 0.5,
    metalness: 0.12,
    clearcoat: 0.38,
    clearcoatRoughness: 0.22,
  });
  const wasmMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x76d7ff,
    roughness: 0.28,
    metalness: 0.18,
    clearcoat: 0.46,
    clearcoatRoughness: 0.16,
  });
  const jsBodiesMesh = new THREE.InstancedMesh(boxGeometry, jsMaterial, 72);
  jsBodiesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  jsBodiesMesh.castShadow = true;
  jsBodiesMesh.receiveShadow = true;
  jsBodiesMesh.frustumCulled = false;
  scene.add(jsBodiesMesh);

  const wasmBodiesMesh = new THREE.InstancedMesh(boxGeometry, wasmMaterial, 72);
  wasmBodiesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wasmBodiesMesh.castShadow = true;
  wasmBodiesMesh.receiveShadow = true;
  wasmBodiesMesh.frustumCulled = false;
  scene.add(wasmBodiesMesh);

  const boxHalf = 0.22;
  const padHalf = 2.0;
  const padTopY = 0.14;
  const bodyCount = 72;
  const gridX = 4;
  const gridZ = 3;
  const layers = 6;
  const spacing = 0.56;
  const leftCenter = -stageCenterOffset;
  const rightCenter = stageCenterOffset;
  const jsStepHistory: number[] = [];
  const wasmStepHistory: number[] = [];
  const jsBodies = new Array<{
    px: number;
    py: number;
    pz: number;
    vx: number;
    vy: number;
    vz: number;
    rx: number;
    ry: number;
    rz: number;
    wx: number;
    wy: number;
    wz: number;
  }>(bodyCount);
  const dummy = new THREE.Object3D();

  let visible = true;
  let disposed = false;
  let rapierReady = false;
  let lastWidth = 0;
  let lastHeight = 0;
  let lastTime = performance.now();
  let simTime = 0;
  let rapierWorld: import("@dimforge/rapier3d-compat").World | null = null;
  let rapierBodies: import("@dimforge/rapier3d-compat").RigidBody[] = [];
  let rapierModulePromise: Promise<Awaited<ReturnType<typeof loadRapier>>> | null = null;

  const averageHistory = (history: number[]) =>
    history.length ? history.reduce((sum, value) => sum + value, 0) / history.length : 0;

  const pushHistory = (history: number[], value: number) => {
    history.push(value);
    if (history.length > 60) {
      history.shift();
    }
  };

  const updateMetrics = () => {
    const jsAverage = averageHistory(jsStepHistory);
    const wasmAverage = averageHistory(wasmStepHistory);
    jsStepNode.textContent = jsAverage > 0 ? `${jsAverage.toFixed(3)} ms` : "--";
    wasmStepNode.textContent = rapierReady && wasmAverage > 0 ? `${wasmAverage.toFixed(3)} ms` : rapierReady ? "--" : "loading";
    noteNode.textContent = rapierReady
      ? "This is the honest WASM story: the JS side is a tiny gravity integrator, while Rapier is doing broadphase, narrowphase, contact manifolds, and solver iterations inside a compiled Rust engine."
      : "Loading Rapier… once ready, the right side will be a full rigid-body world compiled from Rust into WebAssembly.";
  };

  const getSpawnPose = (index: number, centerX: number) => {
    const cellsPerLayer = gridX * gridZ;
    const layer = Math.floor(index / cellsPerLayer);
    const cell = index % cellsPerLayer;
    const column = cell % gridX;
    const row = Math.floor(cell / gridX);
    const x = centerX + (column - (gridX - 1) / 2) * spacing + (row % 2 === 0 ? 0.04 : -0.04);
    const y = padTopY + boxHalf + layer * (boxHalf * 2 + 0.03);
    const z = (row - (gridZ - 1) / 2) * spacing;
    return { x, y, z };
  };

  const syncJsMesh = () => {
    for (let index = 0; index < bodyCount; index += 1) {
      const body = jsBodies[index];
      dummy.position.set(body.px, body.py, body.pz);
      dummy.rotation.set(body.rx, body.ry, body.rz);
      dummy.updateMatrix();
      jsBodiesMesh.setMatrixAt(index, dummy.matrix);
    }
    jsBodiesMesh.instanceMatrix.needsUpdate = true;
  };

  const syncRapierMesh = () => {
    for (let index = 0; index < rapierBodies.length; index += 1) {
      const body = rapierBodies[index];
      const translation = body.translation();
      const rotation = body.rotation();
      dummy.position.set(translation.x, translation.y, translation.z);
      dummy.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      dummy.updateMatrix();
      wasmBodiesMesh.setMatrixAt(index, dummy.matrix);
    }
    wasmBodiesMesh.instanceMatrix.needsUpdate = true;
  };

  const resetJsSide = () => {
    jsStepHistory.length = 0;
    for (let index = 0; index < bodyCount; index += 1) {
      const spawn = getSpawnPose(index, leftCenter);
      jsBodies[index] = {
        px: spawn.x,
        py: spawn.y,
        pz: spawn.z,
        vx: Math.sin(index * 0.73) * 0.12,
        vy: 0,
        vz: Math.cos(index * 0.51) * 0.12,
        rx: index * 0.03,
        ry: index * 0.05,
        rz: index * 0.02,
        wx: 0.6 + (index % 5) * 0.08,
        wy: 0.8 + (index % 7) * 0.05,
        wz: 0.45 + (index % 3) * 0.09,
      };
    }
    syncJsMesh();
  };

  const createRapierWorld = async () => {
    rapierModulePromise ??= loadRapier();
    const RAPIER = await rapierModulePromise;

    if (disposed) {
      return;
    }

    rapierWorld?.free();
    rapierBodies = [];
    wasmStepHistory.length = 0;

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = 1 / 60;
    world.numSolverIterations = 8;
    world.numAdditionalFrictionIterations = 4;
    rapierWorld = world;

    const createPlatform = (centerX: number) => {
      const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(centerX, 0, 0));
      world.createCollider(RAPIER.ColliderDesc.cuboid(2.2, 0.14, 2.2).setFriction(0.88), ground);

      const wallThickness = 0.12;
      const wallHeight = 0.45;
      const wallOffset = 2.12;

      const wallDescriptors = [
        RAPIER.RigidBodyDesc.fixed().setTranslation(centerX - wallOffset, padTopY + wallHeight / 2, 0),
        RAPIER.RigidBodyDesc.fixed().setTranslation(centerX + wallOffset, padTopY + wallHeight / 2, 0),
        RAPIER.RigidBodyDesc.fixed().setTranslation(centerX, padTopY + wallHeight / 2, -wallOffset),
        RAPIER.RigidBodyDesc.fixed().setTranslation(centerX, padTopY + wallHeight / 2, wallOffset),
      ];

      wallDescriptors.forEach((desc, index) => {
        const rigidBody = world.createRigidBody(desc);
        const collider =
          index < 2
            ? RAPIER.ColliderDesc.cuboid(wallThickness, wallHeight, 2.2)
            : RAPIER.ColliderDesc.cuboid(2.2, wallHeight, wallThickness);
        world.createCollider(collider.setFriction(0.88), rigidBody);
      });
    };

    createPlatform(rightCenter);

    for (let index = 0; index < bodyCount; index += 1) {
      const spawn = getSpawnPose(index, rightCenter);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(spawn.x, spawn.y, spawn.z)
          .setLinvel(Math.sin(index * 0.37) * 0.06, 0, Math.cos(index * 0.41) * 0.06),
      );
      body.setAdditionalSolverIterations(1);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(boxHalf, boxHalf, boxHalf)
          .setFriction(0.82)
          .setRestitution(0.04),
        body,
      );
      rapierBodies.push(body);
    }

    rapierReady = true;
    statusNode.textContent = "Rapier loaded: compiled Rust rigid-body solver, collision detection, and stacking are all running in WebAssembly.";
    syncRapierMesh();
    updateMetrics();
  };

  const restack = () => {
    simTime = 0;
    resetJsSide();
    statusNode.textContent = rapierReady
      ? "Both sides reset. Left is a tiny JS gravity integrator; right is the Rapier rigid-body world."
      : "Resetting the JS side and loading Rapier…";
    void createRapierWorld();
  };

  const burst = () => {
    for (let index = 0; index < bodyCount; index += 1) {
      const body = jsBodies[index];
      body.vx += Math.sin(simTime * 2 + index * 0.33) * 0.6;
      body.vy += 1.6 + (index % 5) * 0.06;
      body.vz += Math.cos(simTime * 1.6 + index * 0.21) * 0.6;
      body.wx += 0.3;
      body.wy += 0.35;
      body.wz += 0.22;
    }

    if (rapierReady) {
      rapierBodies.forEach((body, index) => {
        body.applyImpulse(
          {
            x: Math.sin(simTime * 2 + index * 0.27) * 0.35,
            y: 0.8 + (index % 4) * 0.08,
            z: Math.cos(simTime * 1.8 + index * 0.31) * 0.35,
          },
          true,
        );
      });
      statusNode.textContent = "Impulse burst applied. Rapier is now resolving all the resulting collisions and contact stacks on the right.";
    } else {
      statusNode.textContent = "Impulse burst applied on the JS side while Rapier continues loading.";
    }
  };

  const resizeRenderer = () => {
    const width = Math.max(shell.clientWidth, 10);
    const height = Math.max(shell.clientHeight, 10);

    if (width === lastWidth && height === lastHeight) {
      return;
    }

    lastWidth = width;
    lastHeight = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const updateJsSide = (delta: number) => {
    const start = performance.now();
    const minX = leftCenter - padHalf + boxHalf;
    const maxX = leftCenter + padHalf - boxHalf;
    const minZ = -padHalf + boxHalf;
    const maxZ = padHalf - boxHalf;
    const minY = padTopY + boxHalf;

    for (let index = 0; index < bodyCount; index += 1) {
      const body = jsBodies[index];
      body.vy += -9.81 * delta;
      body.px += body.vx * delta;
      body.py += body.vy * delta;
      body.pz += body.vz * delta;
      body.rx += body.wx * delta;
      body.ry += body.wy * delta;
      body.rz += body.wz * delta;

      if (body.py < minY) {
        body.py = minY;
        body.vy *= -0.16;
        body.vx *= 0.92;
        body.vz *= 0.92;
        if (Math.abs(body.vy) < 0.08) {
          body.vy = 0;
        }
      }

      if (body.px < minX || body.px > maxX) {
        body.px = THREE.MathUtils.clamp(body.px, minX, maxX);
        body.vx *= -0.35;
      }

      if (body.pz < minZ || body.pz > maxZ) {
        body.pz = THREE.MathUtils.clamp(body.pz, minZ, maxZ);
        body.vz *= -0.35;
      }

      body.vx += Math.sin(simTime * 0.7 + index * 0.19) * 0.004;
      body.vz += Math.cos(simTime * 0.9 + index * 0.13) * 0.004;
    }

    pushHistory(jsStepHistory, performance.now() - start);
    syncJsMesh();
  };

  const updateRapierSide = () => {
    if (!rapierWorld || !rapierReady) {
      return;
    }

    const start = performance.now();
    rapierWorld.step();
    pushHistory(wasmStepHistory, performance.now() - start);
    syncRapierMesh();
  };

  const animate = (now: number) => {
    if (disposed) {
      return;
    }

    requestAnimationFrame(animate);

    const delta = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    if (!visible) {
      return;
    }

    simTime += delta;
    resizeRenderer();
    updateJsSide(delta);
    updateRapierSide();
    updateMetrics();

    const sway = Math.sin(simTime * 0.18) * 0.5;
    camera.position.x = sway;
    camera.lookAt(0, 2.2, 0);
    floorRing.rotation.z = simTime * 0.08;
    renderer.render(scene, camera);
  };

  resetJsSide();
  updateMetrics();
  statusNode.textContent = "Loading Rapier rigid-body world…";
  resizeRenderer();
  requestAnimationFrame(animate);
  void createRapierWorld();

  return {
    setVisible(nextVisible: boolean) {
      visible = nextVisible;
      lastTime = performance.now();
    },
    restack,
    burst,
    dispose() {
      disposed = true;
      rapierWorld?.free();
      jsMaterial.dispose();
      wasmMaterial.dispose();
      boxGeometry.dispose();
      (leftLabel.material as THREE.Material).dispose();
      (rightLabel.material as THREE.Material).dispose();
      leftLabel.geometry.dispose();
      rightLabel.geometry.dispose();
      platformGeometry.dispose();
      platformMaterial.dispose();
      (rightPlatform.material as THREE.Material).dispose();
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      floorRing.geometry.dispose();
      (floorRing.material as THREE.Material).dispose();
      divider.geometry.dispose();
      (divider.material as THREE.Material).dispose();
      renderer.dispose();
      target.replaceChildren();
    },
  };
}

function mountCubePreview(
  target: HTMLElement,
  driverLabel: HTMLElement,
  driverHint: HTMLElement,
): CubePreviewHandle {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = "wasm-cube-canvas";
  target.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 40);
  camera.position.set(2.9, 2.1, 3.2);
  camera.lookAt(0, 0.75, 0);

  const hemiLight = new THREE.HemisphereLight(0xbfdcff, 0x06101a, 0.65);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  keyLight.position.set(3.2, 4.8, 2.6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 16;
  keyLight.shadow.camera.left = -4.5;
  keyLight.shadow.camera.right = 4.5;
  keyLight.shadow.camera.top = 4.5;
  keyLight.shadow.camera.bottom = -4.5;
  keyLight.shadow.bias = -0.0003;
  scene.add(keyLight);

  const rimLight = new THREE.PointLight(0x7abfff, 12, 18, 2);
  rimLight.position.set(-3.2, 2.4, -2.6);
  scene.add(rimLight);

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x0a1623,
    roughness: 0.92,
    metalness: 0.05,
  });
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 4.5, 0.14, 72), floorMaterial);
  floor.receiveShadow = true;
  floor.position.y = -0.08;
  scene.add(floor);

  const pedestalMaterial = new THREE.MeshStandardMaterial({
    color: 0x14293f,
    roughness: 0.8,
    metalness: 0.1,
  });
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.45, 0.16, 48), pedestalMaterial);
  pedestal.position.y = 0.08;
  pedestal.receiveShadow = true;
  pedestal.castShadow = true;
  scene.add(pedestal);

  const cubeMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x71d4ff,
    roughness: 0.24,
    metalness: 0.14,
    clearcoat: 0.55,
    clearcoatRoughness: 0.18,
    emissive: 0x0b2644,
    emissiveIntensity: 0.35,
  });
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.28, 1.28, 1.28), cubeMaterial);
  cube.position.y = 1.02;
  cube.castShadow = true;
  cube.receiveShadow = true;
  scene.add(cube);

  const cubeEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(cube.geometry),
    new THREE.LineBasicMaterial({
      color: 0xe2f7ff,
      transparent: true,
      opacity: 0.22,
    }),
  );
  cubeEdges.position.copy(cube.position);
  scene.add(cubeEdges);

  const grid = new THREE.GridHelper(9, 18, 0x173450, 0x0d2032);
  grid.position.y = -0.005;
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.35;
  scene.add(grid);

  const accentRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.6, 0.04, 18, 96),
    new THREE.MeshBasicMaterial({
      color: 0x71d4ff,
      transparent: true,
      opacity: 0.26,
    }),
  );
  accentRing.rotation.x = Math.PI / 2;
  accentRing.position.y = 0.22;
  scene.add(accentRing);

  let visible = true;
  let disposed = false;
  let driver: CubeDriver = "js";
  let angle = 0;
  let lastTime = performance.now();
  let lastWidth = 0;
  let lastHeight = 0;
  let currentTrackId: TrackId = "geometry";
  let kernelPromise: Promise<Awaited<ReturnType<typeof loadGeometryKernel>>> | null = null;
  let kernelLoaded = false;

  const updateDriverCopy = () => {
    driverLabel.textContent = driver === "wasm" ? "Driver: WASM step_rotation()" : "Driver: JavaScript step";
    driverHint.textContent = driver === "wasm"
      ? kernelLoaded
        ? "Three.js is rendering the cube, and WebAssembly is advancing its rotation phase each frame."
        : "Loading the WASM kernel now. Once ready, it will advance the rotation phase each frame."
      : "This uses a normal JavaScript phase accumulator so you can compare it against the WASM-driven version.";
  };

  const applyTheme = () => {
    const theme = createCubeTheme(currentTrackId);
    scene.background = new THREE.Color(theme.background);
    scene.fog = new THREE.Fog(theme.fog, 7.5, 18);
    floorMaterial.color.setHex(theme.floor);
    pedestalMaterial.color.setHex(theme.floorAccent);
    cubeMaterial.color.setHex(theme.cube);
    cubeMaterial.emissive.setHex(theme.emissive);
    (cubeEdges.material as THREE.LineBasicMaterial).color.setHex(theme.edge);
    (accentRing.material as THREE.MeshBasicMaterial).color.setHex(theme.cube);
    rimLight.color.setHex(theme.light);
  };

  const ensureKernel = async () => {
    kernelPromise ??= loadGeometryKernel();
    const kernel = await kernelPromise;
    kernelLoaded = true;
    updateDriverCopy();
    return kernel;
  };

  const resizeRenderer = () => {
    const width = Math.max(target.clientWidth, 10);
    const height = Math.max(target.clientHeight, 10);

    if (width === lastWidth && height === lastHeight) {
      return;
    }

    lastWidth = width;
    lastHeight = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const animate = async (now: number) => {
    if (disposed) {
      return;
    }

    requestAnimationFrame(animate);

    const delta = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    if (!visible) {
      return;
    }

    resizeRenderer();

    if (driver === "wasm") {
      try {
        const kernel = await ensureKernel();
        angle = kernel.stepRotation(angle, delta, 1.6);
      } catch {
        driver = "js";
        updateDriverCopy();
        angle = (angle + delta * 1.6) % (Math.PI * 2);
      }
    } else {
      angle = (angle + delta * 1.6) % (Math.PI * 2);
    }

    cube.rotation.x = angle * 0.62;
    cube.rotation.y = angle * 1.08;
    cube.rotation.z = Math.sin(angle * 0.8) * 0.18;
    cubeEdges.rotation.copy(cube.rotation);
    accentRing.rotation.z = angle * 0.35;
    keyLight.position.x = 3.2 + Math.sin(angle * 0.35) * 0.6;
    keyLight.position.z = 2.6 + Math.cos(angle * 0.35) * 0.5;

    renderer.render(scene, camera);
  };

  applyTheme();
  updateDriverCopy();
  resizeRenderer();
  requestAnimationFrame(animate);

  return {
    setVisible(nextVisible: boolean) {
      visible = nextVisible;
      lastTime = performance.now();
    },
    setTrack(trackId: TrackId) {
      currentTrackId = trackId;
      applyTheme();
    },
    setDriver(nextDriver: CubeDriver) {
      driver = nextDriver;
      updateDriverCopy();

      if (driver === "wasm") {
        void ensureKernel();
      }
    },
    dispose() {
      disposed = true;
      renderer.dispose();
      cube.geometry.dispose();
      cubeMaterial.dispose();
      (cubeEdges.geometry as THREE.BufferGeometry).dispose();
      (cubeEdges.material as THREE.Material).dispose();
      (accentRing.geometry as THREE.BufferGeometry).dispose();
      (accentRing.material as THREE.Material).dispose();
      floor.geometry.dispose();
      floorMaterial.dispose();
      pedestal.geometry.dispose();
      pedestalMaterial.dispose();
      target.replaceChildren();
    },
  };
}

function mountTerrainPreview(
  target: HTMLElement,
  onSelectDriver: (driver: TerrainPreviewDriver) => void,
): TerrainPreviewHandle {
  target.innerHTML = `
    <div class="wasm-terrain-shell">
      <div class="wasm-terrain-head">
        <strong>Real example: terrain chunk meshing</strong>
        <span class="wasm-preview-badge" data-wasm-terrain-source>Preview source: waiting for mesh output</span>
      </div>
      <p class="wasm-panel-copy">This mesh is created from flat height samples and then passed into <code>THREE.BufferGeometry</code>. That is the kind of batched numeric work WASM is built for.</p>
      <div class="wasm-cube-actions wasm-terrain-actions">
        <button class="wasm-run-button" type="button" data-wasm-terrain-js>Preview JS mesh</button>
        <button class="wasm-run-button wasm-run-button-secondary" type="button" data-wasm-terrain-wasm>Preview WASM mesh</button>
      </div>
      <div class="wasm-terrain-frame" data-wasm-terrain-frame></div>
      <div class="wasm-preview-meta">
        <span class="wasm-preview-badge" data-wasm-terrain-counts>Mesh stats: waiting...</span>
        <span class="wasm-preview-badge" data-wasm-terrain-range>Height range: waiting...</span>
        <span class="wasm-preview-badge" data-wasm-terrain-boundary>Boundary: flat array in -> flat buffers out</span>
      </div>
    </div>
  `;

  const frame = target.querySelector<HTMLElement>("[data-wasm-terrain-frame]");
  const sourceNode = target.querySelector<HTMLElement>("[data-wasm-terrain-source]");
  const countsNode = target.querySelector<HTMLElement>("[data-wasm-terrain-counts]");
  const rangeNode = target.querySelector<HTMLElement>("[data-wasm-terrain-range]");
  const jsButton = target.querySelector<HTMLButtonElement>("[data-wasm-terrain-js]");
  const wasmButton = target.querySelector<HTMLButtonElement>("[data-wasm-terrain-wasm]");

  if (!frame || !sourceNode || !countsNode || !rangeNode || !jsButton || !wasmButton) {
    throw new Error("Could not mount terrain preview");
  }

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = "wasm-terrain-canvas";
  frame.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x08111b);
  scene.fog = new THREE.Fog(0x08111b, 8, 16);

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 40);
  camera.position.set(5.2, 4.4, 6.2);
  camera.lookAt(0, 0.7, 0);

  scene.add(new THREE.HemisphereLight(0xbfe8ff, 0x06101a, 0.75));

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
  keyLight.position.set(4.8, 6.2, 2.8);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 18;
  keyLight.shadow.camera.left = -6;
  keyLight.shadow.camera.right = 6;
  keyLight.shadow.camera.top = 6;
  keyLight.shadow.camera.bottom = -6;
  keyLight.shadow.bias = -0.0002;
  scene.add(keyLight);

  const fillLight = new THREE.PointLight(0x78c9ff, 12, 18, 2);
  fillLight.position.set(-3.4, 2.6, -2.8);
  scene.add(fillLight);

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x0a1623,
    roughness: 0.92,
    metalness: 0.06,
  });
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 5.2, 0.12, 72), floorMaterial);
  floor.position.y = -1.22;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(10, 20, 0x21456e, 0x11253c);
  grid.position.y = -1.16;
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.28;
  scene.add(grid);

  const group = new THREE.Group();
  scene.add(group);

  const meshMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.38,
    metalness: 0.08,
    flatShading: true,
  });

  let disposed = false;
  let lastTime = performance.now();
  let lastWidth = 0;
  let lastHeight = 0;
  let activeDriver: TerrainPreviewDriver = "js";
  let mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  let wireframe: THREE.LineSegments<THREE.WireframeGeometry, THREE.LineBasicMaterial> | null = null;

  const renderDriverButtons = () => {
    jsButton.classList.toggle("is-active", activeDriver === "js");
    wasmButton.classList.toggle("is-active", activeDriver === "wasm");
  };

  renderDriverButtons();

  const handlePreviewJs = () => onSelectDriver("js");
  const handlePreviewWasm = () => onSelectDriver("wasm");
  jsButton.addEventListener("click", handlePreviewJs);
  wasmButton.addEventListener("click", handlePreviewWasm);

  const syncSize = () => {
    const width = Math.max(frame.clientWidth, 10);
    const height = Math.max(frame.clientHeight, 10);

    if (width === lastWidth && height === lastHeight) {
      return;
    }

    lastWidth = width;
    lastHeight = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const disposeGeometry = () => {
    if (mesh) {
      mesh.geometry.dispose();
      group.remove(mesh);
      mesh = null;
    }

    if (wireframe) {
      wireframe.geometry.dispose();
      wireframe.material.dispose();
      group.remove(wireframe);
      wireframe = null;
    }
  };

  const animate = (now: number) => {
    if (disposed) {
      return;
    }

    requestAnimationFrame(animate);
    syncSize();

    const delta = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    group.rotation.y += delta * 0.22;
    renderer.render(scene, camera);
  };

  requestAnimationFrame(animate);

  return {
    setMesh(meshData, driver) {
      disposeGeometry();
      activeDriver = driver;
      renderDriverButtons();

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(meshData.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
      geometry.computeVertexNormals();

      const colors = new Float32Array(meshData.vertexCount * 3);
      const minY = meshData.min * 2.6;
      const maxY = meshData.max * 2.6;
      const spanY = Math.max(maxY - minY, 0.0001);
      const color = new THREE.Color();

      for (let index = 0; index < meshData.vertexCount; index += 1) {
        const y = meshData.positions[index * 3 + 1];
        const t = (y - minY) / spanY;
        color.setHSL(0.58 - t * 0.22, 0.72, 0.34 + t * 0.24);
        colors[index * 3] = color.r;
        colors[index * 3 + 1] = color.g;
        colors[index * 3 + 2] = color.b;
      }

      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

      mesh = new THREE.Mesh(geometry, meshMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.y = -0.12;
      group.add(mesh);

      wireframe = new THREE.LineSegments(
        new THREE.WireframeGeometry(geometry),
        new THREE.LineBasicMaterial({
          color: driver === "wasm" ? 0xffd1a5 : 0x98ddff,
          transparent: true,
          opacity: 0.22,
        }),
      );
      wireframe.position.copy(mesh.position);
      group.add(wireframe);

      sourceNode.textContent = driver === "wasm"
        ? "Preview source: WASM output buffers"
        : "Preview source: JavaScript output buffers";
      sourceNode.classList.toggle("wasm-preview-badge-wasm", driver === "wasm");
      countsNode.textContent = `Mesh stats: ${meshData.vertexCount.toLocaleString()} vertices / ${meshData.triangleCount.toLocaleString()} triangles`;
      rangeNode.textContent = `Height range: ${meshData.min.toFixed(3)} to ${meshData.max.toFixed(3)} (checksum ${meshData.checksum.toFixed(3)})`;
    },
    setDriver(driver) {
      activeDriver = driver;
      renderDriverButtons();
    },
    dispose() {
      disposed = true;
      jsButton.removeEventListener("click", handlePreviewJs);
      wasmButton.removeEventListener("click", handlePreviewWasm);
      disposeGeometry();
      meshMaterial.dispose();
      floor.geometry.dispose();
      floorMaterial.dispose();
      grid.geometry.dispose();
      gridMaterial.dispose();
      renderer.dispose();
      target.replaceChildren();
    },
  };
}

export async function mountWasmLab(target: HTMLElement, options: WasmLabOptions): Promise<WasmLabHandle> {
  target.innerHTML = `
    <div class="wasm-shell">
      <div class="wasm-header">
        <div>
          <div class="wasm-kicker">Isolated systems playground</div>
          <h2>WASM Lab</h2>
          <p>Keep the planner stable and spin up lower-level experiments here first. This tab is the place to prototype real WebAssembly kernels, benchmark them, and only then bring the winners back into the rest of the app.</p>
        </div>
        <div class="wasm-chip-stack">
          <div class="wasm-backend-chip">Renderer: ${options.hasNativeWebGPU ? "WebGPU ready" : "WebGL fallback active"}</div>
          <div class="wasm-backend-chip">${options.prefersTouchInput ? "Touch-first device" : "Mouse + keyboard"}</div>
        </div>
      </div>

      <div class="wasm-metrics">
        <article class="wasm-metric-card">
          <span>Most convincing live demo</span>
          <strong>Terrain mesh builder</strong>
          <p>One batched WASM call turns height samples into real vertex and index buffers that Three.js can render immediately.</p>
        </article>
        <article class="wasm-metric-card">
          <span>Current live module</span>
          <strong data-wasm-live-title>Heightfield mesh kernel</strong>
          <p data-wasm-live-summary>The live module builds a terrain chunk from raw height samples and emits render-ready mesh buffers.</p>
        </article>
        <article class="wasm-metric-card">
          <span>Best project insertion</span>
          <strong>Geometry kernel</strong>
          <p>Closed loops, triangulation, and wall bands are still the cleanest place to bring a serious WASM subsystem back into this app.</p>
        </article>
      </div>

      <section class="wasm-panel wasm-panel-live">
        <div class="wasm-panel-head">
          <span class="wasm-panel-kicker">Real module test</span>
          <h3>Terrain-first benchmark with visual proof</h3>
        </div>
        <p class="wasm-panel-copy" data-wasm-live-copy>The preview below uses a heightfield. JavaScript and WebAssembly both build the same terrain chunk so you can compare a more engine-shaped workload and inspect the actual output buffers in a live Three.js view.</p>
        <div class="wasm-live-grid">
          <div class="wasm-preview-shell">
            <div class="wasm-cube-shell">
              <div class="wasm-cube-head">
                <div>
                  <strong>Visual proof: live Three.js cube</strong>
                  <p data-wasm-cube-driver-hint>This uses a normal JavaScript phase accumulator so you can compare it against the WASM-driven version.</p>
                </div>
                <span class="wasm-preview-badge" data-wasm-cube-driver>Driver: JavaScript step</span>
              </div>
              <div class="wasm-cube-frame" data-wasm-cube></div>
              <div class="wasm-cube-actions">
                <button class="wasm-run-button" type="button" data-wasm-cube-js>Cube via JS</button>
                <button class="wasm-run-button wasm-run-button-secondary" type="button" data-wasm-cube-wasm>Cube via WASM</button>
              </div>
            </div>
            <div class="wasm-preview-frame" data-wasm-preview></div>
          </div>
          <div class="wasm-live-controls">
            <div class="wasm-module-status" data-wasm-status>WASM module idle. Auto-running comparison...</div>
            <div class="wasm-workload-shell">
              <div class="wasm-workload-head">
                <strong>Benchmark workload</strong>
                <span data-wasm-workload-copy>Medium: balanced default.</span>
              </div>
              <div class="wasm-workload-buttons" data-wasm-workload-buttons></div>
            </div>
            <div class="wasm-perf-strip">
              <article class="wasm-perf-card">
                <span>Last JS</span>
                <strong data-wasm-perf-js>--</strong>
                <p>CPU baseline</p>
              </article>
              <article class="wasm-perf-card">
                <span>Last WASM</span>
                <strong data-wasm-perf-wasm>--</strong>
                <p>Compiled C++ kernel</p>
              </article>
              <article class="wasm-perf-card">
                <span>Difference</span>
                <strong data-wasm-perf-ratio>Run compare</strong>
                <p data-wasm-perf-note>Same visual output is expected. This row is the reason to care.</p>
              </article>
            </div>
            <div class="wasm-benchmark-actions">
              <button class="wasm-run-button" type="button" data-wasm-run-js>Run JS baseline</button>
              <button class="wasm-run-button wasm-run-button-secondary" type="button" data-wasm-run-kernel>Run WASM kernel</button>
              <button class="wasm-run-button wasm-run-button-secondary" type="button" data-wasm-run-compare>Compare both</button>
            </div>
            <div class="wasm-result-stack">
              <div class="wasm-benchmark-result" data-wasm-js-result>JS result: not run yet.</div>
              <div class="wasm-benchmark-result" data-wasm-kernel-result>WASM result: not run yet.</div>
              <div class="wasm-benchmark-result" data-wasm-compare-result>Comparison: not run yet.</div>
            </div>
            <div class="wasm-explainer">
              <div class="wasm-explainer-card">
                <span class="wasm-panel-kicker">What the WASM is doing</span>
                <p data-wasm-explain-doing>For terrain, WASM reads a height grid, writes vertex positions and triangle indices into linear memory, and returns mesh stats for TypeScript to inspect.</p>
              </div>
              <div class="wasm-explainer-card">
                <span class="wasm-panel-kicker">CPU to GPU handoff</span>
                <p data-wasm-explain-flow>Typed arrays go into WASM, WASM fills numeric output buffers, TypeScript wraps them in THREE.BufferGeometry, and the GPU renders the final terrain. WASM prepares data; the renderer still draws.</p>
              </div>
            </div>
            <div class="wasm-explainer">
              <div class="wasm-explainer-card">
                <span class="wasm-panel-kicker">Is it compiled?</span>
                <p data-wasm-explain-compiled>Yes. This lab compiles C++ into a .wasm binary at build time, then the browser validates and JIT-compiles that bytecode to native code for your CPU.</p>
              </div>
              <div class="wasm-explainer-card">
                <span class="wasm-panel-kicker">Why can it be slower?</span>
                <p data-wasm-explain-slower>This kernel is tiny, so JS↔WASM call overhead and copying into WASM memory can dominate. Modern JS engines are also extremely good at tight typed-array loops.</p>
              </div>
              <div class="wasm-explainer-card">
                <span class="wasm-panel-kicker">When would I use it?</span>
                <p data-wasm-explain-when>Use WASM when the workload is isolated, numeric, and heavy enough to amortize the boundary cost: triangulation, terrain meshing, image processing, packing, or physics-style kernels.</p>
              </div>
              <div class="wasm-explainer-card">
                <span class="wasm-panel-kicker">Mental model</span>
                <p data-wasm-explain-model>Think of TypeScript as the host/UI layer and WASM as a sandboxed native-style compute library. Three.js still renders; WASM just handles the hot loops.</p>
              </div>
            </div>
          </div>
        </div>
      </section>
      <div class="wasm-grid">
        <section class="wasm-panel wasm-panel-tracklist">
          <div class="wasm-panel-head">
            <span class="wasm-panel-kicker">Prototype tracks</span>
            <h3>Choose the first experiment</h3>
          </div>
          <div class="wasm-track-list" data-wasm-track-list></div>
        </section>

        <section class="wasm-panel wasm-panel-detail">
          <div class="wasm-panel-head">
            <span class="wasm-panel-kicker">Selected direction</span>
            <h3 data-wasm-track-title>Terrain Mesh Builder</h3>
          </div>
          <p class="wasm-track-summary" data-wasm-track-summary></p>
          <div class="wasm-detail-grid">
            <article class="wasm-detail-card">
              <strong>Why WASM here</strong>
              <p data-wasm-track-why></p>
            </article>
            <article class="wasm-detail-card">
              <strong>Data in</strong>
              <p data-wasm-track-in></p>
            </article>
            <article class="wasm-detail-card">
              <strong>Data out</strong>
              <p data-wasm-track-out></p>
            </article>
            <article class="wasm-detail-card">
              <strong>Milestone one</strong>
              <p data-wasm-track-milestone></p>
            </article>
          </div>
        </section>
      </div>
      <section class="wasm-panel wasm-panel-live">
        <div class="wasm-panel-head">
          <span class="wasm-panel-kicker">Why ship WASM at all?</span>
          <h3>Compiled Rust physics subsystem in the browser</h3>
        </div>
        <p class="wasm-panel-copy">This is the more honest reason to use WASM here: not to replace every JavaScript loop, but to bring in a mature native-style subsystem. The left side is just enough JS to fake gravity. The right side is Rapier, a real rigid-body engine compiled from Rust to WebAssembly, resolving contacts and stable stacks while Three.js only visualizes the transforms.</p>
        <div class="wasm-live-grid">
          <div class="wasm-preview-shell">
            <div class="wasm-physics-frame" data-wasm-physics></div>
          </div>
          <div class="wasm-live-controls">
            <div class="wasm-module-status" data-wasm-physics-status>Preparing Rapier rigid-body world…</div>
            <div class="wasm-perf-strip">
              <article class="wasm-perf-card">
                <span>JS side</span>
                <strong data-wasm-physics-js>--</strong>
                <p>Gravity + floor clamp only</p>
              </article>
              <article class="wasm-perf-card">
                <span>Rapier step</span>
                <strong data-wasm-physics-wasm>loading</strong>
                <p>Contacts + solver in WASM</p>
              </article>
              <article class="wasm-perf-card">
                <span>Why use it</span>
                <strong>Real subsystem</strong>
                <p data-wasm-physics-note>Compiled Rust physics in the browser, not a toy math loop race.</p>
              </article>
            </div>
            <div class="wasm-benchmark-actions">
              <button class="wasm-run-button" type="button" data-wasm-physics-reset>Restack bodies</button>
              <button class="wasm-run-button wasm-run-button-secondary" type="button" data-wasm-physics-burst>Burst energy</button>
            </div>
            <div class="wasm-explainer">
              <div class="wasm-explainer-card">
                <span class="wasm-panel-kicker">JS side</span>
                <p>This side only integrates gravity, applies a floor clamp, and keeps bodies inside the pad. It is intentionally simple enough to prove that the app can move lots of objects in JavaScript, but it is not doing contacts or stacking.</p>
              </div>
              <div class="wasm-explainer-card">
                <span class="wasm-panel-kicker">Rapier side</span>
                <p>Rapier handles broadphase, narrowphase, contact manifolds, impulses, and solver iterations inside WebAssembly. JavaScript creates bodies and reads transforms back out for rendering.</p>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section class="wasm-panel wasm-panel-live">
        <div class="wasm-panel-head">
          <span class="wasm-panel-kicker">Workload that favors WASM</span>
          <h3>Instanced entity swarm: CPU update, GPU draw</h3>
        </div>
        <p class="wasm-panel-copy">This is the kind of split you would actually reach for in a real app: Three.js renders one instanced batch, while JavaScript or WebAssembly updates thousands of entity transforms on the CPU. The benchmark simulates many frames so the JS to WASM boundary cost has a chance to amortize.</p>
        <div class="wasm-live-grid">
          <div class="wasm-preview-shell">
            <div class="wasm-cube-shell wasm-swarm-shell">
              <div class="wasm-cube-head">
                <div>
                  <strong>Visual proof: 5,000 batched entities</strong>
                  <p data-wasm-swarm-driver-hint>JavaScript is updating the same swarm rules on the CPU, then Three.js uploads the transforms and the GPU draws them as one instanced batch.</p>
                </div>
                <span class="wasm-preview-badge" data-wasm-swarm-driver>Driver: JavaScript swarm step</span>
              </div>
              <div class="wasm-cube-frame wasm-swarm-frame" data-wasm-swarm></div>
              <div class="wasm-preview-meta">
                <span class="wasm-preview-badge" data-wasm-swarm-metrics>5,000 visible entities, one shared geometry/material, CPU updates via JS or WASM.</span>
                <span class="wasm-preview-badge">Rendering stays in Three.js; the GPU still draws the scene.</span>
                <span class="wasm-preview-badge">Benchmark uses 20,000 entities and one batched WASM call so the module can do meaningful work before returning to JS.</span>
              </div>
              <div class="wasm-cube-actions">
                <button class="wasm-run-button" type="button" data-wasm-swarm-js>Swarm via JS</button>
                <button class="wasm-run-button wasm-run-button-secondary" type="button" data-wasm-swarm-wasm>Swarm via WASM</button>
              </div>
            </div>
          </div>
          <div class="wasm-live-controls">
            <div class="wasm-module-status" data-wasm-swarm-status>JavaScript arrays own the swarm state; each frame updates the same typed buffers.</div>
            <div class="wasm-benchmark-actions">
              <button class="wasm-run-button" type="button" data-wasm-swarm-run-js>Run JS swarm benchmark</button>
              <button class="wasm-run-button wasm-run-button-secondary" type="button" data-wasm-swarm-run-wasm>Run WASM swarm benchmark</button>
              <button class="wasm-run-button wasm-run-button-secondary" type="button" data-wasm-swarm-run-compare>Compare swarm</button>
            </div>
            <div class="wasm-result-stack">
              <div class="wasm-benchmark-result" data-wasm-swarm-js-result>JS swarm result: waiting...</div>
              <div class="wasm-benchmark-result" data-wasm-swarm-wasm-result>WASM swarm result: waiting...</div>
              <div class="wasm-benchmark-result" data-wasm-swarm-compare-result>Swarm comparison: waiting...</div>
            </div>
            <div class="wasm-explainer">
              <div class="wasm-explainer-card">
                <span class="wasm-panel-kicker">Why this one wins</span>
                <p>This demo keeps 5,000 visible entities in flat arrays, but the benchmark runs 20,000 entities and lets WASM integrate many frames in one batched call instead of crossing back into JS every frame.</p>
              </div>
              <div class="wasm-explainer-card">
                <span class="wasm-panel-kicker">CPU vs GPU split</span>
                <p>WASM computes positions only. Three.js still uploads matrices, the GPU still runs the shaders, and the renderer still draws the final instanced swarm.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="wasm-lower-grid">
        <section class="wasm-panel">
          <div class="wasm-panel-head">
            <span class="wasm-panel-kicker">API shape</span>
            <h3>Keep the boundary boring</h3>
          </div>
          <p class="wasm-panel-copy">The best version of this is simple: flat arrays cross the boundary, WASM does structured math, and TypeScript turns the result into meshes, overlays, and UI. No renderer logic goes into the module.</p>
          <pre class="wasm-code"><code>TS host  -> typed arrays
WASM     -> numeric kernel work
TS host  -> render / UI / export decisions</code></pre>
        </section>

        <section class="wasm-panel">
          <div class="wasm-panel-head">
            <span class="wasm-panel-kicker">What this proves</span>
            <h3>Each prototype now runs a different kernel</h3>
          </div>
          <p class="wasm-panel-copy">Geometry analyzes loop bounds and area, Terrain now builds a real mesh chunk, and Data Packing quantizes float channels into bytes. Picking a track changes the dataset, the preview, and the actual WASM call.</p>
          <pre class="wasm-code"><code>Geometry  -> analyze_polygon(...)
Terrain   -> build_heightfield_mesh(...)
Packing   -> quantize_unit_f32(...)</code></pre>
        </section>
      </div>
    </div>
  `;

  const trackList = target.querySelector<HTMLDivElement>("[data-wasm-track-list]");
  const title = target.querySelector<HTMLElement>("[data-wasm-track-title]");
  const summary = target.querySelector<HTMLElement>("[data-wasm-track-summary]");
  const why = target.querySelector<HTMLElement>("[data-wasm-track-why]");
  const dataIn = target.querySelector<HTMLElement>("[data-wasm-track-in]");
  const dataOut = target.querySelector<HTMLElement>("[data-wasm-track-out]");
  const milestone = target.querySelector<HTMLElement>("[data-wasm-track-milestone]");
  const liveTitle = target.querySelector<HTMLElement>("[data-wasm-live-title]");
  const liveSummary = target.querySelector<HTMLElement>("[data-wasm-live-summary]");
  const liveCopy = target.querySelector<HTMLElement>("[data-wasm-live-copy]");
  const cubeFrame = target.querySelector<HTMLElement>("[data-wasm-cube]");
  const cubeDriverLabel = target.querySelector<HTMLElement>("[data-wasm-cube-driver]");
  const cubeDriverHint = target.querySelector<HTMLElement>("[data-wasm-cube-driver-hint]");
  const cubeJsButton = target.querySelector<HTMLButtonElement>("[data-wasm-cube-js]");
  const cubeWasmButton = target.querySelector<HTMLButtonElement>("[data-wasm-cube-wasm]");
  const preview = target.querySelector<HTMLElement>("[data-wasm-preview]");
  const status = target.querySelector<HTMLElement>("[data-wasm-status]");
  const workloadButtons = target.querySelector<HTMLElement>("[data-wasm-workload-buttons]");
  const workloadCopy = target.querySelector<HTMLElement>("[data-wasm-workload-copy]");
  const perfJsNode = target.querySelector<HTMLElement>("[data-wasm-perf-js]");
  const perfWasmNode = target.querySelector<HTMLElement>("[data-wasm-perf-wasm]");
  const perfRatioNode = target.querySelector<HTMLElement>("[data-wasm-perf-ratio]");
  const perfNoteNode = target.querySelector<HTMLElement>("[data-wasm-perf-note]");
  const runJsButton = target.querySelector<HTMLButtonElement>("[data-wasm-run-js]");
  const runKernelButton = target.querySelector<HTMLButtonElement>("[data-wasm-run-kernel]");
  const runCompareButton = target.querySelector<HTMLButtonElement>("[data-wasm-run-compare]");
  const jsResultNode = target.querySelector<HTMLElement>("[data-wasm-js-result]");
  const wasmResultNode = target.querySelector<HTMLElement>("[data-wasm-kernel-result]");
  const compareResultNode = target.querySelector<HTMLElement>("[data-wasm-compare-result]");
  const explainDoing = target.querySelector<HTMLElement>("[data-wasm-explain-doing]");
  const explainFlow = target.querySelector<HTMLElement>("[data-wasm-explain-flow]");
  const explainCompiled = target.querySelector<HTMLElement>("[data-wasm-explain-compiled]");
  const explainSlower = target.querySelector<HTMLElement>("[data-wasm-explain-slower]");
  const explainWhen = target.querySelector<HTMLElement>("[data-wasm-explain-when]");
  const explainModel = target.querySelector<HTMLElement>("[data-wasm-explain-model]");
  const physicsFrame = target.querySelector<HTMLElement>("[data-wasm-physics]");
  const physicsStatus = target.querySelector<HTMLElement>("[data-wasm-physics-status]");
  const physicsJsNode = target.querySelector<HTMLElement>("[data-wasm-physics-js]");
  const physicsWasmNode = target.querySelector<HTMLElement>("[data-wasm-physics-wasm]");
  const physicsNoteNode = target.querySelector<HTMLElement>("[data-wasm-physics-note]");
  const physicsResetButton = target.querySelector<HTMLButtonElement>("[data-wasm-physics-reset]");
  const physicsBurstButton = target.querySelector<HTMLButtonElement>("[data-wasm-physics-burst]");
  const swarmFrame = target.querySelector<HTMLElement>("[data-wasm-swarm]");
  const swarmDriverLabel = target.querySelector<HTMLElement>("[data-wasm-swarm-driver]");
  const swarmDriverHint = target.querySelector<HTMLElement>("[data-wasm-swarm-driver-hint]");
  const swarmStatus = target.querySelector<HTMLElement>("[data-wasm-swarm-status]");
  const swarmMetrics = target.querySelector<HTMLElement>("[data-wasm-swarm-metrics]");
  const swarmJsButton = target.querySelector<HTMLButtonElement>("[data-wasm-swarm-js]");
  const swarmWasmButton = target.querySelector<HTMLButtonElement>("[data-wasm-swarm-wasm]");
  const swarmRunJsButton = target.querySelector<HTMLButtonElement>("[data-wasm-swarm-run-js]");
  const swarmRunWasmButton = target.querySelector<HTMLButtonElement>("[data-wasm-swarm-run-wasm]");
  const swarmRunCompareButton = target.querySelector<HTMLButtonElement>("[data-wasm-swarm-run-compare]");
  const swarmJsResultNode = target.querySelector<HTMLElement>("[data-wasm-swarm-js-result]");
  const swarmWasmResultNode = target.querySelector<HTMLElement>("[data-wasm-swarm-wasm-result]");
  const swarmCompareResultNode = target.querySelector<HTMLElement>("[data-wasm-swarm-compare-result]");

  if (
    !trackList ||
    !title ||
    !summary ||
    !why ||
    !dataIn ||
    !dataOut ||
    !milestone ||
    !liveTitle ||
    !liveSummary ||
    !liveCopy ||
    !cubeFrame ||
    !cubeDriverLabel ||
    !cubeDriverHint ||
    !cubeJsButton ||
    !cubeWasmButton ||
    !preview ||
    !status ||
    !workloadButtons ||
    !workloadCopy ||
    !perfJsNode ||
    !perfWasmNode ||
    !perfRatioNode ||
    !perfNoteNode ||
    !runJsButton ||
    !runKernelButton ||
    !runCompareButton ||
    !jsResultNode ||
    !wasmResultNode ||
    !compareResultNode ||
    !explainDoing ||
    !explainFlow ||
    !explainCompiled ||
    !explainSlower ||
    !explainWhen ||
    !explainModel ||
    !physicsFrame ||
    !physicsStatus ||
    !physicsJsNode ||
    !physicsWasmNode ||
    !physicsNoteNode ||
    !physicsResetButton ||
    !physicsBurstButton ||
    !swarmFrame ||
    !swarmDriverLabel ||
    !swarmDriverHint ||
    !swarmStatus ||
    !swarmMetrics ||
    !swarmJsButton ||
    !swarmWasmButton ||
    !swarmRunJsButton ||
    !swarmRunWasmButton ||
    !swarmRunCompareButton ||
    !swarmJsResultNode ||
    !swarmWasmResultNode ||
    !swarmCompareResultNode
  ) {
    throw new Error("Could not mount WASM Lab");
  }

  let selectedTrackId: TrackId = "terrain";
  let selectedWorkloadId: WorkloadId = "medium";
  let selectedCubeDriver: CubeDriver = "js";
  let selectedSwarmDriver: SwarmDriver = "js";
  let runNonce = 0;
  let swarmRunNonce = 0;
  const latestJsResults: Partial<Record<TrackId, WasmBenchmarkResult>> = {};
  const latestWasmResults: Partial<Record<TrackId, WasmBenchmarkResult>> = {};
  const latestTerrainPreviewMeshes: Partial<Record<TerrainPreviewDriver, TerrainMeshPreviewResult>> = {};
  let latestSwarmJsResult: SwarmBenchmarkResult | null = null;
  let latestSwarmWasmResult: SwarmBenchmarkResult | null = null;
  let latestTerrainPreviewDriver: TerrainPreviewDriver = "js";
  let terrainPreviewHandle: TerrainPreviewHandle | null = null;
  const physicsPreview = mountPhysicsPreview(physicsFrame, physicsStatus, physicsJsNode, physicsWasmNode, physicsNoteNode);
  const cubePreview = mountCubePreview(cubeFrame, cubeDriverLabel, cubeDriverHint);
  const swarmPreview = mountSwarmPreview(swarmFrame, swarmDriverLabel, swarmDriverHint, swarmStatus, swarmMetrics);

  const setButtonsDisabled = (disabled: boolean) => {
    runJsButton.disabled = disabled;
    runKernelButton.disabled = disabled;
    runCompareButton.disabled = disabled;
  };

  const setSwarmButtonsDisabled = (disabled: boolean) => {
    swarmRunJsButton.disabled = disabled;
    swarmRunWasmButton.disabled = disabled;
    swarmRunCompareButton.disabled = disabled;
  };

  const renderCubeButtons = () => {
    cubeJsButton.classList.toggle("is-active", selectedCubeDriver === "js");
    cubeWasmButton.classList.toggle("is-active", selectedCubeDriver === "wasm");
  };

  const renderSwarmButtons = () => {
    swarmJsButton.classList.toggle("is-active", selectedSwarmDriver === "js");
    swarmWasmButton.classList.toggle("is-active", selectedSwarmDriver === "wasm");
  };

  const handlePhysicsReset = () => {
    physicsPreview.restack();
  };

  const handlePhysicsBurst = () => {
    physicsPreview.burst();
  };

  const renderWorkloadButtons = () => {
    workloadButtons.innerHTML = WORKLOADS.map(
      (workload) => `
        <button class="wasm-run-button${workload.id === selectedWorkloadId ? " is-active" : " wasm-run-button-secondary"}" type="button" data-wasm-workload="${workload.id}">
          ${workload.label}
        </button>
      `,
    ).join("");

    const current = WORKLOADS.find((workload) => workload.id === selectedWorkloadId) ?? WORKLOADS[1];
    workloadCopy.textContent = `${current.label}: ${current.description}.`;
  };

  const renderBenchmarkButtons = () => {
    if (selectedTrackId === "terrain") {
      runJsButton.textContent = "Run JS mesh build";
      runKernelButton.textContent = "Run WASM mesh build";
      runCompareButton.textContent = "Compare terrain";
      return;
    }

    if (selectedTrackId === "packing") {
      runJsButton.textContent = "Run JS quantizer";
      runKernelButton.textContent = "Run WASM quantizer";
      runCompareButton.textContent = "Compare packing";
      return;
    }

    runJsButton.textContent = "Run JS baseline";
    runKernelButton.textContent = "Run WASM kernel";
    runCompareButton.textContent = "Compare both";
  };

  const renderPerfSummary = () => {
    const jsResult = latestJsResults[selectedTrackId];
    const wasmResult = latestWasmResults[selectedTrackId];

    perfJsNode.textContent = jsResult ? `${jsResult.elapsed.toFixed(2)} ms` : "--";
    perfWasmNode.textContent = wasmResult ? `${wasmResult.elapsed.toFixed(2)} ms` : "--";

    if (!jsResult || !wasmResult) {
      perfRatioNode.textContent = "Run compare";
      perfNoteNode.textContent = "Same visual output is expected. This row is the reason to care.";
      return;
    }

    const ratio = wasmResult.elapsed > 0 ? jsResult.elapsed / wasmResult.elapsed : 0;
    const wasmFaster = ratio >= 1;
    perfRatioNode.textContent = wasmFaster
      ? `${ratio.toFixed(2)}x faster`
      : `${(1 / Math.max(ratio, 0.0001)).toFixed(2)}x slower`;

    perfNoteNode.textContent =
      selectedTrackId === "terrain"
        ? wasmFaster
          ? "WASM is spending its time building the same mesh buffers faster."
          : "This terrain build is still close enough to JS that the copy/boundary cost matters."
        : selectedTrackId === "geometry"
          ? "This tiny kernel is mostly teaching the boundary cost story."
          : "Packing is still a small loop here; try a larger workload to stress it more.";
  };

  const renderTrackButtons = () => {
    trackList.innerHTML = TRACKS.map(
      (track) => `
        <button class="wasm-track-button${track.id === selectedTrackId ? " is-active" : ""}" type="button" data-wasm-track="${track.id}">
          <strong>${track.title}</strong>
          <span>${track.summary}</span>
        </button>
      `,
    ).join("");
  };

  const renderExplanation = () => {
    explainCompiled.textContent = "Yes. This lab compiles C++ into a .wasm binary at build time, then the browser validates and JIT-compiles that bytecode to native code for your CPU.";

    if (selectedTrackId === "geometry") {
      explainSlower.textContent = "This geometry pass is still small and very regular. The JS engine can optimize the typed-array loop well, while the WASM path pays for crossing the JS↔WASM boundary and copying the point buffer first.";
      explainWhen.textContent = "Geometry is a good WASM target once the work gets heavier: polygon cleanup, ear clipping, offsetting walls, triangulation, or mesh generation where one call does a lot more than a simple bounds scan.";
    } else if (selectedTrackId === "terrain") {
      explainSlower.textContent = "This terrain path is finally doing something engine-shaped: it turns one heightfield into a whole indexed mesh chunk. If it is still close to JS, that usually means the workload is only medium-sized or the buffer copies are still a big share of total cost.";
      explainWhen.textContent = "Terrain becomes a strong WASM target when you batch chunk meshing, seam stitching, normals, LOD simplification, erosion, or physics prep into a small number of large kernel calls.";
    } else {
      explainSlower.textContent = "This packing kernel is mostly a tiny quantization loop. If each call only touches a modest buffer once, JavaScript can be competitive and the JS↔WASM handoff may outweigh the benefit.";
      explainWhen.textContent = "Packing is a good WASM fit when you batch much larger buffers, keep memory resident in the module, or chain multiple transforms like quantize → swizzle → checksum → compress in one pass.";
    }

    explainModel.textContent = "Think of TypeScript as the host/UI layer and WASM as a sandboxed native-style compute library. Three.js still renders the scene; WASM is where you move isolated hot loops once the workload is heavy enough.";
  };

  const renderTrackDetails = () => {
    const track = TRACKS.find((item) => item.id === selectedTrackId) ?? TRACKS[0];
    title.textContent = track.title;
    summary.textContent = track.summary;
    why.textContent = track.why;
    dataIn.textContent = track.dataIn;
    dataOut.textContent = track.dataOut;
    milestone.textContent = track.milestone;
    liveTitle.textContent = track.liveTitle;
    liveSummary.textContent = track.liveSummary;
    liveCopy.textContent =
      selectedTrackId === "geometry"
        ? "The preview below uses polygon loops. JavaScript and WebAssembly both analyze them, then the tab overlays their computed bounds so you can see and measure whether they agree."
        : selectedTrackId === "terrain"
          ? "The preview below uses a heightfield. JavaScript and WebAssembly both build the same terrain chunk so you can compare real mesh-generation timings and inspect the actual output buffers in a Three.js preview."
          : "The preview below uses normalized float channels. JavaScript and WebAssembly both quantize them into byte values so you can compare packed output as well as timing.";
    cubePreview.setTrack(selectedTrackId);
    renderExplanation();

    if (selectedTrackId === "geometry") {
      explainDoing.textContent = "For geometry, WASM reads flat XY point pairs, runs a shoelace-area scan plus min/max bounds accumulation, and writes five floats back out: total area, minX, minY, maxX, and maxY.";
      explainFlow.textContent = "TypeScript builds the point buffer, WASM scans it, then TypeScript draws the SVG overlays. The GPU is barely involved here, which is why this is mainly a boundary-cost lesson rather than a speed demo.";
      explainSlower.textContent = "This geometry pass is still small and very regular. The JS engine can optimize the typed-array loop well, while the WASM path pays for crossing the JS<->WASM boundary and copying the point buffer first.";
      explainWhen.textContent = "Geometry is a good WASM target once the work gets heavier: polygon cleanup, ear clipping, offsetting walls, triangulation, or mesh generation where one call does a lot more than a simple bounds scan.";
    } else if (selectedTrackId === "terrain") {
      explainDoing.textContent = "For terrain, WASM reads the raw height samples, generates every vertex position, chooses triangle diagonals cell by cell, writes the full index buffer, and returns min/max/average statistics for the chunk.";
      explainFlow.textContent = "Height samples go into WASM memory, WASM writes positions[] and indices[], TypeScript wraps those arrays in THREE.BufferGeometry, and then the GPU renders the mesh. This is the clearest CPU-prep -> GPU-draw handoff in the tab.";
      explainSlower.textContent = "This terrain path is finally doing something engine-shaped: it turns one heightfield into a whole indexed mesh chunk. If it is still close to JS, that usually means the workload is only medium-sized or the buffer copies are still a big share of total cost.";
      explainWhen.textContent = "Terrain becomes a strong WASM target when you batch chunk meshing, seam stitching, normals, LOD simplification, erosion, or physics prep into a small number of large kernel calls.";
    } else {
      explainDoing.textContent = "For packing, WASM scans normalized floats, quantizes them into bytes, accumulates checksum and range data, and hands the compact byte buffer back to TypeScript.";
      explainFlow.textContent = "The output here is not geometry but packed buffers. TypeScript can then save, upload, or visualize those bytes while the GPU stays completely uninvolved.";
      explainSlower.textContent = "This packing kernel is mostly a tiny quantization loop. If each call only touches a modest buffer once, JavaScript can be competitive and the JS<->WASM handoff may outweigh the benefit.";
      explainWhen.textContent = "Packing is a good WASM fit when you batch much larger buffers, keep memory resident in the module, or chain multiple transforms like quantize -> swizzle -> checksum -> compress in one pass.";
    }
  };

  const renderPreview = () => {
    if (selectedTrackId === "geometry") {
      if (terrainPreviewHandle) {
        terrainPreviewHandle.dispose();
        terrainPreviewHandle = null;
      }

      preview.innerHTML = renderGeometryPreview(
        getGeometryPreviewDataset(),
        (latestJsResults.geometry as GeometryBenchmarkResult | undefined) ?? null,
        (latestWasmResults.geometry as GeometryBenchmarkResult | undefined) ?? null,
      );
      return;
    }

    if (selectedTrackId === "terrain") {
      if (!terrainPreviewHandle) {
        terrainPreviewHandle = mountTerrainPreview(preview, (driver) => {
          if (driver === "wasm" && !latestTerrainPreviewMeshes.wasm) {
            status.textContent = "Run WASM mesh build or Compare terrain first, then switch the preview to the WASM mesh.";
            terrainPreviewHandle?.setDriver(latestTerrainPreviewDriver);
            return;
          }

          latestTerrainPreviewDriver = driver;
          const nextMesh = latestTerrainPreviewMeshes[driver] ?? latestTerrainPreviewMeshes.js;

          if (nextMesh) {
            terrainPreviewHandle?.setMesh(nextMesh, driver);
            status.textContent = driver === "wasm"
              ? "Showing the WASM-built terrain buffers."
              : "Showing the JavaScript-built terrain buffers.";
          }
        });
      }

      if (!latestTerrainPreviewMeshes.js) {
        latestTerrainPreviewMeshes.js = createTerrainPreviewMeshInJs(getTerrainPreviewDataset());
      }

      const mesh = latestTerrainPreviewMeshes[latestTerrainPreviewDriver] ?? latestTerrainPreviewMeshes.js;

      if (mesh) {
        terrainPreviewHandle.setMesh(mesh, latestTerrainPreviewDriver);
      }
      return;
    }

    if (terrainPreviewHandle) {
      terrainPreviewHandle.dispose();
      terrainPreviewHandle = null;
    }

    preview.innerHTML = renderPackingPreview(
      getPackingPreviewDataset(),
      (latestJsResults.packing as PackingBenchmarkResult | undefined) ?? null,
      (latestWasmResults.packing as PackingBenchmarkResult | undefined) ?? null,
    );
  };

  const runSelectedJs = (): GeometryBenchmarkResult | TerrainMeshBenchmarkResult | PackingBenchmarkResult => {
    if (selectedTrackId === "geometry") {
      const dataset = getGeometryBenchmarkDataset(selectedWorkloadId);
      const result = benchmark(() => {
        const analysis = analyzeGeometryInJs(dataset.points, dataset.loops, dataset.verticesPerLoop);
        return {
          ...analysis,
          loops: dataset.loops,
          vertices: dataset.loops * dataset.verticesPerLoop,
          boundsWidth: analysis.maxX - analysis.minX,
          boundsHeight: analysis.maxY - analysis.minY,
        };
      });

      latestJsResults.geometry = result;
      jsResultNode.textContent = formatGeometryResult("JS", result);
      renderPerfSummary();
      return result;
    }

    if (selectedTrackId === "terrain") {
      const dataset = getTerrainBenchmarkDataset(selectedWorkloadId);
      const buffers = createTerrainMeshBuffers(dataset.width, dataset.height);
      const result = benchmark(() => ({
        ...buildHeightfieldMeshInJs(dataset.values, dataset.width, dataset.height, buffers),
        samples: dataset.values.length,
      }));

      latestJsResults.terrain = result;
      latestTerrainPreviewMeshes.js = createTerrainPreviewMeshInJs(getTerrainPreviewDataset());
      latestTerrainPreviewDriver = "js";
      jsResultNode.textContent = formatTerrainResult("JS", result);
      renderPerfSummary();
      return result;
    }

    const dataset = getPackingBenchmarkDataset(selectedWorkloadId);
    const result = benchmark(() => ({
      ...quantizeUnitFloatsInJs(dataset.values),
      samples: dataset.values.length,
    }));

    latestJsResults.packing = result;
    jsResultNode.textContent = formatPackingResult("JS", result);
    renderPerfSummary();
    return result;
  };

  const runSelectedWasm = async (): Promise<GeometryBenchmarkResult | TerrainMeshBenchmarkResult | PackingBenchmarkResult> => {
    status.textContent = "Loading WASM module...";
    const kernel = await loadGeometryKernel();

    if (selectedTrackId === "geometry") {
      const dataset = getGeometryBenchmarkDataset(selectedWorkloadId);
      status.textContent = "WASM module loaded. Running polygon analysis kernel.";
      const result = benchmark(() => {
        const analysis = kernel.analyzePolygon(dataset.points, dataset.loops, dataset.verticesPerLoop);
        return {
          ...analysis,
          loops: dataset.loops,
          vertices: dataset.loops * dataset.verticesPerLoop,
          boundsWidth: analysis.maxX - analysis.minX,
          boundsHeight: analysis.maxY - analysis.minY,
        };
      });

      latestWasmResults.geometry = result;
      wasmResultNode.textContent = formatGeometryResult("WASM", result);
      status.textContent = "WASM module loaded and ready.";
      renderPerfSummary();
      return result;
    }

    if (selectedTrackId === "terrain") {
      const dataset = getTerrainBenchmarkDataset(selectedWorkloadId);
      status.textContent = "WASM module loaded. Running heightfield mesh kernel.";
      const result = benchmark(() => {
        const mesh = kernel.buildHeightfieldMesh(dataset.values, dataset.width, dataset.height);

        return {
          vertexCount: mesh.vertexCount,
          triangleCount: mesh.triangleCount,
          min: mesh.min,
          max: mesh.max,
          average: mesh.average,
          checksum: mesh.checksum,
          samples: dataset.values.length,
        };
      });

      latestWasmResults.terrain = result;
      const previewDataset = getTerrainPreviewDataset();
      latestTerrainPreviewMeshes.wasm = {
        ...kernel.buildHeightfieldMesh(previewDataset.values, previewDataset.width, previewDataset.height, {
          copyOut: true,
        }),
        width: previewDataset.width,
        height: previewDataset.height,
      };
      latestTerrainPreviewDriver = "wasm";
      wasmResultNode.textContent = formatTerrainResult("WASM", result);
      status.textContent = "WASM module loaded and ready.";
      renderPerfSummary();
      return result;
    }

    const dataset = getPackingBenchmarkDataset(selectedWorkloadId);
    status.textContent = "WASM module loaded. Running quantization kernel.";
    const result = benchmark(() => ({
      ...kernel.quantizeUnitFloats(dataset.values),
      samples: dataset.values.length,
    }));

    latestWasmResults.packing = result;
    wasmResultNode.textContent = formatPackingResult("WASM", result);
    status.textContent = "WASM module loaded and ready.";
    renderPerfSummary();
    return result;
  };

  const updateCompareText = (
    jsResult: GeometryBenchmarkResult | TerrainMeshBenchmarkResult | PackingBenchmarkResult,
    wasmResult: GeometryBenchmarkResult | TerrainMeshBenchmarkResult | PackingBenchmarkResult,
  ) => {
    compareResultNode.textContent =
      selectedTrackId === "geometry"
        ? formatGeometryCompare(jsResult as GeometryBenchmarkResult, wasmResult as GeometryBenchmarkResult)
        : selectedTrackId === "terrain"
          ? formatTerrainCompare(jsResult as TerrainMeshBenchmarkResult, wasmResult as TerrainMeshBenchmarkResult)
          : formatPackingCompare(jsResult as PackingBenchmarkResult, wasmResult as PackingBenchmarkResult);
  };

  const runCompare = async () => {
    const nonce = ++runNonce;
    compareResultNode.textContent = "Comparing JS and WASM...";
    setButtonsDisabled(true);

    try {
      const jsResult = runSelectedJs();
      renderPreview();
      const wasmResult = await runSelectedWasm();

      if (nonce !== runNonce) {
        return;
      }

      renderPreview();
      updateCompareText(jsResult, wasmResult);
      renderPerfSummary();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      compareResultNode.textContent = `Comparison failed: ${details}`;
      status.textContent = "WASM module failed to load.";
    } finally {
      if (nonce === runNonce) {
        setButtonsDisabled(false);
      }
    }
  };

  const runSwarmJs = () => {
    const dataset = getSwarmDataset(SWARM_BENCHMARK_ENTITIES);
    const result = benchmarkSwarmInJs(dataset.baseState);
    latestSwarmJsResult = result;
    swarmJsResultNode.textContent = formatSwarmResult("JS", result);
    return result;
  };

  const runSwarmWasm = async () => {
    swarmStatus.textContent = "Loading WASM swarm kernel...";
    const dataset = getSwarmDataset(SWARM_BENCHMARK_ENTITIES);
    const result = await benchmarkSwarmInWasm(dataset.baseState);
    latestSwarmWasmResult = result;
    swarmWasmResultNode.textContent = formatSwarmResult("WASM", result);
    swarmStatus.textContent = selectedSwarmDriver === "wasm"
      ? "WASM memory owns persistent swarm state between frames."
      : "JavaScript arrays own the swarm state; each frame updates the same typed buffers.";
    return result;
  };

  const runSwarmCompare = async () => {
    const nonce = ++swarmRunNonce;
    swarmCompareResultNode.textContent = "Comparing JS and WASM swarm updates...";
    setSwarmButtonsDisabled(true);
    swarmPreview.setBenchmarking(true);

    try {
      const jsResult = runSwarmJs();
      const wasmResult = await runSwarmWasm();

      if (nonce !== swarmRunNonce) {
        return;
      }

      swarmCompareResultNode.textContent = formatSwarmCompare(jsResult, wasmResult);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      swarmCompareResultNode.textContent = `Swarm comparison failed: ${details}`;
      swarmStatus.textContent = "WASM swarm benchmark failed.";
    } finally {
      if (nonce === swarmRunNonce) {
        setSwarmButtonsDisabled(false);
      }
      swarmPreview.setBenchmarking(false);
    }
  };

  const handleTrackClick = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-wasm-track]");

    if (!button) {
      return;
    }

    const nextTrackId = (button.dataset.wasmTrack as TrackId | undefined) ?? "terrain";

    if (nextTrackId === selectedTrackId) {
      return;
    }

    selectedTrackId = nextTrackId;
    renderTrackButtons();
    renderBenchmarkButtons();
    renderTrackDetails();
    renderPreview();
    jsResultNode.textContent = "JS result: waiting for selected track run.";
    wasmResultNode.textContent = "WASM result: waiting for selected track run.";
    compareResultNode.textContent = "Comparison: pending for selected track.";
    renderPerfSummary();
    status.textContent = `Selected ${TRACKS.find((track) => track.id === selectedTrackId)?.liveTitle ?? "kernel"}. Running fresh comparison...`;
    void runCompare();
  };

  const handleWorkloadClick = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-wasm-workload]");

    if (!button) {
      return;
    }

    const nextWorkload = (button.dataset.wasmWorkload as WorkloadId | undefined) ?? "medium";

    if (nextWorkload === selectedWorkloadId) {
      return;
    }

    selectedWorkloadId = nextWorkload;
    renderWorkloadButtons();
    jsResultNode.textContent = "JS result: waiting for selected workload run.";
    wasmResultNode.textContent = "WASM result: waiting for selected workload run.";
    compareResultNode.textContent = "Comparison: pending for selected workload.";
    renderPerfSummary();
    status.textContent = `Selected ${nextWorkload} workload. Running fresh comparison...`;
    void runCompare();
  };

  const handleRunJs = () => {
    jsResultNode.textContent = "Running JS baseline...";
    requestAnimationFrame(() => {
      try {
        const result = runSelectedJs();
        renderPreview();
        compareResultNode.textContent =
          selectedTrackId === "geometry"
            ? `Comparison: JS polygon analysis complete at ${result.elapsed.toFixed(2)} ms avg.`
            : selectedTrackId === "terrain"
              ? `Comparison: JS terrain mesh build complete at ${result.elapsed.toFixed(2)} ms avg.`
              : `Comparison: JS packing pass complete at ${result.elapsed.toFixed(2)} ms avg.`;
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        jsResultNode.textContent = `JS result failed: ${details}`;
      }
    });
  };

  const handleRunWasm = () => {
    wasmResultNode.textContent = "Running WASM kernel...";
    setButtonsDisabled(true);
    void (async () => {
      try {
        const result = await runSelectedWasm();
        renderPreview();
        compareResultNode.textContent =
          selectedTrackId === "geometry"
            ? `Comparison: WASM polygon analysis complete at ${result.elapsed.toFixed(2)} ms avg.`
            : selectedTrackId === "terrain"
              ? `Comparison: WASM terrain mesh build complete at ${result.elapsed.toFixed(2)} ms avg.`
              : `Comparison: WASM packing pass complete at ${result.elapsed.toFixed(2)} ms avg.`;
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        status.textContent = "WASM module failed to load.";
        wasmResultNode.textContent = `WASM result failed: ${details}`;
      } finally {
        setButtonsDisabled(false);
      }
    })();
  };

  const handleRunCompare = () => {
    void runCompare();
  };

  const handleCubeJs = () => {
    selectedCubeDriver = "js";
    cubePreview.setDriver("js");
    renderCubeButtons();
  };

  const handleCubeWasm = () => {
    selectedCubeDriver = "wasm";
    cubePreview.setDriver("wasm");
    renderCubeButtons();
  };

  const handleSwarmJs = () => {
    selectedSwarmDriver = "js";
    swarmPreview.setDriver("js");
    renderSwarmButtons();
  };

  const handleSwarmWasm = () => {
    selectedSwarmDriver = "wasm";
    swarmPreview.setDriver("wasm");
    renderSwarmButtons();
  };

  const handleRunSwarmJs = () => {
    swarmJsResultNode.textContent = "Running JS swarm benchmark...";
    swarmPreview.setBenchmarking(true);
    requestAnimationFrame(() => {
      try {
        const result = runSwarmJs();
        swarmCompareResultNode.textContent = `Swarm comparison: JS finished at ${result.elapsed.toFixed(2)} ms avg.`;
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        swarmJsResultNode.textContent = `JS swarm failed: ${details}`;
      } finally {
        swarmPreview.setBenchmarking(false);
      }
    });
  };

  const handleRunSwarmWasm = () => {
    swarmWasmResultNode.textContent = "Running WASM swarm benchmark...";
    setSwarmButtonsDisabled(true);
    swarmPreview.setBenchmarking(true);
    void (async () => {
      try {
        const result = await runSwarmWasm();
        swarmCompareResultNode.textContent = `Swarm comparison: WASM finished at ${result.elapsed.toFixed(2)} ms avg.`;
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        swarmStatus.textContent = "WASM swarm benchmark failed.";
        swarmWasmResultNode.textContent = `WASM swarm failed: ${details}`;
      } finally {
        setSwarmButtonsDisabled(false);
        swarmPreview.setBenchmarking(false);
      }
    })();
  };

  const handleRunSwarmCompare = () => {
    void runSwarmCompare();
  };

  renderTrackButtons();
  renderWorkloadButtons();
  renderBenchmarkButtons();
  renderCubeButtons();
  renderSwarmButtons();
  renderTrackDetails();
  renderPreview();
  renderPerfSummary();

  trackList.addEventListener("click", handleTrackClick);
  workloadButtons.addEventListener("click", handleWorkloadClick);
  runJsButton.addEventListener("click", handleRunJs);
  runKernelButton.addEventListener("click", handleRunWasm);
  runCompareButton.addEventListener("click", handleRunCompare);
  cubeJsButton.addEventListener("click", handleCubeJs);
  cubeWasmButton.addEventListener("click", handleCubeWasm);
  physicsResetButton.addEventListener("click", handlePhysicsReset);
  physicsBurstButton.addEventListener("click", handlePhysicsBurst);
  swarmJsButton.addEventListener("click", handleSwarmJs);
  swarmWasmButton.addEventListener("click", handleSwarmWasm);
  swarmRunJsButton.addEventListener("click", handleRunSwarmJs);
  swarmRunWasmButton.addEventListener("click", handleRunSwarmWasm);
  swarmRunCompareButton.addEventListener("click", handleRunSwarmCompare);

  void runCompare();
  void runSwarmCompare();

  return {
    setVisible(visible: boolean) {
      target.hidden = !visible;
      physicsPreview.setVisible(visible);
      cubePreview.setVisible(visible);
      swarmPreview.setVisible(visible);
    },
    dispose() {
      trackList.removeEventListener("click", handleTrackClick);
      workloadButtons.removeEventListener("click", handleWorkloadClick);
      runJsButton.removeEventListener("click", handleRunJs);
      runKernelButton.removeEventListener("click", handleRunWasm);
      runCompareButton.removeEventListener("click", handleRunCompare);
      cubeJsButton.removeEventListener("click", handleCubeJs);
      cubeWasmButton.removeEventListener("click", handleCubeWasm);
      physicsResetButton.removeEventListener("click", handlePhysicsReset);
      physicsBurstButton.removeEventListener("click", handlePhysicsBurst);
      swarmJsButton.removeEventListener("click", handleSwarmJs);
      swarmWasmButton.removeEventListener("click", handleSwarmWasm);
      swarmRunJsButton.removeEventListener("click", handleRunSwarmJs);
      swarmRunWasmButton.removeEventListener("click", handleRunSwarmWasm);
      swarmRunCompareButton.removeEventListener("click", handleRunSwarmCompare);
      physicsPreview.dispose();
      cubePreview.dispose();
      swarmPreview.dispose();
      if (terrainPreviewHandle) {
        terrainPreviewHandle.dispose();
      }
    },
  };
}
