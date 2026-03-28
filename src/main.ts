import "./style.css";

import * as THREE from "three/webgpu";
import WebGPU from "three/addons/capabilities/WebGPU.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import GUI from "three/addons/libs/lil-gui.module.min.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SimplexNoise } from "three/addons/math/SimplexNoise.js";
import { Fn, color, cos, instanceIndex, instancedArray, localId, mix, normalLocal, positionLocal, sin, textureStore, time, uvec2, uv, vec3, vec4, workgroupId } from "three/tsl";

type CameraMode = "orbit" | "fps";

type ExampleViewState = {
  wireframe: boolean;
  cameraMode: CameraMode;
  moveSpeed: number;
  lookSpeed: number;
};

type ExampleGuiContext = {
  gui: GUI;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGPURenderer;
  controls: OrbitControls;
  cameraRig: ExampleCameraRig;
  viewState: ExampleViewState;
  setWireframe: (enabled: boolean) => void;
};

type ExampleRuntime = {
  update?: (elapsed: number, delta: number) => void;
  dispose?: () => void;
  setupGui?: (context: ExampleGuiContext) => void;
  setWireframe?: (enabled: boolean) => void;
};

type ExampleContext = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGPURenderer;
  controls: OrbitControls;
};

type ExampleDefinition = {
  step: string;
  title: string;
  summary: string;
  notes: string;
  tags: string[];
  cameraPosition: [number, number, number];
  target?: [number, number, number];
  create: (context: ExampleContext) => ExampleRuntime;
};

type MountedExample = ExampleRuntime & {
  host: HTMLDivElement;
  card: HTMLElement;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  renderer: THREE.WebGPURenderer;
  controls: OrbitControls;
  resizeObserver: ResizeObserver;
  cameraRig: ExampleCameraRig;
  gui: GUI;
  fpsLabel: HTMLDivElement;
  fpsSmoothed: number;
  failed: boolean;
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Could not find #app");
}

function createUvReferenceTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not create 2D canvas context");
  }

  context.fillStyle = "#10233d";
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.strokeStyle = "#3f7fe4";
  context.lineWidth = 2;

  for (let x = 0; x <= canvas.width; x += 32) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, canvas.height);
    context.stroke();
  }

  for (let y = 0; y <= canvas.height; y += 32) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }

  context.fillStyle = "#72d8ff";
  context.font = "bold 24px sans-serif";
  context.fillText("U", 220, 34);
  context.fillText("V", 16, 236);

  context.fillStyle = "#ffb15f";
  context.font = "bold 42px sans-serif";
  context.fillText("UV", 90, 138);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

function createLookdevFloorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not create 2D canvas context");
  }

  context.fillStyle = "#616a7a";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const majorStep = 64;
  const minorStep = 16;

  for (let y = 0; y < canvas.height; y += majorStep) {
    for (let x = 0; x < canvas.width; x += majorStep) {
      const parity = (x / majorStep + y / majorStep) % 2;
      context.fillStyle = parity === 0 ? "#5d6676" : "#505969";
      context.fillRect(x, y, majorStep, majorStep);
    }
  }

  context.globalAlpha = 0.18;
  for (let y = 0; y < canvas.height; y += minorStep) {
    for (let x = 0; x < canvas.width; x += minorStep) {
      const parity = (x / minorStep + y / minorStep) % 2;
      context.fillStyle = parity === 0 ? "#818b9a" : "#465061";
      context.fillRect(x, y, minorStep, minorStep);
    }
  }

  context.globalAlpha = 0.1;
  context.strokeStyle = "#c7cfda";
  context.lineWidth = 2;

  for (let x = 0; x <= canvas.width; x += majorStep) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, canvas.height);
    context.stroke();
  }

  for (let y = 0; y <= canvas.height; y += majorStep) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }

  context.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

function createOrbitLine(radius: number, colorValue: string): THREE.Line {
  const points: THREE.Vector3[] = [];

  for (let index = 0; index < 96; index += 1) {
    const angle = index / 96 * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }

  points.push(points[0].clone());

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: colorValue,
    transparent: true,
    opacity: 0.45,
  });

  return new THREE.Line(geometry, material);
}

function isWireframeCapable(material: THREE.Material): material is THREE.Material & { wireframe: boolean } {
  return "wireframe" in material;
}

function setSceneWireframe(root: THREE.Object3D, enabled: boolean): void {
  root.traverse((object) => {
    if ((object.userData as { skipGlobalWireframe?: boolean }).skipGlobalWireframe) {
      return;
    }

    if (!("material" in object)) {
      return;
    }

    const material = object.material;

    if (Array.isArray(material)) {
      for (const item of material) {
        if (isWireframeCapable(item)) {
          item.wireframe = enabled;
        }
      }

      return;
    }

    if (material instanceof THREE.Material && isWireframeCapable(material)) {
      material.wireframe = enabled;
    }
  });
}

type SkinnedWireframeOverlay = {
  update: () => void;
  setVisible: (visible: boolean) => void;
  dispose: () => void;
};

type MeshWireframeOverlay = {
  setVisible: (visible: boolean) => void;
  dispose: () => void;
};

function createMeshWireframeOverlay(sourceMesh: THREE.Mesh): MeshWireframeOverlay | null {
  if (!(sourceMesh.geometry instanceof THREE.BufferGeometry)) {
    return null;
  }

  const overlay = new THREE.LineSegments(
    new THREE.WireframeGeometry(sourceMesh.geometry),
    new THREE.LineBasicMaterial({
      color: "#e4f6ff",
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  overlay.visible = false;
  overlay.frustumCulled = false;
  overlay.renderOrder = 2;
  overlay.userData.skipGlobalWireframe = true;
  sourceMesh.add(overlay);

  return {
    setVisible: (visible: boolean) => {
      overlay.visible = visible;
    },
    dispose: () => {
      sourceMesh.remove(overlay);
      overlay.geometry.dispose();
      (overlay.material as THREE.Material).dispose();
    },
  };
}

function createSkinnedWireframeOverlay(sourceMesh: THREE.SkinnedMesh): SkinnedWireframeOverlay | null {
  const sourceGeometry = sourceMesh.geometry;
  const sourcePosition = sourceGeometry.getAttribute("position");

  if (!(sourcePosition instanceof THREE.BufferAttribute)) {
    return null;
  }

  const edgeVertexIndices: number[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (a: number, b: number) => {
    if (a === b) {
      return;
    }

    const min = Math.min(a, b);
    const max = Math.max(a, b);
    const key = `${min}:${max}`;

    if (seenEdges.has(key)) {
      return;
    }

    seenEdges.add(key);
    edgeVertexIndices.push(a, b);
  };

  if (sourceGeometry.index) {
    const indexArray = sourceGeometry.index.array;

    for (let index = 0; index < sourceGeometry.index.count; index += 3) {
      const a = Number(indexArray[index]);
      const b = Number(indexArray[index + 1]);
      const c = Number(indexArray[index + 2]);
      addEdge(a, b);
      addEdge(b, c);
      addEdge(c, a);
    }
  } else {
    for (let index = 0; index < sourcePosition.count; index += 3) {
      addEdge(index, index + 1);
      addEdge(index + 1, index + 2);
      addEdge(index + 2, index);
    }
  }

  if (edgeVertexIndices.length === 0) {
    return null;
  }

  const linePositions = new Float32Array(edgeVertexIndices.length * 3);
  const linePositionAttribute = new THREE.BufferAttribute(linePositions, 3);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute("position", linePositionAttribute);

  const lineMaterial = new THREE.LineBasicMaterial({
    color: "#e6f7ff",
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    toneMapped: false,
  });

  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.visible = false;
  lines.frustumCulled = false;
  lines.renderOrder = 3;
  sourceMesh.add(lines);

  const workingVertex = new THREE.Vector3();
  const skinnedMesh = sourceMesh as THREE.SkinnedMesh & {
    applyBoneTransform: (index: number, vector: THREE.Vector3) => THREE.Vector3;
  };

  return {
    update: () => {
      if (!lines.visible) {
        return;
      }

      for (let index = 0; index < edgeVertexIndices.length; index += 1) {
        const vertexIndex = edgeVertexIndices[index];
        workingVertex.fromBufferAttribute(sourcePosition, vertexIndex);
        skinnedMesh.applyBoneTransform(vertexIndex, workingVertex);
        const offset = index * 3;
        linePositions[offset] = workingVertex.x;
        linePositions[offset + 1] = workingVertex.y;
        linePositions[offset + 2] = workingVertex.z;
      }

      linePositionAttribute.needsUpdate = true;
    },
    setVisible: (visible: boolean) => {
      lines.visible = visible;
    },
    dispose: () => {
      sourceMesh.remove(lines);
      lineGeometry.dispose();
      lineMaterial.dispose();
    },
  };
}

class ExampleCameraRig {
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly translation = new THREE.Vector3();
  private readonly orbitTarget = new THREE.Vector3();
  private readonly viewState: ExampleViewState;
  private pointerId: number | null = null;
  private pointerButton = -1;
  private lastClientX = 0;
  private lastClientY = 0;
  private orbitDistance = 6;
  private readonly keys = new Set<string>();
  mode: CameraMode;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    private readonly domElement: HTMLCanvasElement,
    viewState: ExampleViewState,
  ) {
    this.viewState = viewState;
    this.mode = viewState.cameraMode;

    this.domElement.tabIndex = 0;
    this.domElement.style.outline = "none";
    this.syncOrbitDistance();
    this.domElement.addEventListener("contextmenu", this.handleContextMenu);
    this.domElement.addEventListener("pointerdown", this.handlePointerDown);
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) {
      this.viewState.cameraMode = mode;
      return;
    }

    this.keys.clear();
    this.pointerButton = -1;

    if (this.pointerId !== null && this.domElement.hasPointerCapture(this.pointerId)) {
      this.domElement.releasePointerCapture(this.pointerId);
    }

    this.pointerId = null;

    if (mode === "fps") {
      this.syncOrbitDistance();
      this.controls.enabled = false;
    } else {
      this.camera.getWorldDirection(this.orbitTarget);
      this.controls.target.copy(this.camera.position).addScaledVector(this.orbitTarget, this.orbitDistance);
      this.controls.enabled = true;
      this.controls.update();
      this.syncOrbitDistance();
    }

    this.mode = mode;
    this.viewState.cameraMode = mode;
  }

  update(delta: number): void {
    if (this.mode === "orbit") {
      this.controls.enabled = true;
      this.controls.update();
      this.syncOrbitDistance();
      return;
    }

    this.controls.enabled = false;
    this.applyKeyboardMotion(delta);
  }

  dispose(): void {
    this.domElement.removeEventListener("contextmenu", this.handleContextMenu);
    this.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
  }

  private syncOrbitDistance(): void {
    this.orbitDistance = Math.max(this.camera.position.distanceTo(this.controls.target), 0.75);
  }

  private applyKeyboardMotion(delta: number): void {
    this.camera.getWorldDirection(this.forward).normalize();
    this.right.crossVectors(this.forward, this.camera.up).normalize();
    this.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    this.translation.set(0, 0, 0);

    if (this.keys.has("KeyW")) {
      this.translation.add(this.forward);
    }
    if (this.keys.has("KeyS")) {
      this.translation.addScaledVector(this.forward, -1);
    }
    if (this.keys.has("KeyD")) {
      this.translation.add(this.right);
    }
    if (this.keys.has("KeyA")) {
      this.translation.addScaledVector(this.right, -1);
    }
    if (this.keys.has("KeyE")) {
      this.translation.add(this.up);
    }
    if (this.keys.has("KeyQ")) {
      this.translation.addScaledVector(this.up, -1);
    }

    if (this.translation.lengthSq() === 0) {
      return;
    }

    this.translation.normalize().multiplyScalar(this.viewState.moveSpeed * delta);
    this.camera.position.add(this.translation);
  }

  private rotateCamera(deltaX: number, deltaY: number): void {
    this.euler.setFromQuaternion(this.camera.quaternion);
    this.euler.y -= deltaX * 0.0024 * this.viewState.lookSpeed;
    this.euler.x -= deltaY * 0.0024 * this.viewState.lookSpeed;
    this.euler.x = THREE.MathUtils.clamp(this.euler.x, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this.camera.quaternion.setFromEuler(this.euler);
  }

  private panCamera(deltaX: number, deltaY: number): void {
    const panScale = 0.0105 * this.viewState.moveSpeed;
    this.camera.getWorldDirection(this.forward).normalize();
    this.right.crossVectors(this.forward, this.camera.up).normalize();
    this.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    this.translation.copy(this.right).multiplyScalar(-deltaX * panScale);
    this.translation.addScaledVector(this.up, deltaY * panScale);
    this.camera.position.add(this.translation);
  }

  private handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private handlePointerDown = (event: PointerEvent): void => {
    this.domElement.focus();

    if (this.mode !== "fps") {
      return;
    }

    if (event.button !== 0 && event.button !== 2) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.pointerId = event.pointerId;
    this.pointerButton = event.button;
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.domElement.setPointerCapture(event.pointerId);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.mode !== "fps" || this.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - this.lastClientX;
    const deltaY = event.clientY - this.lastClientY;
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;

    if (this.pointerButton === 2) {
      this.panCamera(deltaX, deltaY);
      return;
    }

    this.rotateCamera(deltaX, deltaY);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) {
      return;
    }

    if (this.domElement.hasPointerCapture(event.pointerId)) {
      this.domElement.releasePointerCapture(event.pointerId);
    }

    this.pointerId = null;
    this.pointerButton = -1;
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (this.mode !== "fps" || document.activeElement !== this.domElement) {
      return;
    }

    if (!/^Key[WASDQE]$/.test(event.code)) {
      return;
    }

    event.preventDefault();
    this.keys.add(event.code);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (!/^Key[WASDQE]$/.test(event.code)) {
      return;
    }

    this.keys.delete(event.code);
  };
}

type TerrainEdgeMask = {
  north: boolean;
  south: boolean;
  east: boolean;
  west: boolean;
};

type TerrainLeaf = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  level: number;
  seams: TerrainEdgeMask;
};

type TerrainSettings = {
  size: number;
  segments: number;
  maxLevel: number;
  splitDistance: number;
  skirtDepth: number;
};

function sampleTerrainHeight(simplex: SimplexNoise, x: number, z: number): number {
  const broad = simplex.noise(x * 0.075, z * 0.075) * 2.6;
  const ridged = Math.abs(simplex.noise(x * 0.16 + 31, z * 0.16 - 19)) * 1.4;
  const medium = simplex.noise(x * 0.34 - 11, z * 0.34 + 17) * 0.65;
  const fine = simplex.noise(x * 0.9 + 7, z * 0.9 + 3) * 0.09;
  const radial = Math.max(0, 1 - Math.hypot(x, z) / 22) * 0.9;
  return broad - ridged + medium + fine + radial - 0.45;
}

function paintTerrainColor(height: number, colorTarget: THREE.Color): void {
  if (height < -0.18) {
    colorTarget.set("#1e547c");
    return;
  }

  if (height < 0.22) {
    colorTarget.set("#67945d");
    return;
  }

  if (height < 1.05) {
    colorTarget.set("#7ba56a");
    return;
  }

  if (height < 2.15) {
    colorTarget.set("#8c8168");
    return;
  }

  colorTarget.set("#d8dde5");
}

function sampleTerrainNormal(
  simplex: SimplexNoise,
  x: number,
  z: number,
  target: THREE.Vector3,
  sampleStep = 0.18,
): THREE.Vector3 {
  const left = sampleTerrainHeight(simplex, x - sampleStep, z);
  const right = sampleTerrainHeight(simplex, x + sampleStep, z);
  const back = sampleTerrainHeight(simplex, x, z - sampleStep);
  const front = sampleTerrainHeight(simplex, x, z + sampleStep);
  return target.set(left - right, sampleStep * 2, back - front).normalize();
}

function createTerrainLeaf(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  level: number,
): TerrainLeaf {
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    level,
    seams: { north: false, south: false, east: false, west: false },
  };
}

