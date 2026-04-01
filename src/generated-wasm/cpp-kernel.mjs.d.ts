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

declare const createCppKernelModule: (options?: {
  locateFile?: (path: string, prefix: string) => string;
}) => Promise<CppKernelModule>;

export default createCppKernelModule;