function splitTerrainLeaf(leaf: TerrainLeaf): TerrainLeaf[] {
  const midX = (leaf.minX + leaf.maxX) * 0.5;
  const midZ = (leaf.minZ + leaf.maxZ) * 0.5;
  const nextLevel = leaf.level + 1;

  return [
    createTerrainLeaf(leaf.minX, midX, leaf.minZ, midZ, nextLevel),
    createTerrainLeaf(midX, leaf.maxX, leaf.minZ, midZ, nextLevel),
    createTerrainLeaf(leaf.minX, midX, midZ, leaf.maxZ, nextLevel),
    createTerrainLeaf(midX, leaf.maxX, midZ, leaf.maxZ, nextLevel),
  ];
}

function buildTerrainLeaves(camera: THREE.Vector3, settings: TerrainSettings): TerrainLeaf[] {
  const root = createTerrainLeaf(
    -settings.size * 0.5,
    settings.size * 0.5,
    -settings.size * 0.5,
    settings.size * 0.5,
    0,
  );
  const leaves: TerrainLeaf[] = [];

  const traverse = (leaf: TerrainLeaf) => {
    const halfWidth = (leaf.maxX - leaf.minX) * 0.5;
    const halfDepth = (leaf.maxZ - leaf.minZ) * 0.5;
    const centerX = leaf.minX + halfWidth;
    const centerZ = leaf.minZ + halfDepth;
    const edgeDistance = Math.hypot(
      Math.max(Math.abs(camera.x - centerX) - halfWidth, 0),
      Math.max(Math.abs(camera.z - centerZ) - halfDepth, 0),
    );
    const shouldSplit = leaf.level < settings.maxLevel && edgeDistance < (leaf.maxX - leaf.minX) * settings.splitDistance;

    if (!shouldSplit) {
      leaves.push(leaf);
      return;
    }

    for (const child of splitTerrainLeaf(leaf)) {
      traverse(child);
    }
  };

  traverse(root);
  return balanceTerrainLeaves(leaves);
}

function balanceTerrainLeaves(initialLeaves: TerrainLeaf[]): TerrainLeaf[] {
  let leaves = [...initialLeaves];
  let changed = true;
  let guard = 0;

  while (changed && guard < 8) {
    changed = false;
    guard += 1;
    const nextLeaves: TerrainLeaf[] = [];

    for (const leaf of leaves) {
      const neighborLevels = getTerrainNeighborLevels(leaf, leaves);
      const maxNeighborLevel = Math.max(
        ...neighborLevels.north,
        ...neighborLevels.south,
        ...neighborLevels.east,
        ...neighborLevels.west,
      );

      if (maxNeighborLevel > leaf.level + 1) {
        nextLeaves.push(...splitTerrainLeaf(leaf));
        changed = true;
      } else {
        nextLeaves.push(leaf);
      }
    }

    leaves = nextLeaves;
  }

  for (const leaf of leaves) {
    const neighborLevels = getTerrainNeighborLevels(leaf, leaves);
    leaf.seams = {
      north: neighborLevels.north.some((level) => level < leaf.level),
      south: neighborLevels.south.some((level) => level < leaf.level),
      east: neighborLevels.east.some((level) => level < leaf.level),
      west: neighborLevels.west.some((level) => level < leaf.level),
    };
  }

  return leaves;
}

function getTerrainNeighborLevels(
  leaf: TerrainLeaf,
  leaves: TerrainLeaf[],
): Record<keyof TerrainEdgeMask, number[]> {
  const epsilon = 0.0001;
  const sampleRange = [0.2, 0.5, 0.8];
  const levels = {
    north: [] as number[],
    south: [] as number[],
    east: [] as number[],
    west: [] as number[],
  };

  for (const t of sampleRange) {
    levels.north.push(findTerrainLeafLevel(leaves, THREE.MathUtils.lerp(leaf.minX, leaf.maxX, t), leaf.maxZ + epsilon));
    levels.south.push(findTerrainLeafLevel(leaves, THREE.MathUtils.lerp(leaf.minX, leaf.maxX, t), leaf.minZ - epsilon));
    levels.east.push(findTerrainLeafLevel(leaves, leaf.maxX + epsilon, THREE.MathUtils.lerp(leaf.minZ, leaf.maxZ, t)));
    levels.west.push(findTerrainLeafLevel(leaves, leaf.minX - epsilon, THREE.MathUtils.lerp(leaf.minZ, leaf.maxZ, t)));
  }

  return levels;
}

function findTerrainLeafLevel(leaves: TerrainLeaf[], x: number, z: number): number {
  for (const leaf of leaves) {
    if (x >= leaf.minX && x <= leaf.maxX && z >= leaf.minZ && z <= leaf.maxZ) {
      return leaf.level;
    }
  }

  return -1;
}

function createTerrainPatchGeometry(
  simplex: SimplexNoise,
  leaf: TerrainLeaf,
  settings: TerrainSettings,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const surfaceColor = new THREE.Color();
  const surfaceNormal = new THREE.Vector3();
  const segments = settings.segments;
  const gridWidth = segments + 1;

  const indexAt = (ix: number, iz: number) => iz * gridWidth + ix;

  for (let iz = 0; iz <= segments; iz += 1) {
    const v = iz / segments;
    const z = THREE.MathUtils.lerp(leaf.minZ, leaf.maxZ, v);

    for (let ix = 0; ix <= segments; ix += 1) {
      const u = ix / segments;
      const x = THREE.MathUtils.lerp(leaf.minX, leaf.maxX, u);
      const y = sampleTerrainHeight(simplex, x, z);
      positions.push(x, y, z);
      paintTerrainColor(y, surfaceColor);
      colors.push(surfaceColor.r, surfaceColor.g, surfaceColor.b);
      sampleTerrainNormal(simplex, x, z, surfaceNormal);
      normals.push(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z);
    }
  }

  for (let iz = 0; iz < segments; iz += 1) {
    for (let ix = 0; ix < segments; ix += 1) {
      const a = indexAt(ix, iz);
      const b = indexAt(ix + 1, iz);
      const c = indexAt(ix, iz + 1);
      const d = indexAt(ix + 1, iz + 1);
      indices.push(a, c, b, b, c, d);
    }
  }

  const addSkirt = (edge: keyof TerrainEdgeMask) => {
    const topIndices: number[] = [];

    if (edge === "south") {
      for (let ix = 0; ix <= segments; ix += 1) {
        topIndices.push(indexAt(ix, 0));
      }
    } else if (edge === "north") {
      for (let ix = 0; ix <= segments; ix += 1) {
        topIndices.push(indexAt(ix, segments));
      }
    } else if (edge === "west") {
      for (let iz = 0; iz <= segments; iz += 1) {
        topIndices.push(indexAt(0, iz));
      }
    } else {
      for (let iz = 0; iz <= segments; iz += 1) {
        topIndices.push(indexAt(segments, iz));
      }
    }

    const skirtStart = positions.length / 3;

    for (const topIndex of topIndices) {
      const base = topIndex * 3;
      positions.push(positions[base], positions[base + 1] - settings.skirtDepth, positions[base + 2]);
      colors.push(colors[base], colors[base + 1], colors[base + 2]);
      normals.push(normals[base], normals[base + 1], normals[base + 2]);
    }

    for (let index = 0; index < topIndices.length - 1; index += 1) {
      const topA = topIndices[index];
      const topB = topIndices[index + 1];
      const skirtA = skirtStart + index;
      const skirtB = skirtStart + index + 1;
      indices.push(topA, topB, skirtA, topB, skirtB, skirtA);
    }
  };

  if (leaf.seams.south) {
    addSkirt("south");
  }
  if (leaf.seams.north) {
    addSkirt("north");
  }
  if (leaf.seams.west) {
    addSkirt("west");
  }
  if (leaf.seams.east) {
    addSkirt("east");
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

function createTerrainBounds(leaf: TerrainLeaf): THREE.Line {
  const points = [
    new THREE.Vector3(leaf.minX, 0.12 + leaf.level * 0.02, leaf.minZ),
    new THREE.Vector3(leaf.maxX, 0.12 + leaf.level * 0.02, leaf.minZ),
    new THREE.Vector3(leaf.maxX, 0.12 + leaf.level * 0.02, leaf.maxZ),
    new THREE.Vector3(leaf.minX, 0.12 + leaf.level * 0.02, leaf.maxZ),
    new THREE.Vector3(leaf.minX, 0.12 + leaf.level * 0.02, leaf.minZ),
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: leaf.level >= 4 ? "#ffe29f" : "#77d8ff",
    transparent: true,
    opacity: 0.72,
  });
  return new THREE.Line(geometry, material);
}

const examples: ExampleDefinition[] = [
  {
    step: "Step 01",
    title: "Triangle",
    summary: "Start from raw positions and vertex colors so the scene graph stays out of the way.",
    notes:
      "Each corner is pure red, green, or blue so you can see barycentric color interpolation directly across the face of the triangle.",
    tags: ["BufferGeometry", "Vertex colors", "Camera basics"],
    cameraPosition: [0.5, 0.4, 2.2],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#08131f");

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          [-0.9, -0.65, 0, 0.9, -0.65, 0, 0, 0.9, 0],
          3,
        ),
      );
      geometry.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(
          [1, 0, 0, 0, 1, 0, 0, 0, 1],
          3,
        ),
      );

      const material = new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        vertexColors: true,
      });
      const mesh = new THREE.Mesh(geometry, material);

      const outlineGeometry = new THREE.EdgesGeometry(geometry);
      const outline = new THREE.LineSegments(
        outlineGeometry,
        new THREE.LineBasicMaterial({ color: "#f6fbff" }),
      );
      outline.position.z = 0.001;

      const group = new THREE.Group();
      group.add(mesh, outline);
      scene.add(group);

      return {
        update: (elapsed) => {
          group.rotation.y = elapsed * 0.45;
          group.rotation.x = Math.sin(elapsed * 0.7) * 0.18;
        },
        dispose: () => {
          geometry.dispose();
          material.dispose();
          outlineGeometry.dispose();
          (outline.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 02",
    title: "Indexed Geometry",
    summary: "Move from three handmade vertices to reusable primitives with normals and indexed faces.",
    notes:
      "This is where the mental model broadens: instead of pushing every triangle yourself, you start leaning on geometry generators and the attributes they provide.",
    tags: ["BoxGeometry", "Normals", "Wireframe"],
    cameraPosition: [3.2, 2.6, 4.2],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#081521");

      const solid = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 1.8, 1.8, 4, 4, 4),
        new THREE.MeshNormalMaterial(),
      );

      const wireframe = new THREE.LineSegments(
        new THREE.WireframeGeometry(solid.geometry),
        new THREE.LineBasicMaterial({ color: "#dff6ff" }),
      );
      wireframe.scale.setScalar(1.005);

      const group = new THREE.Group();
      group.add(solid, wireframe);
      scene.add(group);

      return {
        update: (elapsed) => {
          group.rotation.x = elapsed * 0.45;
          group.rotation.y = elapsed * 0.62;
        },
        dispose: () => {
          solid.geometry.dispose();
          (solid.material as THREE.Material).dispose();
          wireframe.geometry.dispose();
          (wireframe.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 03",
    title: "UVs & Textures",
    summary: "Introduce material maps so the same geometry can carry more detail than a flat color.",
    notes:
      "The texture here is generated in code, which keeps the demo self-contained while still showing what UV coordinates do across different surfaces.",
    tags: ["CanvasTexture", "UVs", "Material maps"],
    cameraPosition: [4.6, 2.8, 5.4],
    target: [0, 0.6, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#091523");

      const ambient = new THREE.AmbientLight("#84b8ff", 0.65);
      const key = new THREE.DirectionalLight("#ffffff", 1.45);
      key.position.set(5, 6, 3);
      scene.add(ambient, key);

      const texture = createUvReferenceTexture();

      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 1.7, 1.7),
        new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.55,
          metalness: 0.08,
        }),
      );
      cube.position.set(-1.2, 1, 0);

      const torus = new THREE.Mesh(
        new THREE.TorusGeometry(1.05, 0.3, 24, 72),
        new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.4,
          metalness: 0.12,
        }),
      );
      torus.position.set(1.5, 1, 0);

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(12, 12),
        new THREE.MeshStandardMaterial({
          color: "#0f2434",
          roughness: 0.96,
          metalness: 0.02,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      scene.add(floor, cube, torus);

      return {
        update: (elapsed) => {
          cube.rotation.x = elapsed * 0.35;
          cube.rotation.y = elapsed * 0.55;
          torus.rotation.x = Math.sin(elapsed * 0.4) * 0.4;
          torus.rotation.y = -elapsed * 0.75;
        },
        dispose: () => {
          cube.geometry.dispose();
          (cube.material as THREE.Material).dispose();
          torus.geometry.dispose();
          (torus.material as THREE.Material).dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          texture.dispose();
        },
      };
    },
  },
  {
    step: "Step 04",
    title: "Lighting Fundamentals",
    summary: "Start with a compact PBR setup so you can see how a few common lights sculpt the same materials.",
    notes:
      "This is the first place roughness, metalness, specular highlights, and shadows start talking to each other. Use the IMGUI to solo the major contributors.",
    tags: ["MeshStandardMaterial", "Shadows", "PBR lighting"],
    cameraPosition: [5.5, 3.2, 6.5],
    target: [0, 1, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#091523");

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(16, 16),
        new THREE.MeshStandardMaterial({
          color: "#13273a",
          roughness: 0.94,
          metalness: 0.04,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      scene.add(floor);

      const knot = new THREE.Mesh(
        new THREE.TorusKnotGeometry(1.05, 0.34, 168, 24),
        new THREE.MeshStandardMaterial({
          color: "#69d8ff",
          roughness: 0.22,
          metalness: 0.55,
        }),
      );
      knot.castShadow = true;
      knot.position.set(-1.15, 1.7, 0);

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.95, 48, 32),
        new THREE.MeshStandardMaterial({
          color: "#ffb15f",
          roughness: 0.58,
          metalness: 0.12,
        }),
      );
      sphere.castShadow = true;
      sphere.position.set(1.55, 1.1, -0.4);

      const ambient = new THREE.AmbientLight("#8ab8ff", 0.35);
      const hemi = new THREE.HemisphereLight("#82b1ff", "#08111d", 0.8);
      const sun = new THREE.DirectionalLight("#ffffff", 1.8);
      sun.position.set(4.5, 6.5, 2.5);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);

      const point = new THREE.PointLight("#ff8f6a", 35, 16, 2);
      point.castShadow = true;

      const pointMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 16, 16),
        new THREE.MeshBasicMaterial({ color: "#ffd4ba" }),
      );
      point.add(pointMesh);

      const pointRig = new THREE.Group();
      pointRig.add(point);
      point.position.set(2.2, 2.5, 0);

      scene.add(ambient, hemi, sun, pointRig, knot, sphere);

      const controlsState = {
        ambient: ambient.intensity,
        hemisphere: hemi.intensity,
        sun: sun.intensity,
        point: point.intensity,
        animate: true,
      };

      return {
        update: (elapsed) => {
          if (!controlsState.animate) {
            return;
          }

          knot.rotation.x = elapsed * 0.4;
          knot.rotation.y = elapsed * 0.65;
          sphere.position.y = 1.1 + Math.sin(elapsed * 1.2) * 0.18;
          pointRig.rotation.y = elapsed * 0.8;
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Lighting");
          folder
            .add(controlsState, "ambient", 0, 1.5, 0.01)
            .name("ambient")
            .onChange((value: number) => {
              ambient.intensity = value;
            });
          folder
            .add(controlsState, "hemisphere", 0, 2, 0.01)
            .name("hemisphere")
            .onChange((value: number) => {
              hemi.intensity = value;
            });
          folder
            .add(controlsState, "sun", 0, 4, 0.01)
            .name("directional")
            .onChange((value: number) => {
              sun.intensity = value;
            });
          folder
            .add(controlsState, "point", 0, 60, 0.1)
            .name("point")
            .onChange((value: number) => {
              point.intensity = value;
            });
          folder.add(controlsState, "animate").name("animate");
        },
        dispose: () => {
          disposeSceneResources([floor, knot, sphere, pointMesh]);
        },
      };
    },
  },
  {
    step: "Step 04B",
    title: "Light Types Studio",
    summary: "Layer ambient, hemisphere, directional, point, and spot lights so you can feel what each one adds.",
    notes:
      "This is the comparison lab. Toggle lights individually, turn on helpers, and watch how some lights fill globally while others create direction, falloff, and theatrical focus.",
    tags: ["AmbientLight", "SpotLight", "Helpers"],
    cameraPosition: [8.2, 4.5, 7.4],
    target: [0, 1.4, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#09111c");

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(7.6, 72),
        new THREE.MeshStandardMaterial({
          color: "#112334",
          roughness: 0.96,
          metalness: 0.02,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;

      const pedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(2.4, 2.8, 0.7, 40),
        new THREE.MeshStandardMaterial({
          color: "#173042",
          roughness: 0.92,
          metalness: 0.05,
        }),
      );
      pedestal.position.y = 0.35;
      pedestal.receiveShadow = true;
      pedestal.castShadow = true;

      const heroGroup = new THREE.Group();
      const knot = new THREE.Mesh(
        new THREE.TorusKnotGeometry(0.86, 0.28, 168, 24),
        new THREE.MeshStandardMaterial({
          color: "#84e0ff",
          roughness: 0.18,
          metalness: 0.62,
        }),
      );
      knot.position.set(-1.2, 1.95, 0.2);
      knot.castShadow = true;

      const matteSphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.8, 48, 32),
        new THREE.MeshStandardMaterial({
          color: "#ffb66c",
          roughness: 0.84,
          metalness: 0.04,
        }),
      );
      matteSphere.position.set(1.4, 1.45, -0.25);
      matteSphere.castShadow = true;

      const glossyBox = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 1.1, 1.1, 4, 4, 4),
        new THREE.MeshStandardMaterial({
          color: "#dce9ff",
          roughness: 0.24,
          metalness: 0.14,
        }),
      );
      glossyBox.position.set(0.15, 1.1, 1.45);
      glossyBox.castShadow = true;

      heroGroup.add(knot, matteSphere, glossyBox);

      const ambient = new THREE.AmbientLight("#8eb9ff", 0.25);
      const hemi = new THREE.HemisphereLight("#8ac8ff", "#070e17", 0.68);
      const directional = new THREE.DirectionalLight("#fff5db", 1.5);
      directional.position.set(4.8, 5.8, 3.2);
      directional.castShadow = true;
      directional.shadow.mapSize.set(1024, 1024);
      directional.shadow.camera.left = -5;
      directional.shadow.camera.right = 5;
      directional.shadow.camera.top = 5;
      directional.shadow.camera.bottom = -5;

      const point = new THREE.PointLight("#ff8c6c", 22, 14, 2);
      point.position.set(0, 2.7, 0);
      point.castShadow = true;

      const pointOrb = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 18, 18),
        new THREE.MeshBasicMaterial({ color: "#ffd0c0" }),
      );
      point.add(pointOrb);

      const spot = new THREE.SpotLight("#7ad6ff", 26, 18, Math.PI / 7, 0.36, 1.2);
      spot.position.set(-4.8, 5.8, 4.4);
      const spotlightTarget = new THREE.Object3D();
      spotlightTarget.position.set(0, 1.55, 0);
      spot.target = spotlightTarget;
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);

      const ambientHelper = new THREE.HemisphereLightHelper(hemi, 0.65);
      const directionalHelper = new THREE.DirectionalLightHelper(directional, 0.85, "#ffe2ba");
      const pointHelper = new THREE.PointLightHelper(point, 0.34, "#ffbba5");
      const spotHelper = new THREE.SpotLightHelper(spot, "#89ddff");
      ambientHelper.visible = false;
      directionalHelper.visible = false;
      pointHelper.visible = false;
      spotHelper.visible = false;

      const pointRig = new THREE.Group();
      pointRig.add(point);
      point.position.set(2.8, 2.8, 0);

      scene.add(
        floor,
        pedestal,
        heroGroup,
        ambient,
        hemi,
        directional,
        pointRig,
        spot,
        spotlightTarget,
        ambientHelper,
        directionalHelper,
        pointHelper,
        spotHelper,
      );

      const state = {
        ambient: true,
        hemisphere: true,
        directional: true,
        point: true,
        spot: true,
        showHelpers: false,
        rotateDisplay: true,
      };

      const syncLighting = () => {
        ambient.visible = state.ambient;
        hemi.visible = state.hemisphere;
        directional.visible = state.directional;
        point.visible = state.point;
        spot.visible = state.spot;
        ambientHelper.visible = state.showHelpers && state.hemisphere;
        directionalHelper.visible = state.showHelpers && state.directional;
        pointHelper.visible = state.showHelpers && state.point;
        spotHelper.visible = state.showHelpers && state.spot;
      };

      syncLighting();

      return {
        update: (elapsed) => {
          if (state.rotateDisplay) {
            heroGroup.rotation.y = elapsed * 0.22;
          }

          knot.rotation.x = elapsed * 0.38;
          knot.rotation.y = elapsed * 0.66;
          glossyBox.rotation.y = -elapsed * 0.48;
          pointRig.rotation.y = elapsed * 0.58;
          point.position.y = 2.35 + Math.sin(elapsed * 1.3) * 0.55;
          spot.position.x = Math.cos(elapsed * 0.36) * 5.2;
          spot.position.z = Math.sin(elapsed * 0.36) * 5.2;
          ambientHelper.update();
          directionalHelper.update();
          pointHelper.update();
          spotHelper.update();
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Light types");
          folder.add(state, "ambient").name("ambient").onChange(syncLighting);
          folder.add(state, "hemisphere").name("hemisphere").onChange(syncLighting);
          folder.add(state, "directional").name("directional").onChange(syncLighting);
          folder.add(state, "point").name("point").onChange(syncLighting);
          folder.add(state, "spot").name("spot").onChange(syncLighting);
          folder.add(state, "showHelpers").name("helpers").onChange(syncLighting);
          folder.add(state, "rotateDisplay").name("turntable");
        },
        dispose: () => {
          disposeSceneResources([
            floor,
            pedestal,
            knot,
            matteSphere,
            glossyBox,
            pointOrb,
            ambientHelper,
            directionalHelper,
            pointHelper,
            spotHelper,
            spotlightTarget,
          ]);
        },
      };
    },
  },
  {
    step: "Step 04C",
    title: "Shadow Playground",
    summary: "Compare shadow casters, shadow map filters, helper frusta, and bias settings in one controllable scene.",
    notes:
      "Shadows are where a lot of real-time rendering pain hides. This card is intentionally a little fussy so you can see acne, peter-panning, softening, and light-specific tradeoffs in context.",
    tags: ["Directional shadow", "Spot shadow", "Shadow bias"],
    cameraPosition: [8.6, 5.1, 8.1],
    target: [0, 1.6, 0],
    create: ({ scene, renderer }) => {
      scene.background = new THREE.Color("#080f19");

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(18, 18),
        new THREE.MeshStandardMaterial({
          color: "#0f2130",
          roughness: 0.98,
          metalness: 0.02,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;

      const stage = new THREE.Group();

      for (let index = 0; index < 7; index += 1) {
        const columnHeight = 1.4 + index * 0.18;
        const column = new THREE.Mesh(
          new THREE.BoxGeometry(0.7, columnHeight, 0.7),
          new THREE.MeshStandardMaterial({
            color: index % 2 === 0 ? "#5f95bf" : "#d8e5f8",
            roughness: 0.55,
            metalness: 0.08,
          }),
        );
        const angle = index / 7 * Math.PI * 2;
        column.position.set(Math.cos(angle) * 3.15, columnHeight * 0.5, Math.sin(angle) * 3.15);
        column.castShadow = true;
        column.receiveShadow = true;
        stage.add(column);
      }

      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(1.85, 0.24, 18, 72, Math.PI),
        new THREE.MeshStandardMaterial({
          color: "#78d8ff",
          roughness: 0.18,
          metalness: 0.52,
        }),
      );
      arch.rotation.z = Math.PI;
      arch.position.set(0, 2.55, 0);
      arch.castShadow = true;
      stage.add(arch);

      const centerpiece = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.92, 2),
        new THREE.MeshStandardMaterial({
          color: "#ffba75",
          roughness: 0.32,
          metalness: 0.08,
        }),
      );
      centerpiece.position.y = 1.55;
      centerpiece.castShadow = true;
      stage.add(centerpiece);

      const ambient = new THREE.AmbientLight("#8fb5ff", 0.18);
      const hemi = new THREE.HemisphereLight("#8cc1ff", "#060d16", 0.38);

      const sun = new THREE.DirectionalLight("#fff4dc", 1.45);
      sun.position.set(4.8, 7.4, 3.8);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.left = -6;
      sun.shadow.camera.right = 6;
      sun.shadow.camera.top = 6;
      sun.shadow.camera.bottom = -6;
      sun.shadow.normalBias = 0.18;

      const spot = new THREE.SpotLight("#88dbff", 24, 20, Math.PI / 6, 0.28, 1.1);
      spot.position.set(-5.4, 7.1, 4.2);
      const spotlightTarget = new THREE.Object3D();
      spotlightTarget.position.set(0, 1.6, 0);
      spot.target = spotlightTarget;
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.normalBias = 0.18;

      const lantern = new THREE.PointLight("#ff9267", 45, 15, 2);
      lantern.position.set(0, 3.8, 0);
      lantern.castShadow = true;
      lantern.shadow.mapSize.set(1024, 1024);
      lantern.shadow.normalBias = 0.18;

      const lanternOrb = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 20, 20),
        new THREE.MeshBasicMaterial({ color: "#ffd6c6" }),
      );
      lantern.add(lanternOrb);

      const sunCameraHelper = new THREE.CameraHelper(sun.shadow.camera);
      const spotCameraHelper = new THREE.CameraHelper(spot.shadow.camera);
      const spotHelper = new THREE.SpotLightHelper(spot, "#97e2ff");
      const pointHelper = new THREE.PointLightHelper(lantern, 0.42, "#ffc7a4");

      scene.add(
        floor,
        stage,
        ambient,
        hemi,
        sun,
        spot,
        spotlightTarget,
        lantern,
        sunCameraHelper,
        spotCameraHelper,
        spotHelper,
        pointHelper,
      );

      const shadowState = {
        caster: "all",
        shadowType: "PCF Soft",
        showHelpers: false,
        animate: true,
        bias: 0,
        normalBias: 0.18,
      };

      const applyShadowCasterMode = () => {
        sun.castShadow = shadowState.caster === "all" || shadowState.caster === "sun";
        spot.castShadow = shadowState.caster === "all" || shadowState.caster === "spot";
        lantern.castShadow = shadowState.caster === "all" || shadowState.caster === "point";
      };

      const applyShadowType = () => {
        const typeMap = {
          Basic: THREE.BasicShadowMap,
          PCF: THREE.PCFShadowMap,
          "PCF Soft": THREE.PCFSoftShadowMap,
          VSM: THREE.VSMShadowMap,
        } as const;

        renderer.shadowMap.type = typeMap[shadowState.shadowType as keyof typeof typeMap];
        (renderer.shadowMap as { needsUpdate?: boolean }).needsUpdate = true;
      };

      const applyBias = () => {
        sun.shadow.bias = shadowState.bias;
        spot.shadow.bias = shadowState.bias;
        lantern.shadow.bias = shadowState.bias;
        sun.shadow.normalBias = shadowState.normalBias;
        spot.shadow.normalBias = shadowState.normalBias;
        lantern.shadow.normalBias = shadowState.normalBias;
      };

      const syncHelpers = () => {
        sunCameraHelper.visible = shadowState.showHelpers;
        spotCameraHelper.visible = shadowState.showHelpers;
        spotHelper.visible = shadowState.showHelpers;
        pointHelper.visible = shadowState.showHelpers;
      };

      applyShadowCasterMode();
      applyShadowType();
      applyBias();
      syncHelpers();

      return {
        update: (elapsed) => {
          if (shadowState.animate) {
            stage.rotation.y = elapsed * 0.18;
            centerpiece.rotation.x = elapsed * 0.58;
            centerpiece.rotation.y = elapsed * 0.86;
            spotlightTarget.position.copy(centerpiece.position);
            lantern.position.x = Math.cos(elapsed * 0.72) * 3.4;
            lantern.position.z = Math.sin(elapsed * 0.72) * 3.4;
            lantern.position.y = 3.5 + Math.sin(elapsed * 1.4) * 0.42;
            spot.position.x = Math.cos(elapsed * 0.28 + 1.2) * 5.8;
            spot.position.z = Math.sin(elapsed * 0.28 + 1.2) * 5.8;
            sun.position.x = Math.cos(elapsed * 0.16) * 6.2;
            sun.position.z = Math.sin(elapsed * 0.16) * 4.8;
          }

          sunCameraHelper.update();
          spotCameraHelper.update();
          spotHelper.update();
          pointHelper.update();
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Shadows");
          folder
            .add(shadowState, "caster", {
              All: "all",
              Directional: "sun",
              Spot: "spot",
              Point: "point",
            })
            .name("shadow caster")
            .onChange(applyShadowCasterMode);
          folder
            .add(shadowState, "shadowType", {
              Basic: "Basic",
              PCF: "PCF",
              "PCF Soft": "PCF Soft",
              VSM: "VSM",
            })
            .name("shadow filter")
            .onChange(applyShadowType);
          folder
            .add(shadowState, "bias", -0.01, 0.01, 0.0001)
            .name("bias")
            .onChange(applyBias);
          folder
            .add(shadowState, "normalBias", 0, 1, 0.01)
            .name("normal bias")
            .onChange(applyBias);
          folder.add(shadowState, "showHelpers").name("helpers").onChange(syncHelpers);
          folder.add(shadowState, "animate").name("animate");
        },
        dispose: () => {
          disposeSceneResources([
            floor,
            lanternOrb,
            spotlightTarget,
            sunCameraHelper,
            spotCameraHelper,
            spotHelper,
            pointHelper,
            ...stage.children,
          ]);
        },
      };
    },
  },
  {
    step: "Step 04D",
    title: "PBR Lookdev Board",
    summary: "Lay out a full material-ball board so roughness, metalness, transmission, and shader-authored surfaces can be compared under one studio rig.",
    notes:
      "This is the kind of scene you use to judge whether a shader is actually good. The rows sweep dielectrics, metals, clearcoat, transmission, and custom node-driven looks while sharing the same environment and lights.",
    tags: ["MeshPhysicalMaterial", "PMREM", "MeshPhysicalNodeMaterial"],
    cameraPosition: [-1.8, 5.4, 12.2],
    target: [0, 1.1, -0.2],
    create: ({ scene, renderer }) => {
      scene.background = new THREE.Color("#c6cdd7");
      scene.fog = new THREE.Fog("#c6cdd7", 18, 34);
      renderer.toneMappingExposure = 0.95;
      const lookdevFloorTexture = createLookdevFloorTexture();
      lookdevFloorTexture.repeat.set(3.5, 2.5);

      const studioState = {
        envIntensity: 0.62,
        exposure: 0.95,
        keyIntensity: 1.18,
        fillIntensity: 0.1,
        rimIntensity: 0.62,
        accentIntensity: 8,
        animateLights: false,
        showProps: true,
        metals: true,
        dielectrics: true,
        clearcoat: true,
        transmission: true,
        shaders: true,
      };

      const roomEnvironment = new RoomEnvironment();
      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      const environmentTarget = pmremGenerator.fromScene(roomEnvironment, 0.03);
      scene.environment = environmentTarget.texture;

      const trackedMaterials: Array<THREE.Material & { envMapIntensity?: number }> = [];
      const registerMaterial = <T extends THREE.Material & { envMapIntensity?: number }>(material: T): T => {
        if ("envMapIntensity" in material) {
          material.envMapIntensity = studioState.envIntensity;
        }

        trackedMaterials.push(material);
        return material;
      };

      const createPhysicalMaterial = (parameters: THREE.MeshPhysicalMaterialParameters) =>
        registerMaterial(new THREE.MeshPhysicalMaterial(parameters));

      const createNodePhysicalMaterial = (configure: (material: THREE.MeshPhysicalNodeMaterial) => void) => {
        const material = registerMaterial(new THREE.MeshPhysicalNodeMaterial());
        configure(material);
        return material;
      };

      const stage = new THREE.Mesh(
        new THREE.BoxGeometry(15.4, 0.34, 10.6),
        createPhysicalMaterial({
          color: "#4f5867",
          roughness: 0.88,
          metalness: 0.03,
          clearcoat: 0.1,
          clearcoatRoughness: 0.48,
        }),
      );
      stage.position.y = -0.2;
      stage.receiveShadow = true;

      const stageTop = new THREE.Mesh(
        new THREE.PlaneGeometry(14.9, 10.1),
        createPhysicalMaterial({
          color: "#b7c0cb",
          map: lookdevFloorTexture,
          roughness: 0.94,
          metalness: 0.02,
          clearcoat: 0.02,
          clearcoatRoughness: 0.56,
        }),
      );
      stageTop.rotation.x = -Math.PI / 2;
      stageTop.position.y = -0.02;
      stageTop.receiveShadow = true;

      const key = new THREE.DirectionalLight("#fff7ec", studioState.keyIntensity);
      key.position.set(5.8, 8.4, 4.6);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -9;
      key.shadow.camera.right = 9;
      key.shadow.camera.top = 9;
      key.shadow.camera.bottom = -9;
      key.shadow.normalBias = 0.18;

      const shadowSpot = new THREE.SpotLight("#fff4dc", studioState.keyIntensity * 7.5, 28, Math.PI / 5, 0.34, 1.1);
      shadowSpot.position.set(0.8, 9.8, 4.2);
      shadowSpot.target = stageTop;
      shadowSpot.castShadow = true;
      shadowSpot.shadow.mapSize.set(2048, 2048);
      shadowSpot.shadow.bias = -0.00015;
      shadowSpot.shadow.normalBias = 0.12;

      const fill = new THREE.HemisphereLight("#c1d9ff", "#66758f", studioState.fillIntensity);
      const rim = new THREE.DirectionalLight("#c7d7ff", studioState.rimIntensity);
      rim.position.set(-6.2, 5.3, -3.8);

      const accentRig = new THREE.Group();
      const accent = new THREE.PointLight("#ffd9b7", studioState.accentIntensity, 18, 2);
      accent.position.set(0, 4.2, 2.6);
      const accentMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 16, 16),
        new THREE.MeshBasicMaterial({ color: "#fff0d9" }),
      );
      accent.add(accentMarker);
      accentRig.add(accent);

      scene.add(stage, stageTop, key, shadowSpot, fill, rim, accentRig);

      const sphereGeometry = new THREE.SphereGeometry(0.56, 48, 32);
      const capsuleGeometry = new THREE.CapsuleGeometry(0.34, 1.24, 6, 18);
      const rowSpacing = 1.72;
      const columnSpacing = 1.92;
      const columns = 6;
      const lastColumn = Math.max(columns - 1, 1);

      const shaderFactories = [
        () =>
          createNodePhysicalMaterial((material) => {
            const brushed = sin(positionLocal.y.mul(76).add(positionLocal.x.mul(12))).mul(0.5).add(0.5);
            material.metalness = 1;
            material.roughness = 0.18;
            material.colorNode = mix(color("#1b2430"), color("#dce8ff"), brushed);
            material.roughnessNode = brushed.mul(0.07).add(0.11);
            material.metalnessNode = brushed.mul(0.2).add(0.8);
          }),
        () =>
          createNodePhysicalMaterial((material) => {
            const wave = sin(positionLocal.x.mul(14).add(cos(positionLocal.z.mul(18)).mul(4))).mul(0.5).add(0.5);
            material.roughness = 0.24;
            material.metalness = 0.04;
            material.clearcoat = 1;
            material.clearcoatRoughness = 0.04;
            material.colorNode = mix(color("#2f4fa8"), color("#94b6ff"), wave);
            material.clearcoatNode = wave.mul(0.35).add(0.65);
          }),
        () =>
          createNodePhysicalMaterial((material) => {
            const cloud = sin(positionLocal.x.mul(10).add(positionLocal.z.mul(16)).add(cos(positionLocal.y.mul(18)).mul(3)))
              .mul(0.5)
              .add(0.5);
            material.roughness = 0.62;
            material.metalness = 0.02;
            material.colorNode = mix(color("#5d4633"), color("#b38764"), cloud);
            material.roughnessNode = cloud.mul(0.22).add(0.48);
          }),
        () =>
          createNodePhysicalMaterial((material) => {
            const pearl = normalLocal.y.mul(0.5).add(0.5);
            const swirl = sin(positionLocal.x.mul(24).sub(positionLocal.z.mul(18))).mul(0.5).add(0.5);
            material.roughness = 0.16;
            material.metalness = 0.02;
            material.iridescence = 1;
            material.iridescenceIOR = 1.32;
            material.iridescenceThicknessRange = [120, 620];
            material.colorNode = mix(color("#6176d4"), color("#eef3ff"), pearl);
            material.iridescenceNode = swirl.mul(0.5).add(0.5);
          }),
        () =>
          createNodePhysicalMaterial((material) => {
            const cross = sin(positionLocal.x.mul(42)).mul(sin(positionLocal.z.mul(42))).mul(0.5).add(0.5);
            material.roughness = 0.32;
            material.metalness = 0.78;
            material.colorNode = mix(color("#20242d"), color("#8f98a6"), cross);
            material.roughnessNode = cross.mul(0.14).add(0.18);
            material.metalnessNode = cross.mul(0.18).add(0.72);
          }),
        () =>
          createNodePhysicalMaterial((material) => {
            const cells = sin(positionLocal.x.mul(20).add(cos(positionLocal.y.mul(30)).mul(5)).add(positionLocal.z.mul(12)))
              .mul(0.5)
              .add(0.5);
            material.roughness = 0.52;
            material.metalness = 0.06;
            material.clearcoat = 1;
            material.clearcoatRoughness = 0.08;
            material.colorNode = mix(color("#295235"), color("#7cae6f"), cells);
            material.roughnessNode = cells.mul(0.12).add(0.42);
          }),
      ];

      const rowDefinitions = [
        {
          key: "metals",
          materialAt: (column: number) => {
            const t = column / lastColumn;
            return createPhysicalMaterial({
              color: new THREE.Color().setHSL(0.08 + t * 0.04, 0.26, 0.48),
              metalness: 1,
              roughness: 0.06 + t * 0.9,
            });
          },
        },
        {
          key: "dielectrics",
          materialAt: (column: number) => {
            const palette = ["#7f8ca2", "#9a745d", "#60749c", "#5d6f5d", "#9d9d95", "#845149"];
            const t = column / lastColumn;
            return createPhysicalMaterial({
              color: palette[column % palette.length],
              metalness: 0,
              roughness: 0.1 + t * 0.84,
            });
          },
        },
        {
          key: "clearcoat",
          materialAt: (column: number) => {
            const palette = ["#243d7a", "#4f74d8", "#6fa8ff", "#86643f", "#2b6a65", "#8a2f3d"];
            const t = column / lastColumn;
            return createPhysicalMaterial({
              color: palette[column % palette.length],
              metalness: 0.08,
              roughness: 0.35,
              clearcoat: 1,
              clearcoatRoughness: 0.02 + t * 0.42,
            });
          },
        },
        {
          key: "transmission",
          materialAt: (column: number) => {
            const palette = ["#a7bdd7", "#a5cdd6", "#d7bf9f", "#cfbde6", "#add8bf", "#d8aeb0"];
            const t = column / lastColumn;
            return createPhysicalMaterial({
              color: palette[column % palette.length],
              roughness: 0.02 + t * 0.18,
              metalness: 0,
              transmission: 1,
              thickness: 0.8 + t * 0.8,
              ior: 1.08 + t * 0.7,
              attenuationDistance: 1.8,
              attenuationColor: new THREE.Color(palette[column % palette.length]).multiplyScalar(0.6),
            });
          },
        },
        {
          key: "shaders",
          materialAt: (column: number) => shaderFactories[column](),
        },
      ] as const;

      const rowGroups: Record<string, THREE.Group> = {};

      rowDefinitions.forEach((row, rowIndex) => {
        const group = new THREE.Group();
        rowGroups[row.key] = group;
        group.position.z = (rowIndex - (rowDefinitions.length - 1) / 2) * rowSpacing;

        for (let column = 0; column < columns; column += 1) {
          const mesh = new THREE.Mesh(sphereGeometry, row.materialAt(column));
          mesh.position.set(
            (column - (columns - 1) / 2) * columnSpacing,
            0.56,
            (column % 2 === 0 ? 0.08 : -0.08) + Math.sin(column * 0.6 + rowIndex * 0.4) * 0.04,
          );
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
        }

        scene.add(group);
      });

      const props = new THREE.Group();
      const propMaterials = [
        createPhysicalMaterial({
          color: "#aebdd8",
          metalness: 1,
          roughness: 0.18,
        }),
        createPhysicalMaterial({
          color: "#d6d9e4",
          roughness: 0.08,
          transmission: 1,
          thickness: 1.3,
          ior: 1.3,
        }),
        createPhysicalMaterial({
          color: "#627a5f",
          roughness: 0.74,
          metalness: 0.02,
          clearcoat: 0.35,
        }),
        createPhysicalMaterial({
          color: "#927660",
          roughness: 0.46,
          metalness: 0.12,
        }),
      ];

      const propLayout = [
        [-5.7, 0.94, -4.45],
        [-1.9, 0.94, -4.7],
        [2.1, 0.94, -4.55],
        [5.4, 0.94, -4.35],
      ];

      propLayout.forEach(([x, y, z], index) => {
        const prop = new THREE.Mesh(capsuleGeometry, propMaterials[index % propMaterials.length]);
        prop.position.set(x, y, z);
        prop.rotation.z = Math.PI / 2;
        prop.rotation.y = index * 0.35 + 0.25;
        prop.castShadow = true;
        prop.receiveShadow = true;
        props.add(prop);
      });

      scene.add(props);

      const syncLookdev = () => {
        renderer.toneMappingExposure = studioState.exposure;
        key.intensity = studioState.keyIntensity;
        shadowSpot.intensity = studioState.keyIntensity * 7.5;
        fill.intensity = studioState.fillIntensity;
        rim.intensity = studioState.rimIntensity;
        accent.intensity = studioState.accentIntensity;

        for (const material of trackedMaterials) {
          if ("envMapIntensity" in material) {
            material.envMapIntensity = studioState.envIntensity;
          }
        }
      };

      const syncVisibility = () => {
        rowGroups.metals.visible = studioState.metals;
        rowGroups.dielectrics.visible = studioState.dielectrics;
        rowGroups.clearcoat.visible = studioState.clearcoat;
        rowGroups.transmission.visible = studioState.transmission;
        rowGroups.shaders.visible = studioState.shaders;
        props.visible = studioState.showProps;
      };

      syncLookdev();
      syncVisibility();

      return {
        update: (elapsed) => {
          if (!studioState.animateLights) {
            return;
          }

          accentRig.rotation.y = elapsed * 0.2;
          accent.position.y = 3.7 + Math.sin(elapsed * 1.1) * 0.6;
          key.position.x = Math.cos(elapsed * 0.18) * 6.4;
          key.position.z = Math.sin(elapsed * 0.18) * 5.2;
        },
        setupGui: ({ gui }) => {
          const lookdevFolder = gui.addFolder("PBR lab");
          lookdevFolder
            .add(studioState, "envIntensity", 0, 2.8, 0.05)
            .name("env intensity")
            .onChange(syncLookdev);
          lookdevFolder
            .add(studioState, "exposure", 0.8, 1.9, 0.01)
            .name("exposure")
            .onChange(syncLookdev);
          lookdevFolder
            .add(studioState, "keyIntensity", 0, 3.5, 0.01)
            .name("key")
            .onChange(syncLookdev);
          lookdevFolder
            .add(studioState, "fillIntensity", 0, 1.5, 0.01)
            .name("fill")
            .onChange(syncLookdev);
          lookdevFolder
            .add(studioState, "rimIntensity", 0, 2.5, 0.01)
            .name("rim")
            .onChange(syncLookdev);
          lookdevFolder
            .add(studioState, "accentIntensity", 0, 40, 0.25)
            .name("accent")
            .onChange(syncLookdev);
          lookdevFolder.add(studioState, "animateLights").name("animate lights");

          const rowsFolder = gui.addFolder("Rows");
          rowsFolder.add(studioState, "metals").name("metals").onChange(syncVisibility);
          rowsFolder.add(studioState, "dielectrics").name("dielectrics").onChange(syncVisibility);
          rowsFolder.add(studioState, "clearcoat").name("clearcoat").onChange(syncVisibility);
          rowsFolder.add(studioState, "transmission").name("transmission").onChange(syncVisibility);
          rowsFolder.add(studioState, "shaders").name("shader row").onChange(syncVisibility);
          rowsFolder.add(studioState, "showProps").name("back props").onChange(syncVisibility);
        },
        dispose: () => {
          scene.environment = null;
          roomEnvironment.dispose();
          environmentTarget.dispose();
          pmremGenerator.dispose();
          lookdevFloorTexture.dispose();
          sphereGeometry.dispose();
          capsuleGeometry.dispose();
          stage.geometry.dispose();
          stageTop.geometry.dispose();
          accentMarker.geometry.dispose();

          for (const material of trackedMaterials) {
            material.dispose();
          }

          (accentMarker.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 05",
    title: "Scene Graph",
    summary: "Use parent-child transforms to animate more complex systems without hand-updating every world position.",
    notes:
      "A lot of Three.js clicks once groups make sense. Orbiting planets, mechanical arms, cameras, and character rigs all build on this relationship tree.",
    tags: ["Group", "Local space", "Hierarchy"],
    cameraPosition: [8.8, 5.6, 8.8],
    target: [0, 0.6, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#09111b");

      const ambient = new THREE.AmbientLight("#6f95ff", 0.3);
      const sunLight = new THREE.PointLight("#ffd79a", 65, 30, 2);
      scene.add(ambient, sunLight);

      const system = new THREE.Group();
      const sun = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 24),
        new THREE.MeshStandardMaterial({
          color: "#ffbe63",
          emissive: "#ff9c2b",
          emissiveIntensity: 1.2,
          roughness: 0.65,
          metalness: 0,
        }),
      );
      sunLight.add(sun);

      const planetOrbit = new THREE.Group();
      const planet = new THREE.Mesh(
        new THREE.SphereGeometry(0.48, 24, 18),
        new THREE.MeshStandardMaterial({
          color: "#6fd6ff",
          roughness: 0.48,
          metalness: 0.05,
        }),
      );
      planet.position.x = 3.2;

      const moonOrbit = new THREE.Group();
      moonOrbit.position.x = 3.2;
      const moon = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 20, 14),
        new THREE.MeshStandardMaterial({
          color: "#f4f7ff",
          roughness: 0.92,
          metalness: 0.02,
        }),
      );
      moon.position.x = 0.95;

      const farOrbit = new THREE.Group();
      const farPlanet = new THREE.Mesh(
        new THREE.SphereGeometry(0.72, 24, 18),
        new THREE.MeshStandardMaterial({
          color: "#ff8a72",
          roughness: 0.72,
          metalness: 0.08,
        }),
      );
      farPlanet.position.x = 5.5;

      const orbitA = createOrbitLine(3.2, "#3d7bcb");
      const orbitB = createOrbitLine(5.5, "#c65f62");
      const orbitMoon = createOrbitLine(0.95, "#cfd8ff");
      moonOrbit.add(orbitMoon, moon);
      planetOrbit.add(planet, moonOrbit);
      farOrbit.add(farPlanet);
      system.add(orbitA, orbitB, planetOrbit, farOrbit);
      scene.add(system);

      return {
        update: (elapsed) => {
          planetOrbit.rotation.y = elapsed * 0.95;
          moonOrbit.rotation.y = elapsed * 2.4;
          farOrbit.rotation.y = -elapsed * 0.42;
          sun.rotation.y = elapsed * 0.2;
          planet.rotation.y = elapsed * 1.1;
          farPlanet.rotation.y = elapsed * 0.7;
        },
        dispose: () => {
          disposeSceneResources([sun, planet, moon, farPlanet]);
          orbitA.geometry.dispose();
          (orbitA.material as THREE.Material).dispose();
          orbitB.geometry.dispose();
          (orbitB.material as THREE.Material).dispose();
          orbitMoon.geometry.dispose();
          (orbitMoon.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 06",
    title: "Instancing",
    summary: "Draw lots of similar objects with one mesh and per-instance transforms and colors.",
    notes:
      "This card updates every cube from a tiny CPU-side transform buffer. It is a good mental bridge toward larger GPU-driven crowds and particles.",
    tags: ["InstancedMesh", "setMatrixAt", "setColorAt"],
    cameraPosition: [8.5, 7, 8.5],
    target: [0, 0.6, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#09111b");

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(8.5, 64),
        new THREE.MeshStandardMaterial({
          color: "#102434",
          roughness: 0.96,
          metalness: 0.04,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      scene.add(floor);

      const ambient = new THREE.AmbientLight("#88b9ff", 0.55);
      const key = new THREE.DirectionalLight("#ffffff", 1.75);
      key.position.set(6, 8, 4);
      key.castShadow = true;
      scene.add(ambient, key);

      const geometry = new THREE.BoxGeometry(0.4, 1.5, 0.4);
      const material = new THREE.MeshStandardMaterial({
        roughness: 0.24,
        metalness: 0.18,
      });

      const countX = 11;
      const countZ = 11;
      const count = countX * countZ;
      const instanced = new THREE.InstancedMesh(geometry, material, count);
      instanced.castShadow = true;
      instanced.receiveShadow = true;

      const dummy = new THREE.Object3D();
      const baseTransforms = new Array(count).fill(null).map(() => ({
        x: 0,
        z: 0,
        offset: 0,
        scale: 1,
      }));

      let index = 0;
      for (let x = 0; x < countX; x += 1) {
        for (let z = 0; z < countZ; z += 1) {
          const px = (x - (countX - 1) / 2) * 0.9;
          const pz = (z - (countZ - 1) / 2) * 0.9;
          const offset = Math.random() * Math.PI * 2;
          const scale = 0.55 + Math.random() * 0.8;
          baseTransforms[index] = { x: px, z: pz, offset, scale };

          dummy.position.set(px, 0.75, pz);
          dummy.scale.setScalar(scale);
          dummy.updateMatrix();
          instanced.setMatrixAt(index, dummy.matrix);
          instanced.setColorAt(
            index,
            new THREE.Color().setHSL(0.52 + x / countX * 0.16, 0.78, 0.54 + z / countZ * 0.12),
          );
          index += 1;
        }
      }

      scene.add(instanced);

      return {
        update: (elapsed) => {
          for (let i = 0; i < count; i += 1) {
            const base = baseTransforms[i];
            dummy.position.set(base.x, 0.35 + Math.sin(elapsed * 2 + base.offset) * 0.65, base.z);
            dummy.rotation.x = Math.sin(elapsed + base.offset) * 0.2;
            dummy.rotation.y = elapsed * 0.45 + base.offset;
            dummy.scale.setScalar(base.scale);
            dummy.updateMatrix();
            instanced.setMatrixAt(i, dummy.matrix);
          }

          instanced.instanceMatrix.needsUpdate = true;
        },
        dispose: () => {
          geometry.dispose();
          material.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 07",
    title: "Storage Buffer Instancing",
    summary: "Move instance data out of CPU matrices and into GPU-addressable storage buffers.",
    notes:
      "This is a very WebGPU-flavored step: all instances still share one mesh, but their per-instance placement and color now come straight from storage-backed attributes.",
    tags: ["instancedArray", "Storage buffers", "GPU-fed instance data"],
    cameraPosition: [7.8, 5.8, 8.2],
    target: [0, 0.8, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#08111a");

      const ambient = new THREE.AmbientLight("#84b4ff", 0.46);
      const key = new THREE.DirectionalLight("#ffffff", 1.75);
      key.position.set(5, 7, 4);
      scene.add(ambient, key);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(8.2, 64),
        new THREE.MeshStandardMaterial({
          color: "#102434",
          roughness: 0.96,
          metalness: 0.03,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.9;
      scene.add(floor);

      const count = 420;
      const layoutBuffer = instancedArray(new Float32Array(count * 4), "vec4");
      const layoutArray = ((layoutBuffer.value as THREE.BufferAttribute).array as Float32Array);

      for (let index = 0; index < count; index += 1) {
        const stride = index * 4;
        const ring = 1.2 + (index % 18) * 0.28;
        const angle = index / count * Math.PI * 12 + (index % 7) * 0.17;
        layoutArray[stride] = ring;
        layoutArray[stride + 1] = -0.15 + ((index % 9) - 4) * 0.18;
        layoutArray[stride + 2] = angle;
        layoutArray[stride + 3] = 0.55 + (index % 5) * 0.12;
      }

      (layoutBuffer.value as THREE.BufferAttribute).needsUpdate = true;

      const layoutNode = (layoutBuffer as any).toAttribute() as any;
      const angleNode = time.mul(0.35).add(layoutNode.z);
      const bobNode = sin(time.mul(1.6).add(layoutNode.z.mul(2))).mul(0.18).add(layoutNode.y);
      const offsetNode = vec3(cos(angleNode).mul(layoutNode.x), bobNode, sin(angleNode).mul(layoutNode.x));

      const material = new THREE.MeshStandardNodeMaterial({
        roughness: 0.28,
        metalness: 0.14,
      });
      material.positionNode = positionLocal.mul(layoutNode.w).add(offsetNode);
      material.colorNode = mix(color("#1f6dff"), color("#8bf5ff"), layoutNode.y.add(1).mul(0.5).clamp());

      const geometry = new THREE.IcosahedronGeometry(0.16, 1);
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.frustumCulled = false;
      scene.add(mesh);

      return {
        update: (elapsed) => {
          mesh.rotation.y = elapsed * 0.08;
        },
        dispose: () => {
          geometry.dispose();
          material.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 08",
    title: "Compute Swarm",
    summary: "Run a compute pass each frame to write fresh instance positions and colors on the GPU.",
    notes:
      "This is the biggest WebGPU leap in the page: `renderer.compute()` updates storage buffers, and the render material reads those same buffers without a CPU-side transform loop.",
    tags: ["renderer.compute", "ComputeNode", "GPU simulation"],
    cameraPosition: [8.2, 6.2, 8.8],
    target: [0, 0.6, 0],
    create: ({ scene, renderer }) => {
      scene.background = new THREE.Color("#050d16");

      const ambient = new THREE.AmbientLight("#7ea8ff", 0.35);
      const key = new THREE.DirectionalLight("#ffffff", 1.9);
      key.position.set(6, 8, 4);
      scene.add(ambient, key);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(8.4, 72),
        new THREE.MeshStandardMaterial({
          color: "#0f2233",
          roughness: 0.98,
          metalness: 0.02,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.2;
      scene.add(floor);

      const count = 512;
      const positionBuffer = instancedArray(new Float32Array(count * 3), "vec3");
      const colorBuffer = instancedArray(new Float32Array(count * 3), "vec3");
      const paramBuffer = instancedArray(new Float32Array(count * 4), "vec4");

      const paramArray = ((paramBuffer.value as THREE.BufferAttribute).array as Float32Array);

      for (let index = 0; index < count; index += 1) {
        const stride = index * 4;
        paramArray[stride] = 1.3 + (index % 16) * 0.18;
        paramArray[stride + 1] = -0.8 + ((Math.floor(index / 16) % 8) - 3.5) * 0.28;
        paramArray[stride + 2] = 0.45 + (index % 9) * 0.08;
        paramArray[stride + 3] = index * 0.37;
      }

      (paramBuffer.value as THREE.BufferAttribute).needsUpdate = true;

      const computeNode = Fn(() => {
        const param = paramBuffer.element(instanceIndex);
        const position = positionBuffer.element(instanceIndex);
        const tint = colorBuffer.element(instanceIndex);
        const angle = time.mul(param.z).add(param.w);
        const orbit = vec3(
          cos(angle).mul(param.x),
          sin(angle.mul(1.7)).mul(0.5).add(param.y),
          sin(angle).mul(param.x),
        );

        position.assign(orbit);
        tint.assign(mix(color("#246bff"), color("#8cffd9"), sin(angle).mul(0.5).add(0.5)));
      })().compute(count, [64]);

      const positionNode = (positionBuffer as any).toAttribute() as any;
      const colorNode = (colorBuffer as any).toAttribute() as any;

      const material = new THREE.MeshStandardNodeMaterial({
        roughness: 0.24,
        metalness: 0.12,
      });
      material.positionNode = positionLocal.add(positionNode);
      material.colorNode = colorNode;

      const geometry = new THREE.IcosahedronGeometry(0.12, 0);
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.frustumCulled = false;
      scene.add(mesh);

      return {
        update: (elapsed) => {
          renderer.compute(computeNode);
          mesh.rotation.y = elapsed * 0.06;
        },
        dispose: () => {
          computeNode.dispose();
          geometry.dispose();
          material.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 09",
    title: "Particle Field",
    summary: "Animate many lightweight points by updating buffer attributes directly.",
    notes:
      "This sits nicely between instancing and custom shaders: you are still feeding the GPU structured buffers, but now the representation is a cloud instead of a solid mesh.",
    tags: ["Points", "Dynamic buffers", "Additive blending"],
    cameraPosition: [5.8, 4.2, 7.8],
    target: [0, 0, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#040a12");

      const count = 1400;
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const radii = new Float32Array(count);
      const heights = new Float32Array(count);
      const speeds = new Float32Array(count);
      const offsets = new Float32Array(count);

      const colorValue = new THREE.Color();

      for (let index = 0; index < count; index += 1) {
        radii[index] = 0.8 + Math.random() * 2.8;
        heights[index] = -1.6 + Math.random() * 3.2;
        speeds[index] = 0.3 + Math.random() * 1.2;
        offsets[index] = Math.random() * Math.PI * 2;

        colorValue.setHSL(0.52 + Math.random() * 0.15, 0.9, 0.55 + Math.random() * 0.2);
        colors[index * 3] = colorValue.r;
        colors[index * 3 + 1] = colorValue.g;
        colors[index * 3 + 2] = colorValue.b;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

      const material = new THREE.PointsMaterial({
        size: 0.09,
        transparent: true,
        opacity: 0.9,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      const points = new THREE.Points(geometry, material);
      scene.add(points);

      return {
        update: (elapsed) => {
          for (let index = 0; index < count; index += 1) {
            const angle = elapsed * speeds[index] + offsets[index];
            const wobble = Math.sin(elapsed * 0.8 + offsets[index] * 2) * 0.25;
            positions[index * 3] = Math.cos(angle) * (radii[index] + wobble);
            positions[index * 3 + 1] = heights[index] + Math.sin(angle * 2) * 0.22;
            positions[index * 3 + 2] = Math.sin(angle) * (radii[index] + wobble);
          }

          geometry.attributes.position.needsUpdate = true;
          points.rotation.y = elapsed * 0.12;
        },
        dispose: () => {
          geometry.dispose();
          material.dispose();
        },
      };
    },
  },
  {
    step: "Step 10",
    title: "Morph Targets",
    summary: "Blend between preauthored shapes to animate a mesh without changing its topology.",
    notes:
      "Morph targets are the other big deformation system beside skinning. They show up everywhere from facial animation to stylized UI blobs and breathing surfaces.",
    tags: ["Morph targets", "Deformation", "Animation blending"],
    cameraPosition: [4.8, 3.2, 6.2],
    target: [0, 0.6, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#07111e");

      const ambient = new THREE.AmbientLight("#8eb8ff", 0.5);
      const key = new THREE.DirectionalLight("#ffffff", 1.8);
      key.position.set(5, 7, 4);
      scene.add(ambient, key);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(5.5, 64),
        new THREE.MeshStandardMaterial({
          color: "#12273a",
          roughness: 0.96,
          metalness: 0.03,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.4;
      scene.add(floor);

      const geometry = new THREE.IcosahedronGeometry(1.25, 5);
      const stretch = geometry.attributes.position.clone();
      const pinch = geometry.attributes.position.clone();
      const vertex = new THREE.Vector3();

      for (let index = 0; index < stretch.count; index += 1) {
        vertex.fromBufferAttribute(stretch, index);
        const stretchScale = 1 + Math.max(vertex.y, 0) * 0.45;
        stretch.setXYZ(index, vertex.x * 0.8, vertex.y * stretchScale, vertex.z * 0.8);

        vertex.fromBufferAttribute(pinch, index);
        const radial = Math.sqrt(vertex.x * vertex.x + vertex.z * vertex.z);
        const wobble = 1 + Math.sin(vertex.y * 4) * 0.18;
        pinch.setXYZ(index, vertex.x * (1.2 - radial * 0.18) * wobble, vertex.y * 0.82, vertex.z * (1.2 - radial * 0.18) * wobble);
      }

      geometry.morphAttributes.position = [stretch, pinch];

      const blob = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: "#77ddff",
          roughness: 0.32,
          metalness: 0.12,
          flatShading: false,
        }),
      );
      blob.position.y = 0.3;

      const shell = new THREE.Mesh(
        geometry.clone(),
        new THREE.MeshBasicMaterial({
          color: "#d9f5ff",
          wireframe: true,
          transparent: true,
          opacity: 0.16,
        }),
      );
      shell.position.copy(blob.position);
      shell.scale.setScalar(1.01);

      scene.add(blob, shell);

      return {
        update: (elapsed) => {
          const stretchWeight = (Math.sin(elapsed * 1.4) + 1) * 0.5;
          const pinchWeight = (Math.sin(elapsed * 1.9 + 1.1) + 1) * 0.5;

          if (blob.morphTargetInfluences) {
            blob.morphTargetInfluences[0] = stretchWeight;
            blob.morphTargetInfluences[1] = pinchWeight * 0.75;
          }

          if (shell.morphTargetInfluences) {
            shell.morphTargetInfluences[0] = stretchWeight;
            shell.morphTargetInfluences[1] = pinchWeight * 0.75;
          }

          blob.rotation.y = elapsed * 0.4;
          shell.rotation.y = blob.rotation.y;
        },
        dispose: () => {
          geometry.dispose();
          blob.geometry.dispose();
          (blob.material as THREE.Material).dispose();
          shell.geometry.dispose();
          (shell.material as THREE.Material).dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 11",
    title: "Spline Tubes",
    summary: "Generate geometry from curves so motion paths and procedural forms become first-class tools.",
    notes:
      "Tube geometry is a great waypoint in the learning curve because it combines parametric thinking, orientation along a path, and scene animation in one approachable example.",
    tags: ["CatmullRomCurve3", "TubeGeometry", "Path animation"],
    cameraPosition: [7.2, 4.2, 7.8],
    target: [0, 0.4, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#08131c");

      const ambient = new THREE.AmbientLight("#7faeff", 0.45);
      const key = new THREE.DirectionalLight("#ffffff", 1.7);
      key.position.set(6, 7, 3);
      scene.add(ambient, key);

      const curve = new THREE.CatmullRomCurve3(
        [
          new THREE.Vector3(-3.5, -0.5, 0),
          new THREE.Vector3(-2.2, 1.3, 1.6),
          new THREE.Vector3(-0.7, 0.4, -1.8),
          new THREE.Vector3(0.8, 1.8, 0.7),
          new THREE.Vector3(2.2, -0.2, 1.6),
          new THREE.Vector3(3.6, 0.9, -0.2),
        ],
        false,
        "catmullrom",
        0.35,
      );

      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 180, 0.22, 18, false),
        new THREE.MeshStandardMaterial({
          color: "#79d5ff",
          roughness: 0.24,
          metalness: 0.26,
        }),
      );

      const guide = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(160)),
        new THREE.LineBasicMaterial({
          color: "#d7efff",
          transparent: true,
          opacity: 0.28,
        }),
      );

      const traveler = new THREE.Mesh(
        new THREE.SphereGeometry(0.24, 20, 16),
        new THREE.MeshStandardMaterial({
          color: "#ffb15f",
          roughness: 0.3,
          metalness: 0.14,
        }),
      );

      const tangentPoint = new THREE.Vector3();
      const nextPoint = new THREE.Vector3();

      scene.add(tube, guide, traveler);

      return {
        update: (elapsed) => {
          const t = (elapsed * 0.08) % 1;
          curve.getPointAt(t, tangentPoint);
          curve.getPointAt((t + 0.01) % 1, nextPoint);
          traveler.position.copy(tangentPoint);
          traveler.lookAt(nextPoint);
          tube.rotation.y = Math.sin(elapsed * 0.25) * 0.12;
        },
        dispose: () => {
          tube.geometry.dispose();
          (tube.material as THREE.Material).dispose();
          guide.geometry.dispose();
          (guide.material as THREE.Material).dispose();
          traveler.geometry.dispose();
          (traveler.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 12",
    title: "Shader Nodes",
    summary: "Use Three.js TSL nodes to displace vertices and color fragments without dropping to raw WGSL yet.",
    notes:
      "This is one of the nicest ways to learn custom shading in modern Three.js: start from a familiar material, then override just the position and color nodes.",
    tags: ["TSL", "positionNode", "colorNode"],
    cameraPosition: [4.2, 2.8, 5.8],
    target: [0, 0.4, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#0a1420");

      const ambient = new THREE.AmbientLight("#6d9cff", 0.42);
      const key = new THREE.DirectionalLight("#ffffff", 2.0);
      key.position.set(4, 5, 5);
      scene.add(ambient, key);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(5.5, 64),
        new THREE.MeshStandardMaterial({
          color: "#112536",
          roughness: 0.98,
          metalness: 0.02,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.5;
      scene.add(floor);

      const material = new THREE.MeshStandardNodeMaterial({
        roughness: 0.25,
        metalness: 0.08,
      });

      const pulse = sin(positionLocal.y.mul(7).add(time.mul(2.4))).mul(0.14);
      const secondaryPulse = sin(positionLocal.x.mul(4).add(time.mul(1.6))).mul(0.08);

      material.positionNode = positionLocal.add(normalLocal.mul(pulse.add(secondaryPulse)));
      material.colorNode = mix(
        color("#1f77ff"),
        color("#ff9a3d"),
        uv().y.add(sin(time.mul(3).add(positionLocal.x.mul(6))).mul(0.35)).clamp(),
      );

      const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1.2, 0.44, 220, 32), material);
      mesh.position.y = 0.5;
      scene.add(mesh);

      return {
        update: (elapsed) => {
          mesh.rotation.x = elapsed * 0.45;
          mesh.rotation.y = elapsed * 0.75;
        },
        dispose: () => {
          mesh.geometry.dispose();
          material.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 13",
    title: "Wave Surface",
    summary: "Push shader-node displacement further by animating a dense surface like water or cloth.",
    notes:
      "This is still built with Three.js materials, but the deformation is now rich enough to feel like a bespoke GPU effect rather than a small embellishment.",
    tags: ["TSL", "Displacement", "Animated surface"],
    cameraPosition: [5.4, 4.6, 6.2],
    target: [0, 0.2, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#06111b");

      const ambient = new THREE.AmbientLight("#85b5ff", 0.36);
      const key = new THREE.DirectionalLight("#ffffff", 1.8);
      key.position.set(4, 7, 5);
      scene.add(ambient, key);

      const material = new THREE.MeshStandardNodeMaterial({
        roughness: 0.18,
        metalness: 0.08,
      });

      const waveA = sin(positionLocal.x.mul(2.2).add(time.mul(1.6))).mul(0.18);
      const waveB = sin(positionLocal.z.mul(3.4).sub(time.mul(2.1))).mul(0.11);
      const waveC = sin(positionLocal.x.add(positionLocal.z).mul(1.8).add(time.mul(1.2))).mul(0.08);
      const waveHeight = waveA.add(waveB).add(waveC);

      material.positionNode = positionLocal.add(normalLocal.mul(waveHeight));
      material.colorNode = mix(color("#0b4075"), color("#8be5ff"), waveHeight.mul(2.5).add(0.5).clamp());

      const surface = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 6.5, 220, 220), material);
      surface.rotation.x = -Math.PI / 2;

      const markerA = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.28, 0.28),
        new THREE.MeshStandardMaterial({
          color: "#ffb15f",
          roughness: 0.46,
          metalness: 0.08,
        }),
      );
      markerA.position.set(-1.4, 0.18, -1);

      const markerB = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 18, 14),
        new THREE.MeshStandardMaterial({
          color: "#f4fbff",
          roughness: 0.3,
          metalness: 0.06,
        }),
      );
      markerB.position.set(1.3, 0.16, 1.2);

      scene.add(surface, markerA, markerB);

      return {
        update: (elapsed) => {
          markerA.position.y = 0.18 + Math.sin(elapsed * 1.6) * 0.08;
          markerB.position.y = 0.16 + Math.sin(elapsed * 1.3 + 1.5) * 0.08;
        },
        dispose: () => {
          surface.geometry.dispose();
          material.dispose();
          markerA.geometry.dispose();
          (markerA.material as THREE.Material).dispose();
          markerB.geometry.dispose();
          (markerB.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 14",
    title: "Skinning",
    summary: "Load a real rigged character, switch between animation clips, and inspect the skeleton that drives the deformation.",
    notes:
      "This card now uses the official RobotExpressive sample from the Three.js example assets, so you can study a proper skinned character, animation clips, mixer actions, and a skeleton helper on a real rig.",
    tags: ["GLTFLoader", "AnimationMixer", "SkeletonHelper", "Animation clips"],
    cameraPosition: [5.8, 3.4, 6.2],
    target: [0, 1.45, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#09121c");

      const ambient = new THREE.AmbientLight("#92baff", 0.5);
      const key = new THREE.DirectionalLight("#ffffff", 1.85);
      key.position.set(4, 6, 3);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.normalBias = 0.14;
      const rim = new THREE.DirectionalLight("#98c9ff", 0.8);
      rim.position.set(-4, 5, -2);
      scene.add(ambient, key, rim);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(6, 64),
        new THREE.MeshStandardMaterial({
          color: "#10263a",
          roughness: 0.94,
          metalness: 0.04,
        }),
      );
      floor.userData.skipGlobalWireframe = true;
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      const podium = new THREE.Mesh(
        new THREE.CylinderGeometry(1.05, 1.18, 0.24, 48),
        new THREE.MeshStandardMaterial({
          color: "#173149",
          roughness: 0.82,
          metalness: 0.08,
        }),
      );
      podium.userData.skipGlobalWireframe = true;
      podium.position.y = 0.12;
      podium.castShadow = true;
      podium.receiveShadow = true;

      const loadingProxy = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.34, 1.3, 6, 18),
        new THREE.MeshStandardMaterial({
          color: "#7be0ff",
          roughness: 0.42,
          metalness: 0.08,
        }),
      );
      const staticWireframeOverlays: MeshWireframeOverlay[] = [];
      loadingProxy.userData.skipGlobalWireframe = true;
      loadingProxy.position.y = 1;
      loadingProxy.castShadow = true;

      for (const mesh of [floor, podium, loadingProxy]) {
        const overlay = createMeshWireframeOverlay(mesh);
        if (overlay) {
          staticWireframeOverlays.push(overlay);
        }
      }

      scene.add(floor, podium, loadingProxy);

      const loader = new GLTFLoader();
      const skinState = {
        showSkeleton: false,
        timeScale: 1,
        turntable: false,
        clip: "Loading...",
      };
      let disposed = false;
      let wireframeEnabled = false;
      let mixer: THREE.AnimationMixer | null = null;
      let characterRoot: THREE.Object3D | null = null;
      let skeletonHelper: THREE.SkeletonHelper | null = null;
      let activeAction: THREE.AnimationAction | null = null;
      let clips: THREE.AnimationClip[] = [];
      const skinnedWireframeOverlays: SkinnedWireframeOverlay[] = [];
      let clipController: (ReturnType<GUI["add"]> & {
        options?: (values: string[] | Record<string, string>) => unknown;
      }) | null = null;

      const disposeCharacter = (root: THREE.Object3D) => {
        const objects: THREE.Object3D[] = [];
        root.traverse((object) => {
          objects.push(object);
        });
        disposeSceneResources(objects);
      };

      const syncSkeleton = () => {
        if (skeletonHelper) {
          skeletonHelper.visible = skinState.showSkeleton;
        }
      };

      const playClip = (clipName: string) => {
        if (!mixer || clips.length === 0) {
          return;
        }

        const clip = THREE.AnimationClip.findByName(clips, clipName) ?? clips[0];

        if (!clip) {
          return;
        }

        const nextAction = mixer.clipAction(clip);
        nextAction.enabled = true;
        nextAction.reset();
        nextAction.fadeIn(0.22);
        nextAction.play();

        if (activeAction && activeAction !== nextAction) {
          activeAction.fadeOut(0.22);
        }

        activeAction = nextAction;
        skinState.clip = clip.name;
        clipController?.updateDisplay();
      };

      loader
        .loadAsync("/models/RobotExpressive.glb")
        .then((gltf) => {
          if (disposed) {
            disposeCharacter(gltf.scene);
            return;
          }

          const model = gltf.scene;
          const box = new THREE.Box3();
          const size = new THREE.Vector3();
          const center = new THREE.Vector3();
          let firstSkinnedMesh: THREE.SkinnedMesh | null = null;

          model.traverse((object) => {
            if (object instanceof THREE.Mesh) {
              object.castShadow = true;
              object.receiveShadow = true;
              object.userData.skipGlobalWireframe = true;
            }

            if ((object as THREE.Object3D & { isSkinnedMesh?: boolean }).isSkinnedMesh) {
              const skinnedMesh = object as THREE.SkinnedMesh;
              if (!firstSkinnedMesh) {
                firstSkinnedMesh = skinnedMesh;
              }

              const overlay = createSkinnedWireframeOverlay(skinnedMesh);

              if (overlay) {
                overlay.setVisible(wireframeEnabled);
                skinnedWireframeOverlays.push(overlay);
              }
            }
          });

          box.setFromObject(model);
          box.getSize(size);
          const scale = 3.2 / Math.max(size.y, 0.001);
          model.scale.setScalar(scale);
          box.setFromObject(model);
          box.getCenter(center);
          model.position.x -= center.x;
          model.position.z -= center.z;
          model.position.y -= box.min.y - 0.24;
          model.rotation.y = Math.PI * 0.92;
          characterRoot = model;
          scene.add(model);

          mixer = new THREE.AnimationMixer(model);
          clips = gltf.animations;

          if (clipController?.options) {
            clipController.options(clips.map((clip) => clip.name));
          }

          const preferredClip =
            clips.find((clip) => /walk/i.test(clip.name)) ??
            clips.find((clip) => /idle/i.test(clip.name)) ??
            clips[0] ??
            null;

          if (preferredClip) {
            playClip(preferredClip.name);
          }

          if (firstSkinnedMesh) {
            skeletonHelper = new THREE.SkeletonHelper(firstSkinnedMesh);
            skeletonHelper.visible = skinState.showSkeleton;
            scene.add(skeletonHelper);
          }

          loadingProxy.visible = false;
        })
        .catch((error) => {
          console.error("Failed to load RobotExpressive", error);
          const material = loadingProxy.material as THREE.MeshStandardMaterial;
          material.color.set("#ff8f8f");
          material.emissive.set("#5a1a1a");
          material.emissiveIntensity = 0.45;
        });

      return {
        update: (elapsed, delta) => {
          if (mixer) {
            mixer.update(delta * skinState.timeScale);
          }

          if (characterRoot && skinState.turntable) {
            characterRoot.rotation.y = Math.PI + Math.sin(elapsed * 0.3) * 0.5;
          }

          for (const overlay of skinnedWireframeOverlays) {
            overlay.update();
          }

          syncSkeleton();
        },
        setWireframe: (enabled) => {
          wireframeEnabled = enabled;

          for (const overlay of staticWireframeOverlays) {
            overlay.setVisible(enabled);
          }

          for (const overlay of skinnedWireframeOverlays) {
            overlay.setVisible(enabled);
          }
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Skinning");
          folder.add(skinState, "showSkeleton").name("skeleton").onChange(syncSkeleton);
          clipController = folder.add(skinState, "clip", ["Loading..."]).name("clip");
          clipController.onChange((value: string) => playClip(value));
          folder.add(skinState, "timeScale", 0, 2, 0.01).name("time scale");
          folder.add(skinState, "turntable").name("turntable");
        },
        dispose: () => {
          disposed = true;

          for (const overlay of staticWireframeOverlays) {
            overlay.dispose();
          }

          for (const overlay of skinnedWireframeOverlays) {
            overlay.dispose();
          }

          if (characterRoot) {
            scene.remove(characterRoot);

            if (mixer) {
              mixer.stopAllAction();
              mixer.uncacheRoot(characterRoot);
            }

            disposeCharacter(characterRoot);
          }

          if (skeletonHelper) {
            scene.remove(skeletonHelper);
            disposeSceneResources([skeletonHelper]);
          }

          loadingProxy.geometry.dispose();
          (loadingProxy.material as THREE.Material).dispose();
          podium.geometry.dispose();
          (podium.material as THREE.Material).dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 15",
    title: "Quadtree Terrain",
    summary: "Build terrain from quadtree patches, vary the LOD around the camera, and hide T-junction cracks with seam skirts.",
    notes:
      "This is much closer to an engine terrain pipeline: camera-driven patch selection, quadtree balancing, and seam repair on coarse-to-fine borders. Turn on patch bounds to inspect the hierarchy directly.",
    tags: ["Quadtree LOD", "Seam skirts", "Patch bounds"],
    cameraPosition: [8.5, 6.4, 8.5],
    target: [0, 0.4, 0],
    create: ({ scene, camera, controls }) => {
      scene.background = new THREE.Color("#07111a");
      scene.fog = new THREE.Fog("#091421", 16, 34);

      const hemi = new THREE.HemisphereLight("#9fcbff", "#08111a", 0.85);
      const sun = new THREE.DirectionalLight("#fff2d2", 2.0);
      sun.position.set(7, 9, 4);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -14;
      sun.shadow.camera.right = 14;
      sun.shadow.camera.top = 14;
      sun.shadow.camera.bottom = -14;
      sun.shadow.normalBias = 0.2;

      const simplex = new SimplexNoise();
      const terrainSettings: TerrainSettings = {
        size: 30,
        segments: 10,
        maxLevel: 3,
        splitDistance: 1.2,
        skirtDepth: 0.5,
      };
      const terrainGroup = new THREE.Group();
      const boundsGroup = new THREE.Group();
      const terrainGeometryCache = new Map<string, THREE.BufferGeometry>();
      const terrainMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.98,
        metalness: 0.02,
        side: THREE.DoubleSide,
      });
      let wireframeEnabled = false;
      const staticWireframeOverlays: MeshWireframeOverlay[] = [];
      const patchWireframeOverlays: MeshWireframeOverlay[] = [];

      const water = new THREE.Mesh(
        new THREE.CircleGeometry(6.8, 96),
        new THREE.MeshStandardMaterial({
          color: "#1b5a8d",
          transparent: true,
          opacity: 0.76,
          roughness: 0.18,
          metalness: 0.24,
          emissive: "#13385e",
          emissiveIntensity: 0.4,
        }),
      );
      water.rotation.x = -Math.PI / 2;
      water.position.y = -0.24;
      water.userData.skipGlobalWireframe = true;
      water.receiveShadow = true;

      const shoreline = new THREE.Mesh(
        new THREE.TorusGeometry(6.95, 0.12, 16, 96),
        new THREE.MeshStandardMaterial({
          color: "#d7dcb4",
          roughness: 0.92,
          metalness: 0.03,
        }),
      );
      shoreline.rotation.x = Math.PI / 2;
      shoreline.position.y = -0.21;
      shoreline.userData.skipGlobalWireframe = true;

      const drone = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.26, 1),
        new THREE.MeshStandardMaterial({
          color: "#ffd88d",
          emissive: "#ffb95d",
          emissiveIntensity: 0.4,
          roughness: 0.34,
          metalness: 0.16,
        }),
      );
      drone.castShadow = true;
      drone.userData.skipGlobalWireframe = true;
      drone.position.set(2.6, 2.1, 1.6);

      const droneTrail = createOrbitLine(3.5, "#5dd1ff");
      droneTrail.position.y = 0.04;

      for (const mesh of [water, shoreline, drone]) {
        const overlay = createMeshWireframeOverlay(mesh);
        if (overlay) {
          staticWireframeOverlays.push(overlay);
        }
      }

      scene.add(hemi, sun, terrainGroup, boundsGroup, water, shoreline, drone, droneTrail);

      const terrainState = {
        maxLevel: terrainSettings.maxLevel,
        splitDistance: terrainSettings.splitDistance,
        skirtDepth: terrainSettings.skirtDepth,
        showBounds: false,
        freezeLod: false,
        patches: 0,
      };
      const getLodFocus = () => (controls.enabled ? controls.target : camera.position);
      const initialLodFocus = getLodFocus();
      let lastRebuildX = initialLodFocus.x;
      let lastRebuildZ = initialLodFocus.z;

      const clearPatchWireframes = () => {
        for (const overlay of patchWireframeOverlays) {
          overlay.dispose();
        }
        patchWireframeOverlays.length = 0;
      };

      const syncPatchWireframes = () => {
        clearPatchWireframes();

        if (!wireframeEnabled) {
          return;
        }

        for (const object of terrainGroup.children) {
          if (!(object instanceof THREE.Mesh)) {
            continue;
          }

          const overlay = createMeshWireframeOverlay(object);
          if (overlay) {
            overlay.setVisible(true);
            patchWireframeOverlays.push(overlay);
          }
        }
      };

      const clearDynamicTerrain = () => {
        clearPatchWireframes();
        disposeSceneResources([...boundsGroup.children]);
        terrainGroup.clear();
        boundsGroup.clear();
      };

      const clearTerrainCache = () => {
        for (const geometry of terrainGeometryCache.values()) {
          geometry.dispose();
        }

        terrainGeometryCache.clear();
      };

      const rebuildTerrain = () => {
        terrainSettings.maxLevel = terrainState.maxLevel;
        terrainSettings.splitDistance = terrainState.splitDistance;
        terrainSettings.skirtDepth = terrainState.skirtDepth;
        clearDynamicTerrain();

        const lodFocus = getLodFocus();
        const leaves = buildTerrainLeaves(lodFocus, terrainSettings);
        terrainState.patches = leaves.length;

        for (const leaf of leaves) {
          const seamKey = `${Number(leaf.seams.north)}${Number(leaf.seams.south)}${Number(leaf.seams.east)}${Number(leaf.seams.west)}`;
          const geometryKey = [
            terrainSettings.segments,
            terrainSettings.skirtDepth.toFixed(2),
            leaf.minX,
            leaf.maxX,
            leaf.minZ,
            leaf.maxZ,
            seamKey,
          ].join("|");
          let geometry = terrainGeometryCache.get(geometryKey);

          if (!geometry) {
            geometry = createTerrainPatchGeometry(simplex, leaf, terrainSettings);
            terrainGeometryCache.set(geometryKey, geometry);
          }

          const patch = new THREE.Mesh(geometry, terrainMaterial);
          patch.castShadow = false;
          patch.receiveShadow = true;
          patch.userData.skipGlobalWireframe = true;

          terrainGroup.add(patch);

          if (terrainState.showBounds) {
            boundsGroup.add(createTerrainBounds(leaf));
          }
        }

        syncPatchWireframes();
        lastRebuildX = lodFocus.x;
        lastRebuildZ = lodFocus.z;
      };

      rebuildTerrain();

      return {
        update: (elapsed, delta) => {
          drone.position.x = Math.cos(elapsed * 0.46) * 3.4;
          drone.position.z = Math.sin(elapsed * 0.46) * 3.4;
          drone.position.y = 1.55 + Math.sin(elapsed * 1.6) * 0.44;
          drone.rotation.y = elapsed * 1.3;
          sun.position.x = Math.cos(elapsed * 0.16) * 8;
          sun.position.z = Math.sin(elapsed * 0.16) * 8;

          if (terrainState.freezeLod) {
            return;
          }

          const lodFocus = getLodFocus();
          const moved = Math.hypot(lodFocus.x - lastRebuildX, lodFocus.z - lastRebuildZ);

          if (moved > 1.35) {
            rebuildTerrain();
          }
        },
        setWireframe: (enabled) => {
          wireframeEnabled = enabled;

          for (const overlay of staticWireframeOverlays) {
            overlay.setVisible(enabled);
          }

          syncPatchWireframes();
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Terrain");
          folder
            .add(terrainState, "maxLevel", 2, 5, 1)
            .name("max lod")
            .onChange(() => {
              rebuildTerrain();
            });
          folder
            .add(terrainState, "splitDistance", 0.75, 2.3, 0.05)
            .name("split radius")
            .onChange(() => {
              rebuildTerrain();
            });
          folder
            .add(terrainState, "skirtDepth", 0.2, 1.6, 0.05)
            .name("seam depth")
            .onChange(() => {
              clearTerrainCache();
              rebuildTerrain();
            });
          folder
            .add(terrainState, "showBounds")
            .name("patch bounds")
            .onChange(() => {
              rebuildTerrain();
            });
          folder.add(terrainState, "freezeLod").name("freeze lod");
          folder.add(terrainState, "patches").name("patches").listen();
        },
        dispose: () => {
          for (const overlay of staticWireframeOverlays) {
            overlay.dispose();
          }
          clearDynamicTerrain();
          clearTerrainCache();
          terrainMaterial.dispose();
          water.geometry.dispose();
          (water.material as THREE.Material).dispose();
          shoreline.geometry.dispose();
          (shoreline.material as THREE.Material).dispose();
          drone.geometry.dispose();
          (drone.material as THREE.Material).dispose();
          disposeSceneResources([droneTrail]);
        },
      };
    },
  },
  {
    step: "Step 16",
    title: "Workgroup Prism Matrix",
    summary: "Turn workgroups and local invocations into visible geometry so dispatch structure stops being abstract.",
    notes:
      "The important idea here is not the wave itself, it is the coloring and banding: one compute pass is exposing how local lanes sit inside larger workgroups, which is the mental model you need before tiled lighting, prefix sums, sorting, or culling.",
    tags: ["workgroupId", "localId", "Dispatch layout"],
    cameraPosition: [8.4, 7.2, 9.2],
    target: [0, 0.8, 0],
    create: ({ scene, renderer }) => {
      scene.background = new THREE.Color("#040b14");

      const ambient = new THREE.AmbientLight("#8cadff", 0.38);
      const key = new THREE.DirectionalLight("#ffffff", 1.7);
      key.position.set(6, 8, 5);
      scene.add(ambient, key);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(8.5, 72),
        new THREE.MeshStandardMaterial({
          color: "#0f2234",
          roughness: 0.98,
          metalness: 0.02,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.1;
      scene.add(floor);

      const width = 32;
      const height = 16;
      const count = width * height;
      const positionBuffer = instancedArray(new Float32Array(count * 3), "vec3");
      const colorBuffer = instancedArray(new Float32Array(count * 3), "vec3");
      const laneId = localId as any;
      const groupId = workgroupId as any;

      const computeNode = Fn(() => {
        const position = positionBuffer.element(instanceIndex);
        const tint = colorBuffer.element(instanceIndex);
        const gx = instanceIndex.mod(width).toFloat().sub((width - 1) / 2);
        const gz = instanceIndex.div(width).toFloat().sub((height - 1) / 2);
        const pulse = sin(time.mul(2.1).add(groupId.x.toFloat().mul(0.78)).add(laneId.x.toFloat().mul(0.19)))
          .mul(0.48)
          .add(0.52);

        position.assign(vec3(gx.mul(0.28), pulse.mul(1.5).sub(0.52), gz.mul(0.34)));
        tint.assign(
          vec3(
            groupId.x.toFloat().div(count / 64),
            laneId.x.toFloat().div(64),
            sin(time.mul(0.7).add(groupId.x.toFloat().mul(0.8))).mul(0.5).add(0.5),
          ),
        );
      })().compute(count, [64]);

      const positionNode = (positionBuffer as any).toAttribute() as any;
      const colorNode = (colorBuffer as any).toAttribute() as any;

      const material = new THREE.MeshStandardNodeMaterial({
        roughness: 0.24,
        metalness: 0.1,
      });
      material.positionNode = positionLocal.add(positionNode);
      material.colorNode = colorNode;

      const geometry = new THREE.BoxGeometry(0.16, 0.94, 0.16);
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.frustumCulled = false;
      scene.add(mesh);

      return {
        update: (elapsed) => {
          renderer.compute(computeNode);
          mesh.rotation.y = elapsed * 0.04;
        },
        dispose: () => {
          computeNode.dispose();
          geometry.dispose();
          material.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 17",
    title: "Compute Heightfield",
    summary: "Author a whole field of animated columns in compute, then render that same GPU-owned data as geometry.",
    notes:
      "This is the step where compute starts to feel like sculpting. The columns do not come from CPU transforms at all: compute writes offsets, heights, and color, and the render material just consumes those buffers.",
    tags: ["Compute terrain", "GPU-authored surface", "Instance deformation"],
    cameraPosition: [8.8, 7.8, 9.6],
    target: [0, 0.6, 0],
    create: ({ scene, renderer }) => {
      scene.background = new THREE.Color("#06101a");

      const ambient = new THREE.AmbientLight("#87b7ff", 0.34);
      const key = new THREE.DirectionalLight("#fff8e6", 1.85);
      key.position.set(7, 9, 4);
      scene.add(ambient, key);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(8.8, 72),
        new THREE.MeshStandardMaterial({
          color: "#0e2231",
          roughness: 1,
          metalness: 0.01,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.3;
      scene.add(floor);

      const width = 34;
      const depth = 34;
      const count = width * depth;
      const layoutBuffer = instancedArray(new Float32Array(count * 4), "vec4");
      const colorBuffer = instancedArray(new Float32Array(count * 3), "vec3");

      const computeNode = Fn(() => {
        const layout = layoutBuffer.element(instanceIndex);
        const tint = colorBuffer.element(instanceIndex);
        const x = instanceIndex.mod(width).toFloat().sub((width - 1) / 2);
        const z = instanceIndex.div(width).toFloat().sub((depth - 1) / 2);
        const ripple = sin(x.mul(0.48).add(time.mul(1.8))).add(cos(z.mul(0.42).sub(time.mul(1.15))));
        const cross = sin(x.add(z).mul(0.24).add(time.mul(0.95))).mul(0.7);
        const dome = sin(x.mul(x).add(z.mul(z)).mul(0.028).sub(time.mul(1.35))).mul(0.42);
        const heightValue = ripple.add(cross).add(dome).mul(0.42).add(1.08);

        layout.assign(vec4(x.mul(0.24), heightValue.mul(0.35).sub(0.48), z.mul(0.24), heightValue));
        tint.assign(mix(color("#10386e"), color("#93f5ff"), heightValue.mul(0.42).clamp()));
      })().compute(count, [64]);

      const layoutNode = (layoutBuffer as any).toAttribute() as any;
      const colorNode = (colorBuffer as any).toAttribute() as any;

      const material = new THREE.MeshStandardNodeMaterial({
        roughness: 0.18,
        metalness: 0.08,
      });
      material.positionNode = vec3(positionLocal.x, positionLocal.y.mul(layoutNode.w), positionLocal.z).add(
        vec3(layoutNode.x, layoutNode.y, layoutNode.z),
      );
      material.colorNode = colorNode;

      const geometry = new THREE.BoxGeometry(0.16, 0.8, 0.16);
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.frustumCulled = false;
      scene.add(mesh);

      return {
        update: (elapsed) => {
          renderer.compute(computeNode);
          mesh.rotation.y = Math.sin(elapsed * 0.15) * 0.08;
        },
        dispose: () => {
          computeNode.dispose();
          geometry.dispose();
          material.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 18",
    title: "Storage Texture Portal",
    summary: "Write an animated texture entirely in compute, then immediately reuse it as live material data in the scene.",
    notes:
      "This version uses the real production-shaped pattern: compute writes into a storage texture, then the GPU copies that result into a normal sampled texture for shading. That separation makes the write path and the sample path explicit.",
    tags: ["StorageTexture", "textureStore", "GPU texture copy"],
    cameraPosition: [7.2, 4.8, 8.8],
    target: [0, 2.1, -0.6],
    create: ({ scene, renderer, camera }) => {
      scene.background = new THREE.Color("#091425");

      const ambient = new THREE.AmbientLight("#a6c7ff", 0.56);
      const sky = new THREE.HemisphereLight("#7dc6ff", "#081018", 0.72);
      const key = new THREE.PointLight("#8ff2ff", 32, 18, 2);
      key.position.set(0, 3.4, 2.4);
      const rim = new THREE.DirectionalLight("#ffd7a2", 1.6);
      rim.position.set(-4, 6, -3);
      scene.add(ambient, sky, key, rim);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(8.8, 72),
        new THREE.MeshStandardMaterial({
          color: "#15283a",
          roughness: 0.94,
          metalness: 0.03,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.3;
      scene.add(floor);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.55, 0.12, 24, 96),
        new THREE.MeshStandardMaterial({
          color: "#9adfff",
          emissive: "#2c8aff",
          emissiveIntensity: 1.2,
          roughness: 0.2,
          metalness: 0.42,
        }),
      );
      ring.position.set(0, 2.3, -1.2);
      ring.rotation.x = 0.15;

      const textureSize = 256;
      const portalTexture = new THREE.StorageTexture(textureSize, textureSize);
      portalTexture.colorSpace = THREE.NoColorSpace;

      const displayTarget = new THREE.RenderTarget(textureSize, textureSize, {
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      const sampledTexture = displayTarget.texture;

      const computeNode = Fn(() => {
        const px = instanceIndex.mod(textureSize);
        const py = instanceIndex.div(textureSize);
        const indexUV = uvec2(px, py);
        const nx = px.toFloat().div(textureSize).mul(2).sub(1);
        const ny = py.toFloat().div(textureSize).mul(2).sub(1);
        const radial = nx.mul(nx).add(ny.mul(ny));
        const spiral = sin(nx.mul(nx).add(ny.mul(ny)).mul(20).sub(time.mul(2.8)));
        const bands = sin(nx.mul(12).add(time.mul(1.4)).add(cos(ny.mul(7).sub(time.mul(0.85)))));
        const plasma = sin(ny.mul(14).sub(time.mul(1.9)).add(cos(nx.mul(6).add(time.mul(1.1)))));
        const portalCore = radial.mul(-0.88).add(1.05).clamp();
        const energy = spiral.add(bands).add(plasma).mul(0.2).add(0.8).add(portalCore.mul(0.16)).clamp();
        const sparks = sin(time.mul(0.9).add(nx.mul(15).sub(ny.mul(11)))).mul(0.5).add(0.5).mul(energy);
        const baseColor = mix(color("#1b4f7b"), color("#65f0ff"), energy).add(color("#0f2841").mul(portalCore.mul(0.58).add(0.22)));
        const finalColor = mix(baseColor, color("#fff0b3"), sparks.mul(0.64).add(0.12));

        textureStore(portalTexture, indexUV, vec4(finalColor, 1));
      })().compute(textureSize * textureSize, [64]);

      const portalBack = new THREE.Mesh(
        new THREE.PlaneGeometry(5.45, 5.45, 1, 1),
        new THREE.MeshBasicMaterial({
          color: "#1b5cb8",
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      portalBack.position.set(0, 2.3, -1.28);
      portalBack.rotation.x = 0.15;

      const portal = new THREE.Mesh(
        new THREE.PlaneGeometry(5.1, 5.1, 1, 1),
        new THREE.MeshBasicMaterial({
          map: sampledTexture,
          color: "#ffffff",
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.98,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      portal.position.set(0, 2.3, -1.2);
      portal.rotation.x = 0.15;
      portal.renderOrder = 1;

      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(1.15, 64, 64),
        new THREE.MeshPhysicalMaterial({
          color: "#ffffff",
          map: sampledTexture,
          emissive: new THREE.Color("#2e6fb8"),
          emissiveMap: sampledTexture,
          emissiveIntensity: 1.35,
          roughness: 0.16,
          metalness: 0.08,
          clearcoat: 0.45,
          clearcoatRoughness: 0.18,
        }),
      );
      orb.position.set(0, 1.25, 1.2);
      orb.castShadow = true;
      orb.receiveShadow = true;

      scene.add(portalBack, portal, ring, orb);

      return {
        update: (elapsed) => {
          renderer.compute(computeNode);
          renderer.copyTextureToTexture(portalTexture, sampledTexture);
          ring.rotation.z = elapsed * 0.16;
          orb.rotation.y = elapsed * 0.28;
          orb.rotation.x = Math.sin(elapsed * 0.7) * 0.18;
          portalBack.lookAt(camera.position);
          portalBack.rotateY(Math.PI);
          portal.lookAt(camera.position);
          portal.rotateY(Math.PI);
        },
        dispose: () => {
          computeNode.dispose();
          portalTexture.dispose();
          displayTarget.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          ring.geometry.dispose();
          (ring.material as THREE.Material).dispose();
          portalBack.geometry.dispose();
          (portalBack.material as THREE.Material).dispose();
          portal.geometry.dispose();
          (portal.material as THREE.Material).dispose();
          orb.geometry.dispose();
          (orb.material as THREE.Material).dispose();
        },
      };
    },
  },
];

app.innerHTML = `
  <main class="page-shell">
    <section class="hero">
      <span class="eyebrow">Three.js + WebGPU + TypeScript</span>
      <h1>Interactive WebGPU learning gallery</h1>
      <p class="hero-copy">
        Each card is its own orbitable scene so you can inspect one concept at a time, moving from a single triangle
        up through indexed geometry, UVs, lighting, hierarchy, instancing, storage buffers, compute-driven animation,
        particles, morph targets, spline geometry, node-based shaders, animated surfaces, skinning, procedural terrain,
        and then into a run of advanced GPU labs focused on workgroups, compute-authored geometry, and storage textures.
        Every card now carries an embedded IMGUI so you can flip wireframes, switch between orbit and FPS camera modes,
        and then dig into example-specific controls without leaving the scene.
      </p>
      <div class="hero-grid">
        <div class="hero-panel">
          <strong>How to use it</strong>
          <p>Drag to orbit, scroll to zoom, pan with right mouse, or switch to FPS and move with WASD plus Q/E vertical motion.</p>
        </div>
        <div class="hero-panel">
          <strong>Why this progression</strong>
          <p>It mirrors how real WebGPU work grows: geometry first, then surface data, then scene structure, then GPU-owned data, then compute-authored buffers and textures.</p>
        </div>
        <div class="hero-panel">
          <strong>What to study</strong>
          <p>Open the source, tweak one example at a time, and treat each card as a tiny isolated sandbox with one main GPU idea.</p>
        </div>
      </div>
      <div id="runtime-status"></div>
    </section>
    <section id="examples" class="examples-grid"></section>
    <p class="footer-note">
      Tip: start by toggling wireframe and swapping between orbit and FPS in each IMGUI. The storage-buffer,
      compute-swarm, workgroup-prism, compute-heightfield, and storage-texture portal cards are the most
      WebGPU-specific steps before jumping into custom WGSL, GPGPU, or renderer internals.
    </p>
  </main>
`;

const statusTarget = document.querySelector<HTMLDivElement>("#runtime-status");
const examplesTarget = document.querySelector<HTMLDivElement>("#examples");

if (!statusTarget || !examplesTarget) {
  throw new Error("Could not find page targets");
}

if (!WebGPU.isAvailable()) {
  const warning = document.createElement("div");
  warning.className = "status-banner";
  warning.textContent =
    "WebGPU is not available in this browser right now. Three.js will attempt to fall back to WebGL2 so you can still explore the examples.";
  statusTarget.append(warning);
}

for (const example of examples) {
  const stepNumber = Number(example.step.replace(/\D+/g, ""));
  const isAdvancedLab = Number.isFinite(stepNumber) && stepNumber >= 16;
  const card = document.createElement("article");
  card.className = isAdvancedLab ? "example-card example-card-advanced" : "example-card";
  card.innerHTML = `
    <div class="example-head">
      <div>
        <div class="example-level">${example.step}</div>
        <h2>${example.title}</h2>
      </div>
      ${isAdvancedLab ? `<div class="advanced-chip">GPU Lab</div>` : ""}
    </div>
    <p class="example-summary">${example.summary}</p>
    <div class="example-viewport">
      <div class="example-fps">0 FPS</div>
    </div>
    <div class="example-gui-shell">
      <div class="example-gui"></div>
    </div>
    <div class="example-notes">
      <p>${example.notes}</p>
      <div class="tag-row">
        ${example.tags.map((tag) => `<span class="tag">${tag}</span>`).join("")}
      </div>
    </div>
  `;
  examplesTarget.append(card);
}

const timer = new THREE.Timer();
timer.connect(document);
const mountedExamples = await Promise.all(
  [...document.querySelectorAll<HTMLElement>(".example-card")].map((card, index) =>
    mountExample(card, examples[index]),
  ),
);

const renderLoop = () => {
  timer.update();
  const delta = timer.getDelta();
  const elapsed = timer.getElapsed();
  const fps = delta > 0 ? THREE.MathUtils.clamp(1 / delta, 0, 240) : 0;

  for (const mounted of mountedExamples) {
    if (mounted.failed) {
      continue;
    }

    try {
      mounted.fpsSmoothed = mounted.fpsSmoothed === 0 ? fps : THREE.MathUtils.lerp(mounted.fpsSmoothed, fps, 0.16);
      mounted.fpsLabel.textContent = `${Math.round(mounted.fpsSmoothed)} FPS`;
      mounted.cameraRig.update(delta);
      mounted.update?.(elapsed, delta);

      const rect = mounted.host.getBoundingClientRect();
      const visible = rect.bottom > 0 && rect.top < window.innerHeight;

      if (visible) {
        mounted.renderer.render(mounted.scene, mounted.camera);
      }
    } catch (error) {
      mounted.failed = true;
      mounted.card.dataset.error = "true";
      const details = error instanceof Error ? error.message : String(error);
      mounted.host.innerHTML = `<div class="example-error">This example hit a runtime error.<br>${details}</div>`;
      console.error(`Example "${mounted.card.querySelector("h2")?.textContent ?? "unknown"}" failed`, error);
    }
  }

  requestAnimationFrame(renderLoop);
};

requestAnimationFrame(renderLoop);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const mounted of mountedExamples) {
      mounted.resizeObserver.disconnect();
      mounted.cameraRig.dispose();
      mounted.controls.dispose();
      mounted.gui.destroy();
      mounted.dispose?.();
      mounted.renderer.dispose();
    }
  });
}

async function mountExample(card: HTMLElement, example: ExampleDefinition): Promise<MountedExample> {
  const host = card.querySelector<HTMLDivElement>(".example-viewport");
  const guiHost = card.querySelector<HTMLDivElement>(".example-gui");
  const fpsLabel = host?.querySelector<HTMLDivElement>(".example-fps");

  if (!host || !guiHost || !fpsLabel) {
    throw new Error(`Missing viewport for ${example.title}`);
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(...example.cameraPosition);

  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1), false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  await renderer.init();

  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  host.append(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = true;
  controls.minDistance = 1.5;
  controls.maxDistance = 30;

  if (example.target) {
    controls.target.set(...example.target);
  }

  controls.update();

  const runtime = example.create({ scene, camera, renderer, controls });
  const viewState: ExampleViewState = {
    wireframe: false,
    cameraMode: "orbit",
    moveSpeed: 6,
    lookSpeed: 1,
  };
  const cameraRig = new ExampleCameraRig(camera, controls, renderer.domElement, viewState);
  const gui = new GUI({
    autoPlace: false,
    container: guiHost,
    title: "Debug",
    width: 284,
  });
  const setWireframe = (enabled: boolean) => {
    setSceneWireframe(scene, enabled);
    runtime.setWireframe?.(enabled);
  };
  const viewFolder = gui.addFolder("View");
  viewFolder.add(viewState, "wireframe").name("wireframe").onChange(setWireframe);
  viewFolder
    .add(viewState, "cameraMode", { Orbit: "orbit", FPS: "fps" })
    .name("camera")
    .onChange((value: CameraMode) => cameraRig.setMode(value));
  viewFolder.add(viewState, "moveSpeed", 1, 22, 0.25).name("move speed");
  viewFolder.add(viewState, "lookSpeed", 0.35, 2.4, 0.05).name("look speed");
  runtime.setupGui?.({
    gui,
    scene,
    camera,
    renderer,
    controls,
    cameraRig,
    viewState,
    setWireframe,
  });
  setWireframe(viewState.wireframe);

  const resize = () => {
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  return {
    card,
    host,
    scene,
    camera,
    renderer,
    controls,
    resizeObserver,
    cameraRig,
    gui,
    fpsLabel,
    fpsSmoothed: 0,
    failed: false,
    ...runtime,
  };
}

function disposeSceneResources(meshes: THREE.Object3D[]): void {
  for (const mesh of meshes) {
    if ("geometry" in mesh && mesh.geometry instanceof THREE.BufferGeometry) {
      mesh.geometry.dispose();
    }

    if ("material" in mesh) {
      const material = mesh.material;

      if (Array.isArray(material)) {
        for (const item of material) {
          item.dispose();
        }
      } else if (material instanceof THREE.Material) {
        material.dispose();
      }
    }
  }
}
