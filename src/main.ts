import "./style.css";

import * as THREE from "three/webgpu";
import WebGPU from "three/addons/capabilities/WebGPU.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import GUI from "three/addons/libs/lil-gui.module.min.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SimplexNoise } from "three/addons/math/SimplexNoise.js";
import { Fn, color, cos, instanceIndex, instancedArray, localId, mix, normalLocal, positionLocal, sin, textureStore, time, uniform, uvec2, uv, vec3, vec4, workgroupId } from "three/tsl";

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
  handleWindowResize: () => void;
  guiFieldObserver: MutationObserver;
  cameraRig: ExampleCameraRig;
  gui: GUI;
  wireframeController: ReturnType<typeof createSceneWireframeController>;
  fpsLabel: HTMLDivElement;
  fpsSmoothed: number;
  failed: boolean;
  sizeDirty: boolean;
  viewportWidth: number;
  viewportHeight: number;
  syncSize: () => void;
};

const FALLBACK_RENDERER_BUDGET = 4;
const FALLBACK_PREWARM_MARGIN = 420;

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

function createSceneWireframeController(root: THREE.Object3D) {
  const meshOverlays = new Map<THREE.Mesh, MeshWireframeOverlay>();
  const skinnedOverlays = new Map<THREE.SkinnedMesh, SkinnedWireframeOverlay>();
  let enabled = false;

  const sync = () => {
    root.traverse((object) => {
      if ((object.userData as { skipGlobalWireframe?: boolean }).skipGlobalWireframe) {
        return;
      }

      if ((object as THREE.Object3D & { isSkinnedMesh?: boolean }).isSkinnedMesh) {
        const skinnedMesh = object as THREE.SkinnedMesh;

        if (!skinnedOverlays.has(skinnedMesh)) {
          const overlay = createSkinnedWireframeOverlay(skinnedMesh);

          if (overlay) {
            overlay.setVisible(enabled);
            skinnedOverlays.set(skinnedMesh, overlay);
          }
        }

        return;
      }

      if (!(object instanceof THREE.Mesh)) {
        return;
      }

      if (!meshOverlays.has(object)) {
        const overlay = createMeshWireframeOverlay(object);

        if (overlay) {
          overlay.setVisible(enabled);
          meshOverlays.set(object, overlay);
        }
      }
    });
  };

  return {
    setEnabled: (nextEnabled: boolean) => {
      enabled = nextEnabled;
      sync();

      for (const overlay of meshOverlays.values()) {
        overlay.setVisible(enabled);
      }

      for (const overlay of skinnedOverlays.values()) {
        overlay.setVisible(enabled);
      }
    },
    update: () => {
      if (!enabled) {
        return;
      }

      sync();

      for (const overlay of skinnedOverlays.values()) {
        overlay.update();
      }
    },
    dispose: () => {
      for (const overlay of meshOverlays.values()) {
        overlay.dispose();
      }

      for (const overlay of skinnedOverlays.values()) {
        overlay.dispose();
      }

      meshOverlays.clear();
      skinnedOverlays.clear();
    },
  };
}

function slugifyLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function ensureGuiFieldAttributes(root: HTMLElement, prefix: string): void {
  const fields = root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea");

  fields.forEach((field, index) => {
    const identifier = `${prefix}-field-${index + 1}`;

    if (!field.name) {
      field.name = identifier;
    }

    if (!field.id) {
      field.id = identifier;
    }
  });
}

function watchGuiFieldAttributes(root: HTMLElement, prefix: string): MutationObserver {
  ensureGuiFieldAttributes(root, prefix);

  const observer = new MutationObserver(() => {
    ensureGuiFieldAttributes(root, prefix);
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
  });

  return observer;
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
  private readonly touchPoints = new Map<number, THREE.Vector2>();
  private pinchDistance = 0;
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
    this.domElement.addEventListener("wheel", this.handleWheel, { passive: false });
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerUp);
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
    this.domElement.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerUp);
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

  private moveAlongView(amount: number): void {
    this.camera.getWorldDirection(this.forward).normalize();
    this.camera.position.addScaledVector(this.forward, amount);
  }

  private applyTouchZoom(distanceDelta: number): void {
    if (Math.abs(distanceDelta) < 0.5) {
      return;
    }

    const zoomAmount = distanceDelta * 0.01;

    if (this.mode === "orbit") {
      const offset = this.camera.position.clone().sub(this.controls.target);
      const distance = offset.length();
      const nextDistance = THREE.MathUtils.clamp(distance - zoomAmount, this.controls.minDistance, this.controls.maxDistance);

      if (Math.abs(nextDistance - distance) < 0.0001) {
        return;
      }

      offset.setLength(nextDistance);
      this.camera.position.copy(this.controls.target).add(offset);
      this.controls.update();
      this.syncOrbitDistance();
      return;
    }

    this.moveAlongView(zoomAmount * this.viewState.moveSpeed * 0.35);
  }

  private getTouchDistance(): number {
    const points = [...this.touchPoints.values()];

    if (points.length < 2) {
      return 0;
    }

    return points[0].distanceTo(points[1]);
  }

  private handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private handlePointerDown = (event: PointerEvent): void => {
    this.domElement.focus();

    if (event.pointerType === "touch") {
      this.touchPoints.set(event.pointerId, new THREE.Vector2(event.clientX, event.clientY));

      if (this.touchPoints.size >= 2) {
        this.pinchDistance = this.getTouchDistance();
      }

      return;
    }

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
    if (event.pointerType === "touch" && this.touchPoints.has(event.pointerId)) {
      this.touchPoints.get(event.pointerId)?.set(event.clientX, event.clientY);

      if (this.touchPoints.size >= 2) {
        const nextDistance = this.getTouchDistance();

        if (this.pinchDistance > 0) {
          this.applyTouchZoom(nextDistance - this.pinchDistance);
        }

        this.pinchDistance = nextDistance;
      }

      return;
    }

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
    if (event.pointerType === "touch") {
      this.touchPoints.delete(event.pointerId);
      this.pinchDistance = this.touchPoints.size >= 2 ? this.getTouchDistance() : 0;
      return;
    }

    if (this.pointerId !== event.pointerId) {
      return;
    }

    if (this.domElement.hasPointerCapture(event.pointerId)) {
      this.domElement.releasePointerCapture(event.pointerId);
    }

    this.pointerId = null;
    this.pointerButton = -1;
  };

  private handleWheel = (event: WheelEvent): void => {
    if (this.mode !== "fps") {
      return;
    }

    event.preventDefault();
    this.moveAlongView(-event.deltaY * 0.0025 * this.viewState.moveSpeed);
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
    title: "Lighting Studio",
    summary: "Use one PBR scene and a preset dropdown to isolate ambient, hemisphere, directional, point, and spot lighting without jumping to a second card.",
    notes:
      "This is the first place roughness, metalness, specular highlights, and shadows really start talking to each other. Flip the setup dropdown to solo each light type, then turn helpers on to see why the shading changes.",
    tags: ["Light presets", "MeshStandardMaterial", "Helpers"],
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
      point.castShadow = true;

      const pointOrb = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 18, 18),
        new THREE.MeshBasicMaterial({ color: "#ffd0c0" }),
      );
      point.add(pointOrb);

      const pointRig = new THREE.Group();
      pointRig.add(point);
      point.position.set(2.8, 2.8, 0);

      const spot = new THREE.SpotLight("#7ad6ff", 26, 18, Math.PI / 7, 0.36, 1.2);
      spot.position.set(-4.8, 5.8, 4.4);
      const spotlightTarget = new THREE.Object3D();
      spotlightTarget.position.set(0, 1.55, 0);
      spot.target = spotlightTarget;
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);

      const hemisphereHelper = new THREE.HemisphereLightHelper(hemi, 0.65);
      const directionalHelper = new THREE.DirectionalLightHelper(directional, 0.85, "#ffe2ba");
      const pointHelper = new THREE.PointLightHelper(point, 0.34, "#ffbba5");
      const spotHelper = new THREE.SpotLightHelper(spot, "#89ddff");
      hemisphereHelper.visible = false;
      directionalHelper.visible = false;
      pointHelper.visible = false;
      spotHelper.visible = false;

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
        hemisphereHelper,
        directionalHelper,
        pointHelper,
        spotHelper,
      );

      const lightPresets = {
        balanced: {
          ambient: true,
          hemisphere: true,
          directional: true,
          point: true,
          spot: false,
        },
        ambient: {
          ambient: true,
          hemisphere: false,
          directional: false,
          point: false,
          spot: false,
        },
        hemisphere: {
          ambient: false,
          hemisphere: true,
          directional: false,
          point: false,
          spot: false,
        },
        directional: {
          ambient: false,
          hemisphere: false,
          directional: true,
          point: false,
          spot: false,
        },
        point: {
          ambient: false,
          hemisphere: false,
          directional: false,
          point: true,
          spot: false,
        },
        spot: {
          ambient: false,
          hemisphere: false,
          directional: false,
          point: false,
          spot: true,
        },
        full: {
          ambient: true,
          hemisphere: true,
          directional: true,
          point: true,
          spot: true,
        },
      } as const;

      const state = {
        preset: "balanced" as keyof typeof lightPresets,
        ambient: ambient.intensity,
        hemisphere: hemi.intensity,
        directional: directional.intensity,
        point: point.intensity,
        spot: spot.intensity,
        helpers: false,
        animate: true,
      };

      const syncLighting = () => {
        const preset = lightPresets[state.preset];
        ambient.intensity = state.ambient;
        hemi.intensity = state.hemisphere;
        directional.intensity = state.directional;
        point.intensity = state.point;
        spot.intensity = state.spot;

        ambient.visible = preset.ambient;
        hemi.visible = preset.hemisphere;
        directional.visible = preset.directional;
        point.visible = preset.point;
        spot.visible = preset.spot;
        hemisphereHelper.visible = state.helpers && preset.hemisphere;
        directionalHelper.visible = state.helpers && preset.directional;
        pointHelper.visible = state.helpers && preset.point;
        spotHelper.visible = state.helpers && preset.spot;
      };

      syncLighting();

      return {
        update: (elapsed) => {
          if (state.animate) {
            heroGroup.rotation.y = elapsed * 0.22;
            pointRig.rotation.y = elapsed * 0.58;
            point.position.y = 2.35 + Math.sin(elapsed * 1.3) * 0.55;
            spot.position.x = Math.cos(elapsed * 0.36) * 5.2;
            spot.position.z = Math.sin(elapsed * 0.36) * 5.2;
          }

          knot.rotation.x = elapsed * 0.38;
          knot.rotation.y = elapsed * 0.66;
          glossyBox.rotation.y = -elapsed * 0.48;
          matteSphere.position.y = 1.45 + Math.sin(elapsed * 1.2) * 0.12;
          hemisphereHelper.update();
          directionalHelper.update();
          pointHelper.update();
          spotHelper.update();
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Lighting");
          folder
            .add(state, "preset", {
              Balanced: "balanced",
              "Ambient only": "ambient",
              "Hemisphere only": "hemisphere",
              "Directional only": "directional",
              "Point only": "point",
              "Spot only": "spot",
              "All types": "full",
            })
            .name("setup")
            .onChange(syncLighting);
          folder.add(state, "helpers").name("helpers").onChange(syncLighting);
          folder
            .add(state, "ambient", 0, 1.5, 0.01)
            .name("ambient")
            .onChange(syncLighting);
          folder
            .add(state, "hemisphere", 0, 2, 0.01)
            .name("hemisphere")
            .onChange(syncLighting);
          folder
            .add(state, "directional", 0, 4, 0.01)
            .name("directional")
            .onChange(syncLighting);
          folder
            .add(state, "point", 0, 60, 0.1)
            .name("point")
            .onChange(syncLighting);
          folder
            .add(state, "spot", 0, 40, 0.1)
            .name("spot")
            .onChange(syncLighting);
          folder.add(state, "animate").name("animate");
        },
        dispose: () => {
          disposeSceneResources([
            floor,
            pedestal,
            knot,
            glossyBox,
            matteSphere,
            pointOrb,
            hemisphereHelper,
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
    step: "Step 04B",
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
    step: "Step 04C",
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

      const shadowFocus = new THREE.Object3D();
      shadowFocus.position.set(0.2, 0.34, -1.2);

      const key = new THREE.DirectionalLight("#fff7ec", studioState.keyIntensity);
      key.position.set(6.8, 9.2, -6.2);
      key.target = shadowFocus;
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.left = -10;
      key.shadow.camera.right = 10;
      key.shadow.camera.top = 10;
      key.shadow.camera.bottom = -10;
      key.shadow.bias = -0.00012;
      key.shadow.normalBias = 0.1;

      const shadowSpot = new THREE.SpotLight("#fff4dc", studioState.keyIntensity * 7.5, 28, Math.PI / 5, 0.34, 1.1);
      shadowSpot.position.set(-5.4, 7.8, -3.8);
      shadowSpot.target = shadowFocus;
      shadowSpot.castShadow = true;
      shadowSpot.shadow.mapSize.set(2048, 2048);
      shadowSpot.shadow.bias = -0.00018;
      shadowSpot.shadow.normalBias = 0.08;
      shadowSpot.shadow.camera.near = 1;
      shadowSpot.shadow.camera.far = 26;

      const fill = new THREE.HemisphereLight("#c1d9ff", "#66758f", studioState.fillIntensity);
      const rim = new THREE.DirectionalLight("#c7d7ff", studioState.rimIntensity);
      rim.position.set(-4.4, 5.6, 6.2);

      const accentRig = new THREE.Group();
      const accent = new THREE.PointLight("#ffd9b7", studioState.accentIntensity, 18, 2);
      accent.position.set(0, 4.2, 2.6);
      const accentMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 16, 16),
        new THREE.MeshBasicMaterial({ color: "#fff0d9" }),
      );
      accent.add(accentMarker);
      accentRig.add(accent);

      scene.add(stage, stageTop, shadowFocus, key, shadowSpot, fill, rim, accentRig);

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
          key.position.x = Math.cos(elapsed * 0.18) * 7.4;
          key.position.z = -5.6 + Math.sin(elapsed * 0.18) * 2.4;
          shadowSpot.position.x = -5.4 + Math.cos(elapsed * 0.24) * 1.4;
          shadowSpot.position.z = -3.8 + Math.sin(elapsed * 0.24) * 1.2;
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
          disposeSceneResources([shadowFocus]);

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
      blob.userData.skipGlobalWireframe = true;
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
      shell.userData.skipGlobalWireframe = true;
      shell.visible = false;
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
        setWireframe: (enabled) => {
          shell.visible = enabled;
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
        .loadAsync(`${import.meta.env.BASE_URL}models/RobotExpressive.glb`)
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
    title: "Storage Texture Pipeline",
    summary: "Follow one GPU-authored texture through three clear stages: compute writes it, a GPU copy makes it sampleable, and multiple materials read the same result.",
    notes:
      "Read this one left-to-right. The monitor is the compute-authored texture, the amber transfer node represents `copyTextureToTexture()`, and the three labeled consumers on the right all sample that same texture with different material models.",
    tags: ["StorageTexture", "textureStore", "GPU texture copy", "Shared sampled texture"],
    cameraPosition: [8.8, 4.8, 9.4],
    target: [0.8, 1.8, -0.2],
    create: ({ scene, renderer, camera }) => {
      scene.background = new THREE.Color("#07111e");

      const storageState = {
        showLabels: true,
        showFlow: true,
        spinConsumers: true,
        textureGain: 1.08,
      };

      const labelTextures: THREE.Texture[] = [];
      const billboardMeshes: THREE.Mesh[] = [];

      const createBillboardLabel = (title: string, subtitle: string, accent: string, width: number, height: number): THREE.Mesh => {
        const canvas = document.createElement("canvas");
        canvas.width = 768;
        canvas.height = 220;

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Could not create 2D canvas context");
        }

        context.fillStyle = "rgba(7, 17, 30, 0.88)";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = accent;
        context.fillRect(0, 0, canvas.width, 18);
        context.strokeStyle = accent;
        context.globalAlpha = 0.8;
        context.lineWidth = 4;
        context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
        context.globalAlpha = 1;
        context.fillStyle = accent;
        context.font = "700 42px Segoe UI, sans-serif";
        context.fillText(title, 34, 78);
        context.fillStyle = "#d7ebff";
        context.font = "500 28px Segoe UI, sans-serif";
        context.fillText(subtitle, 34, 136);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        labelTextures.push(texture);

        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        });

        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        mesh.renderOrder = 3;
        mesh.userData.skipGlobalWireframe = true;
        billboardMeshes.push(mesh);
        return mesh;
      };

      const createTagLabel = (text: string, accent: string, width: number, height: number): THREE.Mesh => {
        const canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 120;

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Could not create 2D canvas context");
        }

        context.fillStyle = "rgba(7, 17, 30, 0.9)";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.strokeStyle = accent;
        context.globalAlpha = 0.86;
        context.lineWidth = 4;
        context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
        context.globalAlpha = 1;
        context.fillStyle = accent;
        context.font = "600 30px Segoe UI, sans-serif";
        context.textAlign = "center";
        context.fillText(text, canvas.width / 2, 72);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        labelTextures.push(texture);

        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        });

        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        mesh.renderOrder = 3;
        mesh.userData.skipGlobalWireframe = true;
        billboardMeshes.push(mesh);
        return mesh;
      };

      const ambient = new THREE.AmbientLight("#8fb7ff", 0.42);
      const sky = new THREE.HemisphereLight("#63b7ff", "#081018", 0.48);
      const key = new THREE.SpotLight("#dff7ff", 26, 26, Math.PI / 5.4, 0.34, 1.2);
      key.position.set(3.4, 7.4, 5.6);
      key.target.position.set(1.6, 1.2, 0);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.bias = -0.00012;
      key.shadow.normalBias = 0.09;
      const rim = new THREE.DirectionalLight("#ffd7a2", 1.1);
      rim.position.set(-4, 5.5, -4);
      const fill = new THREE.PointLight("#58d8ff", 8, 12, 2);
      fill.position.set(-2.2, 2.8, 1.2);
      scene.add(ambient, sky, key, key.target, rim, fill);

      const stageBase = new THREE.Mesh(
        new THREE.BoxGeometry(11.4, 0.34, 5.6),
        new THREE.MeshStandardMaterial({
          color: "#091725",
          roughness: 0.96,
          metalness: 0.04,
        }),
      );
      stageBase.position.set(0.45, -0.54, 0.05);
      stageBase.receiveShadow = true;

      const stageDeck = new THREE.Mesh(
        new THREE.BoxGeometry(10.9, 0.08, 5.1),
        new THREE.MeshStandardMaterial({
          color: "#122439",
          roughness: 0.9,
          metalness: 0.05,
        }),
      );
      stageDeck.position.set(0.45, -0.31, 0.05);
      stageDeck.receiveShadow = true;

      const writerPad = new THREE.Mesh(
        new THREE.BoxGeometry(2.9, 0.08, 2.35),
        new THREE.MeshStandardMaterial({
          color: "#14314b",
          roughness: 0.78,
          metalness: 0.08,
        }),
      );
      writerPad.position.set(-3.35, -0.23, 0.05);
      writerPad.receiveShadow = true;

      const copyPad = new THREE.Mesh(
        new THREE.BoxGeometry(2.15, 0.08, 2.2),
        new THREE.MeshStandardMaterial({
          color: "#352211",
          roughness: 0.82,
          metalness: 0.1,
        }),
      );
      copyPad.position.set(0.3, -0.23, 0.05);
      copyPad.receiveShadow = true;

      const readerPad = new THREE.Mesh(
        new THREE.BoxGeometry(4.35, 0.08, 3.85),
        new THREE.MeshStandardMaterial({
          color: "#12263d",
          roughness: 0.84,
          metalness: 0.07,
        }),
      );
      readerPad.position.set(3.45, -0.23, 0.05);
      readerPad.receiveShadow = true;

      scene.add(stageBase, stageDeck, writerPad, copyPad, readerPad);

      const textureSize = 256;
      const storageTexture = new THREE.StorageTexture(textureSize, textureSize);
      storageTexture.colorSpace = THREE.NoColorSpace;

      const sampledTarget = new THREE.RenderTarget(textureSize, textureSize, {
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      const sampledTexture = sampledTarget.texture;

      const computeNode = Fn(() => {
        const px = instanceIndex.mod(textureSize);
        const py = instanceIndex.div(textureSize);
        const indexUV = uvec2(px, py);
        const nx = px.toFloat().div(textureSize).mul(2).sub(1);
        const ny = py.toFloat().div(textureSize).mul(2).sub(1);
        const radial = nx.mul(nx).add(ny.mul(ny));
        const rings = sin(radial.mul(32).sub(time.mul(3.2))).mul(0.5).add(0.5);
        const stripesX = sin(nx.mul(16).add(time.mul(1.1))).mul(0.5).add(0.5);
        const stripesY = cos(ny.mul(13).sub(time.mul(0.9))).mul(0.5).add(0.5);
        const diagonal = sin(nx.mul(7).add(ny.mul(11)).add(time.mul(1.7))).mul(0.5).add(0.5);
        const fineGrid = sin(nx.mul(24)).mul(sin(ny.mul(24))).mul(0.5).add(0.5);
        const mask = radial.mul(-0.92).add(1.08).clamp();
        const coolEnergy = rings.mul(0.42).add(stripesX.mul(0.22)).add(stripesY.mul(0.2)).add(diagonal.mul(0.16)).mul(mask).clamp();
        const warmEnergy = rings.mul(diagonal).mul(0.68).add(stripesY.mul(0.16)).mul(mask).clamp();
        const coolColor = mix(color("#07111d"), color("#67d8ff"), coolEnergy.add(fineGrid.mul(0.18)).clamp());
        const finalColor = mix(coolColor, color("#ffc97d"), warmEnergy.mul(0.9));

        textureStore(storageTexture, indexUV, vec4(finalColor, 1));
      })().compute(textureSize * textureSize, [64]);

      const writerGroup = new THREE.Group();
      writerGroup.position.set(-3.35, 0, 0.05);

      const writerModule = new THREE.Mesh(
        new THREE.BoxGeometry(1.95, 0.28, 1.08),
        new THREE.MeshStandardMaterial({
          color: "#11263a",
          roughness: 0.72,
          metalness: 0.22,
          emissive: "#0d2030",
          emissiveIntensity: 0.32,
        }),
      );
      writerModule.position.set(0, -0.05, 0.78);
      writerModule.castShadow = true;
      writerModule.receiveShadow = true;

      const monitorStand = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.28, 1.55, 28),
        new THREE.MeshStandardMaterial({
          color: "#142539",
          roughness: 0.8,
          metalness: 0.18,
        }),
      );
      monitorStand.position.y = 0.78;
      monitorStand.castShadow = true;

      const monitorFrame = new THREE.Mesh(
        new THREE.BoxGeometry(3.15, 2.18, 0.24),
        new THREE.MeshStandardMaterial({
          color: "#173149",
          roughness: 0.48,
          metalness: 0.42,
          emissive: "#0d2440",
          emissiveIntensity: 0.35,
        }),
      );
      monitorFrame.position.set(0, 2.08, 0.02);
      monitorFrame.castShadow = true;

      const monitorScreen = new THREE.Mesh(
        new THREE.PlaneGeometry(2.72, 1.74, 1, 1),
        new THREE.MeshBasicMaterial({
          map: sampledTexture,
          color: "#ffffff",
          toneMapped: false,
        }),
      );
      monitorScreen.position.set(0, 2.08, 0.15);
      monitorScreen.renderOrder = 1;
      monitorScreen.userData.skipGlobalWireframe = true;

      const monitorGlow = new THREE.Mesh(
        new THREE.PlaneGeometry(2.98, 1.98, 1, 1),
        new THREE.MeshBasicMaterial({
          map: sampledTexture,
          color: "#7edcff",
          transparent: true,
          opacity: 0.18,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      monitorGlow.position.set(0, 2.08, 0.08);
      monitorGlow.userData.skipGlobalWireframe = true;

      writerGroup.add(writerModule, monitorStand, monitorFrame, monitorGlow, monitorScreen);

      const copyGroup = new THREE.Group();
      copyGroup.position.set(0.3, 0, 0.05);

      const copyPedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 1.02, 0.24, 40),
        new THREE.MeshStandardMaterial({
          color: "#32200f",
          roughness: 0.82,
          metalness: 0.08,
        }),
      );
      copyPedestal.position.y = 0.04;
      copyPedestal.receiveShadow = true;

      const copyModule = new THREE.Mesh(
        new THREE.BoxGeometry(1.52, 1.06, 0.96),
        new THREE.MeshStandardMaterial({
          color: "#5e3920",
          roughness: 0.36,
          metalness: 0.22,
          emissive: "#9a5c22",
          emissiveIntensity: 0.36,
        }),
      );
      copyModule.position.set(0, 0.82, 0.04);
      copyModule.castShadow = true;
      copyModule.receiveShadow = true;

      const copyPreviewFrame = new THREE.Mesh(
        new THREE.BoxGeometry(1.08, 0.82, 0.08),
        new THREE.MeshStandardMaterial({
          color: "#3a2411",
          roughness: 0.38,
          metalness: 0.34,
          emissive: "#6d441c",
          emissiveIntensity: 0.28,
        }),
      );
      copyPreviewFrame.position.set(0, 0.92, 0.51);
      copyPreviewFrame.castShadow = true;

      const copyPreview = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9, 0.64, 1, 1),
        new THREE.MeshBasicMaterial({
          map: sampledTexture,
          color: "#ffd8a6",
          toneMapped: false,
        }),
      );
      copyPreview.position.set(0, 0.92, 0.57);
      copyPreview.renderOrder = 1;
      copyPreview.userData.skipGlobalWireframe = true;

      copyGroup.add(copyPedestal, copyModule, copyPreviewFrame, copyPreview);

      const distributionNode = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 18, 16),
        new THREE.MeshStandardMaterial({
          color: "#ffe1af",
          roughness: 0.24,
          metalness: 0.18,
          emissive: "#ff9d3b",
          emissiveIntensity: 0.58,
        }),
      );
      distributionNode.position.set(1.85, 1.3, 0.06);
      distributionNode.castShadow = true;

      const spherePedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(0.44, 0.52, 0.28, 28),
        new THREE.MeshStandardMaterial({
          color: "#183046",
          roughness: 0.82,
          metalness: 0.06,
        }),
      );
      spherePedestal.position.set(2.55, -0.06, 0.86);
      spherePedestal.receiveShadow = true;

      const sampleSphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.72, 48, 34),
        new THREE.MeshPhysicalMaterial({
          color: "#f9fdff",
          map: sampledTexture,
          emissive: new THREE.Color("#1d5c92"),
          emissiveMap: sampledTexture,
          emissiveIntensity: 0.58,
          roughness: 0.18,
          metalness: 0.08,
          clearcoat: 0.42,
          clearcoatRoughness: 0.2,
        }),
      );
      sampleSphere.position.set(2.55, 0.68, 0.86);
      sampleSphere.castShadow = true;
      sampleSphere.receiveShadow = true;

      const blockPedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(0.46, 0.54, 0.28, 28),
        new THREE.MeshStandardMaterial({
          color: "#183046",
          roughness: 0.82,
          metalness: 0.06,
        }),
      );
      blockPedestal.position.set(4.1, -0.06, 0.08);
      blockPedestal.receiveShadow = true;

      const sampleBlock = new THREE.Mesh(
        new THREE.BoxGeometry(1.02, 1.02, 1.02),
        new THREE.MeshStandardMaterial({
          color: "#f1e3cb",
          map: sampledTexture,
          emissive: "#304c6c",
          emissiveMap: sampledTexture,
          emissiveIntensity: 0.24,
          roughness: 0.56,
          metalness: 0.05,
        }),
      );
      sampleBlock.position.set(4.1, 0.64, 0.08);
      sampleBlock.castShadow = true;
      sampleBlock.receiveShadow = true;

      const cardStand = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.1, 1.18, 18),
        new THREE.MeshStandardMaterial({
          color: "#183046",
          roughness: 0.76,
          metalness: 0.14,
        }),
      );
      cardStand.position.set(3.28, 0.28, -1.08);
      cardStand.castShadow = true;

      const cardFrame = new THREE.Mesh(
        new THREE.BoxGeometry(1.48, 1.38, 0.08),
        new THREE.MeshStandardMaterial({
          color: "#20354d",
          roughness: 0.58,
          metalness: 0.22,
          emissive: "#17385b",
          emissiveIntensity: 0.26,
        }),
      );
      cardFrame.position.set(3.28, 1.26, -1.08);
      cardFrame.castShadow = true;

      const sampleCard = new THREE.Mesh(
        new THREE.PlaneGeometry(1.24, 1.14, 1, 1),
        new THREE.MeshBasicMaterial({
          map: sampledTexture,
          color: "#ffffff",
          toneMapped: false,
        }),
      );
      sampleCard.position.set(3.28, 1.26, -1.03);
      sampleCard.renderOrder = 1;
      sampleCard.userData.skipGlobalWireframe = true;

      const flowGroup = new THREE.Group();
      const flowMaterials: THREE.MeshStandardMaterial[] = [];
      const flowPulseMaterials: THREE.MeshBasicMaterial[] = [];
      const flowMeshes: THREE.Mesh[] = [];
      const flowPulses: Array<{
        curve: THREE.CatmullRomCurve3;
        mesh: THREE.Mesh;
        speed: number;
        offset: number;
      }> = [];

      const addFlowLink = (
        points: THREE.Vector3[],
        radius: number,
        tubeColor: string,
        pulseColor: string,
        speed: number,
        offset: number,
      ) => {
        const curve = new THREE.CatmullRomCurve3(points);
        const tubeMaterial = new THREE.MeshStandardMaterial({
          color: tubeColor,
          emissive: tubeColor,
          emissiveIntensity: 0.82,
          roughness: 0.24,
          metalness: 0.08,
        });
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, radius, 12, false), tubeMaterial);
        tube.userData.skipGlobalWireframe = true;
        flowGroup.add(tube);
        flowMaterials.push(tubeMaterial);
        flowMeshes.push(tube);

        const pulseMaterial = new THREE.MeshBasicMaterial({
          color: pulseColor,
          toneMapped: false,
        });
        const pulse = new THREE.Mesh(new THREE.SphereGeometry(radius * 2.4, 14, 12), pulseMaterial);
        pulse.userData.skipGlobalWireframe = true;
        flowGroup.add(pulse);
        flowPulseMaterials.push(pulseMaterial);
        flowPulses.push({ curve, mesh: pulse, speed, offset });
      };

      addFlowLink(
        [
          new THREE.Vector3(-1.98, 2.08, 0.16),
          new THREE.Vector3(-1.1, 2.18, 0.28),
          new THREE.Vector3(-0.28, 1.78, 0.22),
          new THREE.Vector3(0.02, 1.38, 0.22),
        ],
        0.042,
        "#ffd18a",
        "#fff1cb",
        0.16,
        0.02,
      );
      addFlowLink(
        [
          new THREE.Vector3(0.62, 1.3, 0.22),
          new THREE.Vector3(1.05, 1.36, 0.2),
          new THREE.Vector3(1.42, 1.34, 0.14),
          new THREE.Vector3(1.85, 1.3, 0.08),
        ],
        0.04,
        "#ffb457",
        "#fff1cb",
        0.19,
        0.24,
      );
      addFlowLink(
        [
          new THREE.Vector3(1.98, 1.28, 0.08),
          new THREE.Vector3(2.18, 1.28, 0.34),
          new THREE.Vector3(2.3, 1.08, 0.58),
          new THREE.Vector3(2.5, 0.86, 0.82),
        ],
        0.03,
        "#8ddfff",
        "#dcf7ff",
        0.22,
        0.4,
      );
      addFlowLink(
        [
          new THREE.Vector3(2.02, 1.28, 0.06),
          new THREE.Vector3(2.6, 1.3, 0.08),
          new THREE.Vector3(3.34, 1.16, 0.08),
          new THREE.Vector3(4.0, 0.86, 0.08),
        ],
        0.028,
        "#8ddfff",
        "#dcf7ff",
        0.2,
        0.62,
      );
      addFlowLink(
        [
          new THREE.Vector3(1.96, 1.28, 0.02),
          new THREE.Vector3(2.34, 1.58, -0.28),
          new THREE.Vector3(2.8, 1.58, -0.72),
          new THREE.Vector3(3.2, 1.34, -1.02),
        ],
        0.028,
        "#8ddfff",
        "#dcf7ff",
        0.18,
        0.78,
      );

      const writerLabel = createBillboardLabel("1. Compute Authors Pixels", "StorageTexture write pass", "#6ce2ff", 3.2, 0.92);
      writerLabel.position.set(-3.38, 4.12, 0.26);
      const copyLabel = createBillboardLabel("2. GPU Copy Makes It Sampleable", "copyTextureToTexture()", "#ffbe68", 3.4, 0.92);
      copyLabel.position.set(0.32, 3.22, 0.28);
      const readerLabel = createBillboardLabel("3. Materials Sample The Same Texture", "three consumers, three shading models", "#9ee6c9", 3.45, 0.92);
      readerLabel.position.set(3.33, 3.55, 0.18);

      const sphereTag = createTagLabel("MeshPhysicalMaterial", "#8ddfff", 1.85, 0.36);
      sphereTag.position.set(2.55, 1.76, 0.86);
      const blockTag = createTagLabel("MeshStandardMaterial", "#ffcf8f", 1.85, 0.36);
      blockTag.position.set(4.1, 1.68, 0.08);
      const cardTag = createTagLabel("MeshBasicMaterial", "#b8f0d9", 1.7, 0.36);
      cardTag.position.set(3.28, 2.28, -1.08);

      scene.add(
        writerGroup,
        copyGroup,
        distributionNode,
        spherePedestal,
        sampleSphere,
        blockPedestal,
        sampleBlock,
        cardStand,
        cardFrame,
        sampleCard,
        flowGroup,
        writerLabel,
        copyLabel,
        readerLabel,
        sphereTag,
        blockTag,
        cardTag,
      );

      const monitorMaterials = [
        monitorScreen.material as THREE.MeshBasicMaterial,
        monitorGlow.material as THREE.MeshBasicMaterial,
        copyPreview.material as THREE.MeshBasicMaterial,
        sampleCard.material as THREE.MeshBasicMaterial,
      ];
      const consumerMaterials = [
        sampleSphere.material as THREE.MeshPhysicalMaterial,
        sampleBlock.material as THREE.MeshStandardMaterial,
      ];
      const pulsePoint = new THREE.Vector3();

      const syncStorage = () => {
        const gainColor = new THREE.Color().setScalar(storageState.textureGain);
        const warmGain = new THREE.Color("#ffd8a6").multiplyScalar(0.72 + storageState.textureGain * 0.2);

        for (const label of billboardMeshes) {
          label.visible = storageState.showLabels;
        }

        flowGroup.visible = storageState.showFlow;
        monitorMaterials[0].color.copy(gainColor);
        monitorMaterials[1].color.set("#74d8ff").multiplyScalar(0.54 + storageState.textureGain * 0.18);
        monitorMaterials[2].color.copy(warmGain);
        monitorMaterials[3].color.copy(gainColor);
        consumerMaterials[0].emissiveIntensity = 0.34 + storageState.textureGain * 0.24;
        consumerMaterials[1].emissiveIntensity = 0.12 + storageState.textureGain * 0.12;

        for (const material of flowMaterials) {
          material.emissiveIntensity = 0.52 + storageState.textureGain * 0.28;
        }

        (distributionNode.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.34 + storageState.textureGain * 0.3;
        (copyModule.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.2 + storageState.textureGain * 0.18;
        (copyPreviewFrame.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.16 + storageState.textureGain * 0.14;
        (cardFrame.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.12 + storageState.textureGain * 0.1;
      };

      syncStorage();

      return {
        update: (elapsed) => {
          renderer.compute(computeNode);
          renderer.copyTextureToTexture(storageTexture, sampledTexture);

          if (storageState.spinConsumers) {
            sampleSphere.rotation.y = elapsed * 0.4;
            sampleSphere.rotation.x = Math.sin(elapsed * 0.65) * 0.08;
            sampleBlock.rotation.y = elapsed * 0.28;
            const cardYaw = -0.38 + Math.sin(elapsed * 0.45) * 0.08;
            cardFrame.rotation.y = cardYaw;
            sampleCard.rotation.y = cardYaw;
          }

          for (const label of billboardMeshes) {
            label.lookAt(camera.position.x, camera.position.y, camera.position.z);
            label.rotateY(Math.PI);
          }

          for (const pulse of flowPulses) {
            pulse.curve.getPointAt((elapsed * pulse.speed + pulse.offset) % 1, pulsePoint);
            pulse.mesh.position.copy(pulsePoint);
            pulse.mesh.scale.setScalar(0.92 + Math.sin(elapsed * 3.4 + pulse.offset * 10) * 0.12);
          }
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Pipeline");
          folder.add(storageState, "showLabels").name("show labels").onChange(syncStorage);
          folder.add(storageState, "showFlow").name("show flow").onChange(syncStorage);
          folder.add(storageState, "spinConsumers").name("spin consumers");
          folder.add(storageState, "textureGain", 0.65, 1.8, 0.01).name("texture gain").onChange(syncStorage);
        },
        dispose: () => {
          computeNode.dispose();
          storageTexture.dispose();
          sampledTarget.dispose();
          stageBase.geometry.dispose();
          (stageBase.material as THREE.Material).dispose();
          stageDeck.geometry.dispose();
          (stageDeck.material as THREE.Material).dispose();
          writerPad.geometry.dispose();
          (writerPad.material as THREE.Material).dispose();
          copyPad.geometry.dispose();
          (copyPad.material as THREE.Material).dispose();
          readerPad.geometry.dispose();
          (readerPad.material as THREE.Material).dispose();
          writerModule.geometry.dispose();
          (writerModule.material as THREE.Material).dispose();
          monitorStand.geometry.dispose();
          (monitorStand.material as THREE.Material).dispose();
          monitorFrame.geometry.dispose();
          (monitorFrame.material as THREE.Material).dispose();
          monitorScreen.geometry.dispose();
          (monitorScreen.material as THREE.Material).dispose();
          monitorGlow.geometry.dispose();
          (monitorGlow.material as THREE.Material).dispose();
          copyPedestal.geometry.dispose();
          (copyPedestal.material as THREE.Material).dispose();
          copyModule.geometry.dispose();
          (copyModule.material as THREE.Material).dispose();
          copyPreviewFrame.geometry.dispose();
          (copyPreviewFrame.material as THREE.Material).dispose();
          copyPreview.geometry.dispose();
          (copyPreview.material as THREE.Material).dispose();
          distributionNode.geometry.dispose();
          (distributionNode.material as THREE.Material).dispose();
          spherePedestal.geometry.dispose();
          (spherePedestal.material as THREE.Material).dispose();
          sampleSphere.geometry.dispose();
          (sampleSphere.material as THREE.Material).dispose();
          blockPedestal.geometry.dispose();
          (blockPedestal.material as THREE.Material).dispose();
          sampleBlock.geometry.dispose();
          (sampleBlock.material as THREE.Material).dispose();
          cardStand.geometry.dispose();
          (cardStand.material as THREE.Material).dispose();
          cardFrame.geometry.dispose();
          (cardFrame.material as THREE.Material).dispose();
          sampleCard.geometry.dispose();
          (sampleCard.material as THREE.Material).dispose();

          for (const mesh of flowMeshes) {
            mesh.geometry.dispose();
          }

          for (const material of flowMaterials) {
            material.dispose();
          }

          for (const pulse of flowPulses) {
            pulse.mesh.geometry.dispose();
          }

          for (const material of flowPulseMaterials) {
            material.dispose();
          }

          for (const mesh of billboardMeshes) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
          }

          for (const texture of labelTextures) {
            texture.dispose();
          }
        },
      };
    },
  },
  {
    step: "Step 19",
    title: "WGSL Shader Lab",
    summary: "Bridge from Three.js nodes to raw shader thinking: named uniforms drive a vertex stage, then a fragment stage shades the result.",
    notes:
      "This card still uses Three.js TSL so it stays inside the gallery, but it is organized like hand-written WGSL. Study the uniform block, then the vertex displacement, then the fragment color path, and map each one to the object in front of it.",
    tags: ["uniform()", "@vertex", "@fragment", "WGSL mental model"],
    cameraPosition: [9.2, 5.1, 9.8],
    target: [0.6, 1.8, 0],
    create: ({ scene, camera }) => {
      scene.background = new THREE.Color("#07111d");
      scene.fog = new THREE.Fog("#07111d", 16, 28);

      const shaderState = {
        amplitude: 0.34,
        frequency: 2.8,
        speed: 1.18,
        twist: 0.56,
        warmMix: 0.7,
        showCode: true,
        showFlow: true,
        showUniformRack: true,
        freeze: false,
        vertexStage: true,
        fragmentStage: true,
      };

      const panelTextures: THREE.Texture[] = [];
      const billboardPanels: THREE.Mesh[] = [];
      const flowMaterials: THREE.MeshStandardMaterial[] = [];
      const flowPulseMaterials: THREE.MeshBasicMaterial[] = [];
      const flowMeshes: THREE.Mesh[] = [];
      const flowPulses: Array<{
        curve: THREE.CatmullRomCurve3;
        mesh: THREE.Mesh;
        speed: number;
        offset: number;
      }> = [];

      const createCodePanel = (
        title: string,
        subtitle: string,
        lines: string[],
        accent: string,
        width: number,
        height: number,
      ): THREE.Mesh => {
        const canvas = document.createElement("canvas");
        canvas.width = 900;
        canvas.height = 420;

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Could not create 2D canvas context");
        }

        context.fillStyle = "rgba(7, 17, 29, 0.94)";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = accent;
        context.fillRect(0, 0, canvas.width, 18);
        context.strokeStyle = accent;
        context.globalAlpha = 0.88;
        context.lineWidth = 4;
        context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
        context.globalAlpha = 1;
        context.fillStyle = accent;
        context.font = "700 42px Segoe UI, sans-serif";
        context.fillText(title, 34, 74);
        context.fillStyle = "#9cc4ff";
        context.font = "600 26px Consolas, monospace";
        context.fillText(subtitle, 34, 118);
        context.fillStyle = "#d9eaff";
        context.font = "500 26px Consolas, monospace";

        lines.forEach((line, index) => {
          context.fillText(line, 34, 182 + index * 42);
        });

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        panelTextures.push(texture);

        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        });

        const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        panel.renderOrder = 3;
        panel.userData.skipGlobalWireframe = true;
        billboardPanels.push(panel);
        return panel;
      };

      const createTagPanel = (text: string, accent: string, width: number, height: number): THREE.Mesh => {
        const canvas = document.createElement("canvas");
        canvas.width = 560;
        canvas.height = 120;

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Could not create 2D canvas context");
        }

        context.fillStyle = "rgba(7, 17, 29, 0.94)";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.strokeStyle = accent;
        context.globalAlpha = 0.88;
        context.lineWidth = 4;
        context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
        context.globalAlpha = 1;
        context.fillStyle = accent;
        context.font = "600 30px Consolas, monospace";
        context.textAlign = "center";
        context.fillText(text, canvas.width / 2, 72);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        panelTextures.push(texture);

        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        });

        const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        panel.renderOrder = 3;
        panel.userData.skipGlobalWireframe = true;
        billboardPanels.push(panel);
        return panel;
      };

      const ambient = new THREE.AmbientLight("#7baeff", 0.3);
      const hemi = new THREE.HemisphereLight("#7ac8ff", "#06111a", 0.48);
      const key = new THREE.DirectionalLight("#fff4dc", 1.75);
      key.position.set(6.4, 8.8, 4.2);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -8;
      key.shadow.camera.right = 8;
      key.shadow.camera.top = 8;
      key.shadow.camera.bottom = -8;
      key.shadow.normalBias = 0.16;
      const rim = new THREE.PointLight("#5bcfff", 12, 16, 2);
      rim.position.set(-4.8, 3.2, -2.4);
      scene.add(ambient, hemi, key, rim);

      const stageBase = new THREE.Mesh(
        new THREE.BoxGeometry(12.6, 0.36, 6.1),
        new THREE.MeshStandardMaterial({
          color: "#0d1a29",
          roughness: 0.96,
          metalness: 0.04,
        }),
      );
      stageBase.position.set(0.45, -0.56, 0.02);
      stageBase.receiveShadow = true;

      const stageDeck = new THREE.Mesh(
        new THREE.BoxGeometry(12, 0.08, 5.52),
        new THREE.MeshStandardMaterial({
          color: "#132538",
          roughness: 0.88,
          metalness: 0.06,
        }),
      );
      stageDeck.position.set(0.45, -0.32, 0.02);
      stageDeck.receiveShadow = true;

      const uniformPad = new THREE.Mesh(
        new THREE.BoxGeometry(2.8, 0.08, 2.4),
        new THREE.MeshStandardMaterial({
          color: "#1c2f45",
          roughness: 0.82,
          metalness: 0.08,
        }),
      );
      uniformPad.position.set(-3.6, -0.24, 0.1);
      uniformPad.receiveShadow = true;

      const shaderPad = new THREE.Mesh(
        new THREE.BoxGeometry(2.9, 0.08, 2.9),
        new THREE.MeshStandardMaterial({
          color: "#162a3d",
          roughness: 0.82,
          metalness: 0.06,
        }),
      );
      shaderPad.position.set(0.2, -0.24, 0.1);
      shaderPad.receiveShadow = true;

      const fragmentPad = new THREE.Mesh(
        new THREE.BoxGeometry(3.6, 0.08, 2.7),
        new THREE.MeshStandardMaterial({
          color: "#152b40",
          roughness: 0.84,
          metalness: 0.06,
        }),
      );
      fragmentPad.position.set(4.2, -0.24, -0.05);
      fragmentPad.receiveShadow = true;

      scene.add(stageBase, stageDeck, uniformPad, shaderPad, fragmentPad);

      const amplitudeUniform = uniform(shaderState.amplitude, "float").setName("u_amplitude");
      const frequencyUniform = uniform(shaderState.frequency, "float").setName("u_frequency");
      const speedUniform = uniform(shaderState.speed, "float").setName("u_speed");
      const twistUniform = uniform(shaderState.twist, "float").setName("u_twist");
      const warmMixUniform = uniform(shaderState.warmMix, "float").setName("u_warmMix");
      const stageTimeUniform = uniform(0, "float").setName("u_time");
      const vertexEnabledUniform = uniform(1, "float").setName("u_vertexEnabled");
      const fragmentEnabledUniform = uniform(1, "float").setName("u_fragmentEnabled");

      const wave = sin(positionLocal.y.mul(frequencyUniform).add(stageTimeUniform.mul(speedUniform)).add(positionLocal.x.mul(2.2)));
      const crossWave = cos(positionLocal.x.mul(frequencyUniform.mul(0.85)).sub(stageTimeUniform.mul(speedUniform.mul(0.72))).add(positionLocal.z.mul(2.6)));
      const vertexOffset = vec3(
        positionLocal.z.mul(wave).mul(twistUniform).mul(0.22),
        wave.add(crossWave.mul(0.45)).mul(amplitudeUniform),
        positionLocal.x.mul(crossWave).mul(twistUniform).mul(-0.22),
      ).mul(vertexEnabledUniform);

      const band = sin(uv().y.mul(20).add(stageTimeUniform.mul(speedUniform.mul(0.42)))).mul(0.5).add(0.5);
      const sweep = sin(uv().x.mul(13).sub(stageTimeUniform.mul(speedUniform.mul(0.58))).add(uv().y.mul(6))).mul(0.5).add(0.5);
      const fragmentColor = mix(
        mix(color("#132c52"), color("#77e6ff"), band.clamp()),
        color("#ffb56f"),
        sweep.mul(warmMixUniform).clamp(),
      );

      const specimenMaterial = new THREE.MeshStandardNodeMaterial({
        roughness: 0.28,
        metalness: 0.08,
      });
      specimenMaterial.positionNode = positionLocal.add(vertexOffset);
      specimenMaterial.colorNode = mix(color("#a9bdd6"), fragmentColor, fragmentEnabledUniform);

      const fragmentPreviewMaterial = new THREE.MeshStandardNodeMaterial({
        roughness: 0.44,
        metalness: 0.04,
        side: THREE.DoubleSide,
      });
      fragmentPreviewMaterial.colorNode = mix(color("#8fa4ba"), fragmentColor, fragmentEnabledUniform);

      const specimen = new THREE.Mesh(new THREE.CylinderGeometry(0.96, 1.16, 3.5, 88, 120, true), specimenMaterial);
      specimen.position.set(0.2, 1.74, 0.18);
      specimen.castShadow = true;
      specimen.receiveShadow = true;

      const specimenCapTop = new THREE.Mesh(
        new THREE.CircleGeometry(0.96, 88),
        new THREE.MeshStandardMaterial({
          color: "#21384d",
          roughness: 0.72,
          metalness: 0.06,
        }),
      );
      specimenCapTop.rotation.x = -Math.PI / 2;
      specimenCapTop.position.set(0.2, 3.48, 0.18);
      specimenCapTop.castShadow = true;

      const specimenCapBottom = new THREE.Mesh(
        new THREE.CircleGeometry(1.16, 88),
        new THREE.MeshStandardMaterial({
          color: "#16293d",
          roughness: 0.82,
          metalness: 0.04,
        }),
      );
      specimenCapBottom.rotation.x = -Math.PI / 2;
      specimenCapBottom.position.set(0.2, -0.02, 0.18);
      specimenCapBottom.receiveShadow = true;

      const fragmentPanelFrame = new THREE.Mesh(
        new THREE.BoxGeometry(2.1, 2.46, 0.1),
        new THREE.MeshStandardMaterial({
          color: "#20344b",
          roughness: 0.58,
          metalness: 0.18,
          emissive: "#16324b",
          emissiveIntensity: 0.24,
        }),
      );
      fragmentPanelFrame.position.set(4.25, 1.7, -0.12);
      fragmentPanelFrame.castShadow = true;

      const fragmentPanel = new THREE.Mesh(new THREE.PlaneGeometry(1.82, 2.18), fragmentPreviewMaterial);
      fragmentPanel.position.set(4.25, 1.7, -0.03);
      fragmentPanel.rotation.y = -0.26;
      fragmentPanel.receiveShadow = true;

      const rackGroup = new THREE.Group();
      rackGroup.position.set(-3.6, 0, 0.1);

      const rackBase = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 0.24, 1.4),
        new THREE.MeshStandardMaterial({
          color: "#162a3d",
          roughness: 0.84,
          metalness: 0.08,
        }),
      );
      rackBase.position.y = 0.08;
      rackBase.castShadow = true;
      rackBase.receiveShadow = true;

      const rackCore = new THREE.Mesh(
        new THREE.BoxGeometry(1.3, 1.7, 0.84),
        new THREE.MeshStandardMaterial({
          color: "#1c334b",
          roughness: 0.58,
          metalness: 0.16,
          emissive: "#13263b",
          emissiveIntensity: 0.26,
        }),
      );
      rackCore.position.y = 1;
      rackCore.castShadow = true;
      rackCore.receiveShadow = true;

      const rackBars = [
        { mesh: new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 20), new THREE.MeshStandardMaterial({ color: "#7ce6ff", emissive: "#2aa2ff", emissiveIntensity: 0.42, roughness: 0.3, metalness: 0.08 })), key: "amplitude" as const, min: 0, max: 0.55, x: -0.42 },
        { mesh: new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 20), new THREE.MeshStandardMaterial({ color: "#ffca77", emissive: "#ff9d43", emissiveIntensity: 0.38, roughness: 0.3, metalness: 0.08 })), key: "frequency" as const, min: 0.5, max: 6, x: -0.14 },
        { mesh: new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 20), new THREE.MeshStandardMaterial({ color: "#a6ffcc", emissive: "#45d7a6", emissiveIntensity: 0.36, roughness: 0.3, metalness: 0.08 })), key: "speed" as const, min: 0, max: 3, x: 0.14 },
        { mesh: new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 20), new THREE.MeshStandardMaterial({ color: "#d7b2ff", emissive: "#946dff", emissiveIntensity: 0.36, roughness: 0.3, metalness: 0.08 })), key: "twist" as const, min: 0, max: 1.4, x: 0.42 },
      ];

      for (const bar of rackBars) {
        bar.mesh.position.set(bar.x, 0.86, 0.32);
        bar.mesh.castShadow = true;
        rackGroup.add(bar.mesh);
      }

      rackGroup.add(rackBase, rackCore);

      const addFlowLink = (
        points: THREE.Vector3[],
        radius: number,
        tubeColor: string,
        pulseColor: string,
        speed: number,
        offset: number,
      ) => {
        const curve = new THREE.CatmullRomCurve3(points);
        const tubeMaterial = new THREE.MeshStandardMaterial({
          color: tubeColor,
          emissive: tubeColor,
          emissiveIntensity: 0.78,
          roughness: 0.24,
          metalness: 0.08,
        });
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 44, radius, 12, false), tubeMaterial);
        tube.userData.skipGlobalWireframe = true;
        flowGroup.add(tube);
        flowMeshes.push(tube);
        flowMaterials.push(tubeMaterial);

        const pulseMaterial = new THREE.MeshBasicMaterial({
          color: pulseColor,
          toneMapped: false,
        });
        const pulse = new THREE.Mesh(new THREE.SphereGeometry(radius * 2.5, 14, 12), pulseMaterial);
        pulse.userData.skipGlobalWireframe = true;
        flowGroup.add(pulse);
        flowPulseMaterials.push(pulseMaterial);
        flowPulses.push({ curve, mesh: pulse, speed, offset });
      };

      const flowGroup = new THREE.Group();
      addFlowLink(
        [
          new THREE.Vector3(-2.72, 1.82, 0.52),
          new THREE.Vector3(-1.94, 2.1, 0.76),
          new THREE.Vector3(-0.92, 2.1, 0.74),
          new THREE.Vector3(-0.16, 1.98, 0.54),
        ],
        0.04,
        "#ffcb7a",
        "#fff2c7",
        0.18,
        0.04,
      );
      addFlowLink(
        [
          new THREE.Vector3(1.18, 2.42, 0.12),
          new THREE.Vector3(2.1, 2.46, -0.02),
          new THREE.Vector3(3.0, 2.16, -0.08),
          new THREE.Vector3(3.82, 1.88, -0.1),
        ],
        0.032,
        "#8edfff",
        "#dff8ff",
        0.22,
        0.38,
      );
      addFlowLink(
        [
          new THREE.Vector3(0.92, 0.86, 0.74),
          new THREE.Vector3(1.9, 0.96, 0.88),
          new THREE.Vector3(2.95, 1.04, 0.44),
          new THREE.Vector3(3.82, 1.28, 0.02),
        ],
        0.024,
        "#65d5ff",
        "#dff8ff",
        0.2,
        0.62,
      );

      const uniformPanel = createCodePanel(
        "Uniform Block",
        "@group(0) @binding(0)",
        [
          "struct Uniforms {",
          "  amplitude: f32, frequency: f32,",
          "  speed: f32, twist: f32,",
          "  time: f32, warmMix: f32,",
          "};",
        ],
        "#73e0ff",
        3.25,
        1.55,
      );
      uniformPanel.position.set(-3.64, 4.16, 0.38);

      const vertexPanel = createCodePanel(
        "Vertex Stage",
        "@vertex fn vs_main(...)",
        [
          "let wave = sin(pos.y * u.frequency + u.time);",
          "let bend = cos(pos.x * 0.85 * u.frequency);",
          "let offset = vec3f(",
          "  pos.z * wave * u.twist,",
          "  (wave + bend * 0.45) * u.amplitude,",
          "  pos.x * bend * -u.twist );",
        ],
        "#ffca77",
        3.35,
        1.72,
      );
      vertexPanel.position.set(0.18, 4.1, 0.42);

      const fragmentPanelCode = createCodePanel(
        "Fragment Stage",
        "@fragment fn fs_main(...)",
        [
          "let band = sin(uv.y * 20.0 + u.time);",
          "let sweep = sin(uv.x * 13.0 + uv.y * 6.0);",
          "let cool = mix(deepBlue, cyan, band);",
          "let warm = mix(cool, amber, sweep * u.warmMix);",
          "return vec4f(warm, 1.0);",
        ],
        "#9fe8ca",
        3.4,
        1.6,
      );
      fragmentPanelCode.position.set(4.22, 4.04, 0.18);

      const specimenTag = createTagPanel("positionNode -> @vertex", "#ffca77", 2.2, 0.42);
      specimenTag.position.set(0.22, 0.76, 1.82);
      const fragmentTag = createTagPanel("colorNode -> @fragment", "#9fe8ca", 2.25, 0.42);
      fragmentTag.position.set(4.24, 0.84, 1.16);

      scene.add(
        rackGroup,
        specimen,
        specimenCapTop,
        specimenCapBottom,
        fragmentPanelFrame,
        fragmentPanel,
        flowGroup,
        uniformPanel,
        vertexPanel,
        fragmentPanelCode,
        specimenTag,
        fragmentTag,
      );

      let shaderTime = 0;
      const flowPoint = new THREE.Vector3();

      const syncShaderState = () => {
        amplitudeUniform.value = shaderState.amplitude;
        frequencyUniform.value = shaderState.frequency;
        speedUniform.value = shaderState.speed;
        twistUniform.value = shaderState.twist;
        warmMixUniform.value = shaderState.warmMix;
        vertexEnabledUniform.value = shaderState.vertexStage ? 1 : 0;
        fragmentEnabledUniform.value = shaderState.fragmentStage ? 1 : 0;
        rackGroup.visible = shaderState.showUniformRack;
        flowGroup.visible = shaderState.showFlow;

        for (const panel of billboardPanels) {
          panel.visible = shaderState.showCode;
        }
      };

      syncShaderState();

      return {
        update: (_elapsed, delta) => {
          if (!shaderState.freeze) {
            shaderTime += delta;
          }

          stageTimeUniform.value = shaderTime;
          syncShaderState();

          specimen.rotation.y = shaderTime * 0.32;
          specimenCapTop.rotation.z = shaderTime * 0.18;

          const barValues = [
            shaderState.amplitude / 0.55,
            (shaderState.frequency - 0.5) / 5.5,
            shaderState.speed / 3,
            shaderState.twist / 1.4,
          ];

          rackBars.forEach((bar, index) => {
            const normalized = THREE.MathUtils.clamp(barValues[index], 0.08, 1);
            bar.mesh.scale.y = 0.45 + normalized * 1.3;
            bar.mesh.position.y = 0.42 + bar.mesh.scale.y * 0.48;
          });

          for (const panel of billboardPanels) {
            panel.lookAt(camera.position.x, camera.position.y, camera.position.z);
            panel.rotateY(Math.PI);
          }

          for (const pulse of flowPulses) {
            pulse.curve.getPointAt((shaderTime * pulse.speed + pulse.offset) % 1, flowPoint);
            pulse.mesh.position.copy(flowPoint);
            pulse.mesh.scale.setScalar(0.94 + Math.sin(shaderTime * 4 + pulse.offset * 10) * 0.1);
          }
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Shader lab");
          folder.add(shaderState, "amplitude", 0, 0.55, 0.01).name("amplitude");
          folder.add(shaderState, "frequency", 0.5, 6, 0.01).name("frequency");
          folder.add(shaderState, "speed", 0, 3, 0.01).name("speed");
          folder.add(shaderState, "twist", 0, 1.4, 0.01).name("twist");
          folder.add(shaderState, "warmMix", 0, 1, 0.01).name("warm mix");
          folder.add(shaderState, "vertexStage").name("vertex stage");
          folder.add(shaderState, "fragmentStage").name("fragment stage");
          folder.add(shaderState, "showUniformRack").name("uniform rack");
          folder.add(shaderState, "showFlow").name("show flow");
          folder.add(shaderState, "showCode").name("show code");
          folder.add(shaderState, "freeze").name("freeze");
        },
        dispose: () => {
          specimen.geometry.dispose();
          specimenMaterial.dispose();
          specimenCapTop.geometry.dispose();
          (specimenCapTop.material as THREE.Material).dispose();
          specimenCapBottom.geometry.dispose();
          (specimenCapBottom.material as THREE.Material).dispose();
          fragmentPanelFrame.geometry.dispose();
          (fragmentPanelFrame.material as THREE.Material).dispose();
          fragmentPanel.geometry.dispose();
          fragmentPreviewMaterial.dispose();
          rackBase.geometry.dispose();
          (rackBase.material as THREE.Material).dispose();
          rackCore.geometry.dispose();
          (rackCore.material as THREE.Material).dispose();
          stageBase.geometry.dispose();
          (stageBase.material as THREE.Material).dispose();
          stageDeck.geometry.dispose();
          (stageDeck.material as THREE.Material).dispose();
          uniformPad.geometry.dispose();
          (uniformPad.material as THREE.Material).dispose();
          shaderPad.geometry.dispose();
          (shaderPad.material as THREE.Material).dispose();
          fragmentPad.geometry.dispose();
          (fragmentPad.material as THREE.Material).dispose();

          for (const bar of rackBars) {
            bar.mesh.geometry.dispose();
            (bar.mesh.material as THREE.Material).dispose();
          }

          for (const mesh of flowMeshes) {
            mesh.geometry.dispose();
          }

          for (const material of flowMaterials) {
            material.dispose();
          }

          for (const pulse of flowPulses) {
            pulse.mesh.geometry.dispose();
          }

          for (const material of flowPulseMaterials) {
            material.dispose();
          }

          for (const panel of billboardPanels) {
            panel.geometry.dispose();
            (panel.material as THREE.Material).dispose();
          }

          for (const texture of panelTextures) {
            texture.dispose();
          }
        },
      };
    },
  },
  {
    step: "Step 20",
    title: "Distortion Shadow Stage",
    summary: "Drive a hero mesh with uniform-controlled vertex distortion and watch the silhouette and ground shadow warp together.",
    notes:
      "This is the shader moment where deformation stops feeling decorative. The same animated surface that bends the lighting is also reshaping the shadow, so you can see the vertex stage affecting the whole scene.",
    tags: ["positionNode", "Uniform-driven deformation", "Shadow warp"],
    cameraPosition: [8.8, 5.4, 8.8],
    target: [0.1, 1.8, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#06111d");
      scene.fog = new THREE.Fog("#06111d", 14, 28);

      const state = {
        amplitude: 0.78,
        frequency: 3.1,
        speed: 1.16,
        twist: 0.74,
        animateLight: true,
      };

      const ambient = new THREE.AmbientLight("#7db2ff", 0.22);
      const hemi = new THREE.HemisphereLight("#6bc8ff", "#06111a", 0.4);
      const key = new THREE.DirectionalLight("#fff1d6", 1.65);
      key.position.set(5.8, 8.6, 4.2);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -8;
      key.shadow.camera.right = 8;
      key.shadow.camera.top = 8;
      key.shadow.camera.bottom = -8;
      key.shadow.normalBias = 0.16;
      const spot = new THREE.SpotLight("#8ee6ff", 22, 24, Math.PI / 5.6, 0.34, 1.1);
      spot.position.set(-5.4, 6.6, 4.6);
      const spotTarget = new THREE.Object3D();
      spotTarget.position.set(0, 1.4, 0);
      spot.target = spotTarget;
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.normalBias = 0.14;
      scene.add(ambient, hemi, key, spot, spotTarget);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(7.8, 72),
        new THREE.MeshStandardMaterial({
          color: "#102032",
          roughness: 0.97,
          metalness: 0.03,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.28;
      floor.receiveShadow = true;

      const pedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(1.72, 1.92, 0.42, 56),
        new THREE.MeshStandardMaterial({
          color: "#173149",
          roughness: 0.82,
          metalness: 0.08,
        }),
      );
      pedestal.position.y = -1.06;
      pedestal.castShadow = true;
      pedestal.receiveShadow = true;

      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(2.52, 0.08, 12, 84),
        new THREE.MeshStandardMaterial({
          color: "#22496d",
          roughness: 0.28,
          metalness: 0.38,
          emissive: "#16395b",
          emissiveIntensity: 0.32,
        }),
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = -1.02;
      halo.castShadow = true;

      const amplitudeUniform = uniform(state.amplitude, "float").setName("u_amplitude");
      const frequencyUniform = uniform(state.frequency, "float").setName("u_frequency");
      const speedUniform = uniform(state.speed, "float").setName("u_speed");
      const twistUniform = uniform(state.twist, "float").setName("u_twist");
      const stageTimeUniform = uniform(0, "float").setName("u_time");

      const waveA = sin(positionLocal.y.mul(frequencyUniform).add(stageTimeUniform.mul(speedUniform)).add(positionLocal.x.mul(2.4)));
      const waveB = cos(positionLocal.z.mul(frequencyUniform.mul(0.72)).sub(stageTimeUniform.mul(speedUniform.mul(0.8))).add(positionLocal.x.mul(1.9)));
      const displacement = normalLocal
        .mul(waveA.mul(0.22).add(waveB.mul(0.11)).mul(amplitudeUniform))
        .add(
          vec3(
            positionLocal.z.mul(waveA).mul(twistUniform).mul(0.18),
            0,
            positionLocal.x.mul(waveB).mul(twistUniform).mul(-0.18),
          ),
        );

      const heroMaterial = new THREE.MeshStandardNodeMaterial({
        roughness: 0.2,
        metalness: 0.12,
      });
      heroMaterial.positionNode = positionLocal.add(displacement);
      heroMaterial.colorNode = mix(
        mix(color("#10244d"), color("#6ce4ff"), waveA.add(1).mul(0.5).clamp()),
        color("#ffb96f"),
        uv().y.add(waveB.mul(0.3)).clamp(),
      );

      const hero = new THREE.Mesh(new THREE.TorusKnotGeometry(1.15, 0.42, 260, 36), heroMaterial);
      hero.position.y = 1.45;
      hero.castShadow = true;
      hero.receiveShadow = true;

      scene.add(floor, pedestal, halo, hero);

      return {
        update: (elapsed) => {
          stageTimeUniform.value = elapsed;
          amplitudeUniform.value = state.amplitude;
          frequencyUniform.value = state.frequency;
          speedUniform.value = state.speed;
          twistUniform.value = state.twist;

          hero.rotation.x = elapsed * 0.28;
          hero.rotation.y = elapsed * 0.54;
          halo.rotation.z = elapsed * 0.22;

          if (state.animateLight) {
            spot.position.x = Math.cos(elapsed * 0.42) * 5.8;
            spot.position.z = Math.sin(elapsed * 0.42) * 5.2;
          }
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Distortion");
          folder.add(state, "amplitude", 0, 1.2, 0.01).name("amplitude");
          folder.add(state, "frequency", 0.5, 6, 0.01).name("frequency");
          folder.add(state, "speed", 0, 3, 0.01).name("speed");
          folder.add(state, "twist", 0, 1.5, 0.01).name("twist");
          folder.add(state, "animateLight").name("animate light");
        },
        dispose: () => {
          hero.geometry.dispose();
          heroMaterial.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          pedestal.geometry.dispose();
          (pedestal.material as THREE.Material).dispose();
          halo.geometry.dispose();
          (halo.material as THREE.Material).dispose();
        },
      };
    },
  },
  {
    step: "Step 21",
    title: "Frosted Blur Lens",
    summary: "Use transmission, roughness, and a little vertex wobble to turn a mesh into a shadow-casting frosted lens that blurs what's behind it.",
    notes:
      "This one is about reading through the material instead of just at it. The colored bars and test board behind the glass make the blur, refraction, and thickness much easier to judge than a plain environment map.",
    tags: ["MeshPhysicalNodeMaterial", "Transmission", "Frosted glass"],
    cameraPosition: [8.8, 4.8, 8.6],
    target: [0.4, 1.55, -0.4],
    create: ({ scene, renderer }) => {
      scene.background = new THREE.Color("#c9d1db");
      scene.fog = new THREE.Fog("#c9d1db", 16, 30);
      renderer.toneMappingExposure = 0.92;

      const roomEnvironment = new RoomEnvironment();
      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      const environmentTarget = pmremGenerator.fromScene(roomEnvironment, 0.03);
      scene.environment = environmentTarget.texture;

      const floorTexture = createLookdevFloorTexture();
      floorTexture.repeat.set(2.6, 2);

      const backdropCanvas = document.createElement("canvas");
      backdropCanvas.width = 640;
      backdropCanvas.height = 384;
      const backdropContext = backdropCanvas.getContext("2d");

      if (!backdropContext) {
        throw new Error("Could not create backdrop 2D canvas context");
      }

      backdropContext.fillStyle = "#e6ebf2";
      backdropContext.fillRect(0, 0, backdropCanvas.width, backdropCanvas.height);
      backdropContext.fillStyle = "#d6dde8";
      backdropContext.fillRect(0, 0, backdropCanvas.width, 64);
      backdropContext.fillStyle = "#7c8a9b";
      backdropContext.font = "700 46px Segoe UI, sans-serif";
      backdropContext.fillText("FROST TEST", 26, 46);

      const swatches = ["#ff6b6b", "#5fe08f", "#59a6ff", "#ffcb6d"];
      swatches.forEach((value, index) => {
        backdropContext.fillStyle = value;
        backdropContext.fillRect(48 + index * 138, 106, 84, 188);
      });

      backdropContext.strokeStyle = "#526276";
      backdropContext.lineWidth = 6;
      backdropContext.beginPath();
      backdropContext.moveTo(54, 318);
      backdropContext.lineTo(584, 318);
      backdropContext.stroke();

      backdropContext.strokeStyle = "#7b8796";
      backdropContext.lineWidth = 3;
      for (let index = 0; index <= 10; index += 1) {
        const x = 52 + index * 53;
        backdropContext.beginPath();
        backdropContext.moveTo(x, 84);
        backdropContext.lineTo(x, 336);
        backdropContext.stroke();
      }

      const backdropTexture = new THREE.CanvasTexture(backdropCanvas);
      backdropTexture.colorSpace = THREE.SRGBColorSpace;

      const ambient = new THREE.AmbientLight("#8bb4ff", 0.26);
      const key = new THREE.DirectionalLight("#fff6e0", 1.45);
      key.position.set(5.2, 7.6, 4.4);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -8;
      key.shadow.camera.right = 8;
      key.shadow.camera.top = 8;
      key.shadow.camera.bottom = -8;
      key.shadow.normalBias = 0.14;
      const spot = new THREE.SpotLight("#dff5ff", 16, 24, Math.PI / 5.2, 0.32, 1.1);
      spot.position.set(-4.8, 6.2, 5.2);
      const spotTarget = new THREE.Object3D();
      spotTarget.position.set(0.2, 1.2, -0.6);
      spot.target = spotTarget;
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.normalBias = 0.14;
      scene.add(ambient, key, spot, spotTarget);

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(11.8, 11.8),
        new THREE.MeshPhysicalMaterial({
          color: "#b9c2cf",
          map: floorTexture,
          roughness: 0.92,
          metalness: 0.02,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;

      const backdrop = new THREE.Mesh(
        new THREE.PlaneGeometry(5.8, 3.5),
        new THREE.MeshBasicMaterial({
          map: backdropTexture,
          toneMapped: false,
        }),
      );
      backdrop.position.set(0.3, 2.05, -2.7);
      backdrop.userData.skipGlobalWireframe = true;

      const sideBarA = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, 2.8, 20),
        new THREE.MeshStandardMaterial({
          color: "#ff7a7a",
          roughness: 0.18,
          metalness: 0.06,
          emissive: "#b33c3c",
          emissiveIntensity: 0.3,
        }),
      );
      sideBarA.position.set(-2.2, 1.32, -1.86);
      sideBarA.castShadow = true;

      const sideBarB = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, 2.8, 20),
        new THREE.MeshStandardMaterial({
          color: "#5fe08f",
          roughness: 0.18,
          metalness: 0.06,
          emissive: "#2c874e",
          emissiveIntensity: 0.28,
        }),
      );
      sideBarB.position.set(0.2, 1.32, -1.9);
      sideBarB.castShadow = true;

      const sideBarC = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, 2.8, 20),
        new THREE.MeshStandardMaterial({
          color: "#59a6ff",
          roughness: 0.18,
          metalness: 0.06,
          emissive: "#295892",
          emissiveIntensity: 0.3,
        }),
      );
      sideBarC.position.set(2.3, 1.32, -1.94);
      sideBarC.castShadow = true;

      const state = {
        frost: 0.42,
        thickness: 1.4,
        ior: 1.14,
        wobble: 0.11,
        animate: true,
      };

      const frostUniform = uniform(state.frost, "float").setName("u_frost");
      const wobbleUniform = uniform(state.wobble, "float").setName("u_wobble");
      const stageTimeUniform = uniform(0, "float").setName("u_time");

      const frostWave = sin(uv().x.mul(16).add(stageTimeUniform.mul(0.55))).mul(0.5).add(0.5);
      const frostCross = cos(uv().y.mul(18).sub(stageTimeUniform.mul(0.46))).mul(0.5).add(0.5);
      const frostMix = frostWave.mul(0.56).add(frostCross.mul(0.44)).mul(frostUniform).clamp();
      const lensOffset = normalLocal.mul(
        sin(positionLocal.y.mul(3.6).add(stageTimeUniform.mul(0.9))).mul(wobbleUniform).mul(0.2),
      );

      const glassMaterial = new THREE.MeshPhysicalNodeMaterial();
      glassMaterial.colorNode = mix(color("#d6efff"), color("#9fd1ff"), uv().y);
      glassMaterial.roughnessNode = frostMix.mul(0.82).add(0.02);
      glassMaterial.positionNode = positionLocal.add(lensOffset);
      glassMaterial.transmission = 1;
      glassMaterial.thickness = state.thickness;
      glassMaterial.ior = state.ior;
      glassMaterial.clearcoat = 0.35;
      glassMaterial.clearcoatRoughness = 0.12;

      const slabMaterial = new THREE.MeshPhysicalNodeMaterial();
      slabMaterial.colorNode = mix(color("#f4fbff"), color("#a8d4ff"), uv().x);
      slabMaterial.roughnessNode = frostMix.mul(0.62).add(0.05);
      slabMaterial.positionNode = positionLocal.add(lensOffset.mul(0.65));
      slabMaterial.transmission = 1;
      slabMaterial.thickness = state.thickness * 0.8;
      slabMaterial.ior = state.ior + 0.04;
      slabMaterial.clearcoat = 0.28;
      slabMaterial.clearcoatRoughness = 0.14;

      const lens = new THREE.Mesh(new THREE.SphereGeometry(1.18, 64, 48), glassMaterial);
      lens.position.set(-0.35, 1.3, -0.38);
      lens.castShadow = true;
      lens.receiveShadow = true;

      const slab = new THREE.Mesh(new THREE.BoxGeometry(1.02, 2.36, 0.58, 24, 48, 12), slabMaterial);
      slab.position.set(1.82, 1.1, -0.12);
      slab.rotation.y = -0.48;
      slab.castShadow = true;
      slab.receiveShadow = true;

      scene.add(floor, backdrop, sideBarA, sideBarB, sideBarC, lens, slab);

      return {
        update: (elapsed) => {
          stageTimeUniform.value = elapsed;
          frostUniform.value = state.frost;
          wobbleUniform.value = state.wobble;
          glassMaterial.thickness = state.thickness;
          glassMaterial.ior = state.ior;
          slabMaterial.thickness = state.thickness * 0.8;
          slabMaterial.ior = state.ior + 0.04;

          if (state.animate) {
            lens.rotation.y = elapsed * 0.34;
            slab.rotation.y = -0.48 + Math.sin(elapsed * 0.42) * 0.14;
          }
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Frosted glass");
          folder.add(state, "frost", 0, 0.8, 0.01).name("frost");
          folder.add(state, "thickness", 0.1, 2.4, 0.01).name("thickness");
          folder.add(state, "ior", 1, 1.5, 0.01).name("ior");
          folder.add(state, "wobble", 0, 0.3, 0.01).name("wobble");
          folder.add(state, "animate").name("animate");
        },
        dispose: () => {
          scene.environment = null;
          floorTexture.dispose();
          backdropTexture.dispose();
          environmentTarget.dispose();
          pmremGenerator.dispose();
          roomEnvironment.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          backdrop.geometry.dispose();
          (backdrop.material as THREE.Material).dispose();
          sideBarA.geometry.dispose();
          (sideBarA.material as THREE.Material).dispose();
          sideBarB.geometry.dispose();
          (sideBarB.material as THREE.Material).dispose();
          sideBarC.geometry.dispose();
          (sideBarC.material as THREE.Material).dispose();
          lens.geometry.dispose();
          glassMaterial.dispose();
          slab.geometry.dispose();
          slabMaterial.dispose();
        },
      };
    },
  },
  {
    step: "Step 22",
    title: "Surface FX Shadow Lab",
    summary: "Compare several louder procedural materials under one spotlight so you can judge highlights, shadow contact, and surface identity together.",
    notes:
      "This is the shader-to-lookdev bridge: same lights, same floor, very different surfaces. The goal is to feel how roughness, color response, and animated patterning change the read of an object even before you touch geometry.",
    tags: ["roughnessNode", "clearcoatNode", "Shadowed materials"],
    cameraPosition: [9.4, 5.1, 8.6],
    target: [0.2, 1.35, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#06101b");

      const state = {
        animate: true,
        isolate: "all" as "all" | "metal" | "magma" | "pearl",
      };

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(13, 13),
        new THREE.MeshStandardMaterial({
          color: "#0f2132",
          roughness: 0.98,
          metalness: 0.02,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;

      const ambient = new THREE.AmbientLight("#86b3ff", 0.18);
      const key = new THREE.SpotLight("#fff3d8", 28, 28, Math.PI / 5.4, 0.3, 1.1);
      key.position.set(0.8, 8.2, 5.4);
      const keyTarget = new THREE.Object3D();
      keyTarget.position.set(0.2, 1.1, 0);
      key.target = keyTarget;
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.normalBias = 0.14;
      const fill = new THREE.PointLight("#67d1ff", 10, 16, 2);
      fill.position.set(-4.8, 3.4, -3);
      scene.add(floor, ambient, key, keyTarget, fill);

      const pedestalMaterial = new THREE.MeshStandardMaterial({
        color: "#173149",
        roughness: 0.84,
        metalness: 0.06,
      });

      const pedestalA = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.02, 0.32, 36), pedestalMaterial.clone());
      pedestalA.position.set(-3.1, 0.16, 0.2);
      pedestalA.castShadow = true;
      pedestalA.receiveShadow = true;

      const pedestalB = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.02, 0.32, 36), pedestalMaterial.clone());
      pedestalB.position.set(0.2, 0.16, 0.2);
      pedestalB.castShadow = true;
      pedestalB.receiveShadow = true;

      const pedestalC = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.02, 0.32, 36), pedestalMaterial.clone());
      pedestalC.position.set(3.45, 0.16, 0.2);
      pedestalC.castShadow = true;
      pedestalC.receiveShadow = true;

      const brushedMaterial = new THREE.MeshStandardNodeMaterial({
        roughness: 0.16,
        metalness: 0.92,
      });
      const brushed = sin(positionLocal.y.mul(18).add(positionLocal.x.mul(8)).add(time.mul(0.9))).mul(0.5).add(0.5);
      brushedMaterial.colorNode = mix(color("#1c2430"), color("#d6e2f3"), brushed);
      brushedMaterial.roughnessNode = brushed.mul(0.08).add(0.1);
      brushedMaterial.metalnessNode = brushed.mul(0.12).add(0.82);

      const magmaMaterial = new THREE.MeshStandardNodeMaterial({
        roughness: 0.4,
        metalness: 0.06,
      });
      const magmaA = sin(positionLocal.x.mul(6).add(positionLocal.y.mul(4)).add(time.mul(1.8))).mul(0.5).add(0.5);
      const magmaB = cos(positionLocal.z.mul(7).sub(time.mul(1.1))).mul(0.5).add(0.5);
      const magma = magmaA.mul(0.58).add(magmaB.mul(0.42)).clamp();
      magmaMaterial.colorNode = mix(color("#24140f"), color("#ff9347"), magma);
      magmaMaterial.roughnessNode = mix(vec3(0.92).x, vec3(0.18).x, magma);

      const pearlMaterial = new THREE.MeshPhysicalNodeMaterial();
      const pearl = sin(positionLocal.x.mul(5).add(positionLocal.z.mul(7)).add(time.mul(1.25))).mul(0.5).add(0.5);
      pearlMaterial.colorNode = mix(color("#6a7ed8"), color("#eef5ff"), pearl);
      pearlMaterial.roughnessNode = pearl.mul(0.12).add(0.08);
      pearlMaterial.clearcoatNode = pearl.mul(0.35).add(0.62);
      pearlMaterial.iridescenceNode = pearl.mul(0.44).add(0.26);
      pearlMaterial.metalnessNode = pearl.mul(0.08).add(0.02);

      const brushedMesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.7, 0.24, 220, 32), brushedMaterial);
      brushedMesh.position.set(-3.1, 1.3, 0.2);
      brushedMesh.castShadow = true;
      brushedMesh.receiveShadow = true;

      const magmaMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.92, 5), magmaMaterial);
      magmaMesh.position.set(0.2, 1.28, 0.2);
      magmaMesh.castShadow = true;
      magmaMesh.receiveShadow = true;

      const pearlMesh = new THREE.Mesh(new THREE.SphereGeometry(0.9, 48, 36), pearlMaterial);
      pearlMesh.position.set(3.45, 1.22, 0.2);
      pearlMesh.castShadow = true;
      pearlMesh.receiveShadow = true;

      scene.add(pedestalA, pedestalB, pedestalC, brushedMesh, magmaMesh, pearlMesh);

      const syncIsolation = () => {
        const all = state.isolate === "all";
        brushedMesh.visible = all || state.isolate === "metal";
        pedestalA.visible = brushedMesh.visible;
        magmaMesh.visible = all || state.isolate === "magma";
        pedestalB.visible = magmaMesh.visible;
        pearlMesh.visible = all || state.isolate === "pearl";
        pedestalC.visible = pearlMesh.visible;
      };

      syncIsolation();

      return {
        update: (elapsed) => {
          syncIsolation();

          if (state.animate) {
            brushedMesh.rotation.x = elapsed * 0.32;
            brushedMesh.rotation.y = elapsed * 0.72;
            magmaMesh.rotation.y = elapsed * 0.38;
            pearlMesh.rotation.y = -elapsed * 0.3;
            pearlMesh.position.y = 1.22 + Math.sin(elapsed * 1.1) * 0.12;
          }
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Surface FX");
          folder
            .add(state, "isolate", {
              All: "all",
              Brushed: "metal",
              Magma: "magma",
              Pearl: "pearl",
            })
            .name("isolate");
          folder.add(state, "animate").name("animate");
        },
        dispose: () => {
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          pedestalA.geometry.dispose();
          (pedestalA.material as THREE.Material).dispose();
          pedestalB.geometry.dispose();
          (pedestalB.material as THREE.Material).dispose();
          pedestalC.geometry.dispose();
          (pedestalC.material as THREE.Material).dispose();
          brushedMesh.geometry.dispose();
          brushedMaterial.dispose();
          magmaMesh.geometry.dispose();
          magmaMaterial.dispose();
          pearlMesh.geometry.dispose();
          pearlMaterial.dispose();
        },
      };
    },
  },
  {
    step: "Step 23",
    title: "Liquid Metal Reactor",
    summary: "Push a metal surface into something almost alive: heavy deformation, hot highlights, and a glowing core that grounds the reflections.",
    notes:
      "This is a great study in why roughness and reflection breakup matter. The object is still one mesh, but the vertex motion and hot-cold shading make it feel molten instead of static.",
    tags: ["MeshPhysicalNodeMaterial", "Liquid metal", "Animated reflections"],
    cameraPosition: [8.8, 5.2, 8.6],
    target: [0.1, 1.5, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#07101a");
      scene.fog = new THREE.Fog("#07101a", 16, 30);

      const state = {
        amplitude: 0.42,
        speed: 1.24,
        chrome: 0.88,
        heat: 0.54,
        animate: true,
      };

      const ambient = new THREE.AmbientLight("#86b4ff", 0.2);
      const key = new THREE.DirectionalLight("#fff3dd", 1.6);
      key.position.set(5.4, 8.1, 4.8);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -8;
      key.shadow.camera.right = 8;
      key.shadow.camera.top = 8;
      key.shadow.camera.bottom = -8;
      key.shadow.normalBias = 0.14;
      const rim = new THREE.PointLight("#59d6ff", 12, 16, 2);
      rim.position.set(-4.2, 3.4, -2.6);
      const ember = new THREE.PointLight("#ff9b54", 10, 10, 2);
      ember.position.set(0, 0.6, 0);
      scene.add(ambient, key, rim, ember);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(7.8, 72),
        new THREE.MeshStandardMaterial({
          color: "#0f2031",
          roughness: 0.95,
          metalness: 0.04,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.3;
      floor.receiveShadow = true;

      const pedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(1.55, 1.82, 0.4, 48),
        new THREE.MeshStandardMaterial({
          color: "#162d44",
          roughness: 0.78,
          metalness: 0.1,
        }),
      );
      pedestal.position.y = -1.08;
      pedestal.castShadow = true;
      pedestal.receiveShadow = true;

      const reactorRing = new THREE.Mesh(
        new THREE.TorusGeometry(2.05, 0.1, 12, 84),
        new THREE.MeshStandardMaterial({
          color: "#233d58",
          roughness: 0.24,
          metalness: 0.42,
          emissive: "#19456a",
          emissiveIntensity: 0.34,
        }),
      );
      reactorRing.rotation.x = Math.PI / 2;
      reactorRing.position.y = -0.98;
      reactorRing.castShadow = true;

      const amplitudeUniform = uniform(state.amplitude, "float").setName("u_amplitude");
      const chromeUniform = uniform(state.chrome, "float").setName("u_chrome");
      const heatUniform = uniform(state.heat, "float").setName("u_heat");
      const stageTimeUniform = uniform(0, "float").setName("u_time");

      const rippleA = sin(positionLocal.y.mul(5.8).add(stageTimeUniform.mul(state.speed)).add(positionLocal.x.mul(2.6)));
      const rippleB = cos(positionLocal.z.mul(6.6).sub(stageTimeUniform.mul(state.speed * 0.8)).add(positionLocal.x.mul(3.2)));
      const rippleMix = rippleA.mul(0.58).add(rippleB.mul(0.42));
      const offset = normalLocal.mul(rippleMix.mul(amplitudeUniform).mul(0.24));

      const liquidMaterial = new THREE.MeshPhysicalNodeMaterial();
      liquidMaterial.positionNode = positionLocal.add(offset);
      liquidMaterial.colorNode = mix(
        mix(color("#0f1520"), color("#d7e1f5"), chromeUniform),
        color("#ff995c"),
        rippleA.add(1).mul(0.5).mul(heatUniform).clamp(),
      );
      liquidMaterial.roughnessNode = mix(vec3(0.28).x, vec3(0.08).x, rippleB.add(1).mul(0.5).clamp());
      liquidMaterial.metalnessNode = chromeUniform;
      liquidMaterial.clearcoatNode = rippleA.add(1).mul(0.5).mul(0.25).add(0.55);
      liquidMaterial.clearcoatRoughnessNode = rippleB.add(1).mul(0.5).mul(0.08).add(0.06);

      const coreMaterial = new THREE.MeshPhysicalMaterial({
        color: "#ffe1bb",
        emissive: "#ff9d54",
        emissiveIntensity: 1.3,
        roughness: 0.2,
        transmission: 0.45,
        thickness: 0.8,
      });

      const liquidMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.08, 7), liquidMaterial);
      liquidMesh.position.y = 1.15;
      liquidMesh.castShadow = true;
      liquidMesh.receiveShadow = true;

      const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(0.46, 32, 24), coreMaterial);
      coreMesh.position.y = 1.18;
      coreMesh.castShadow = true;

      scene.add(floor, pedestal, reactorRing, liquidMesh, coreMesh);

      return {
        update: (elapsed) => {
          stageTimeUniform.value = elapsed;
          amplitudeUniform.value = state.amplitude;
          chromeUniform.value = state.chrome;
          heatUniform.value = state.heat;

          if (state.animate) {
            liquidMesh.rotation.y = elapsed * 0.46;
            liquidMesh.rotation.x = Math.sin(elapsed * 0.28) * 0.22;
            coreMesh.position.y = 1.18 + Math.sin(elapsed * 1.6) * 0.08;
            reactorRing.rotation.z = elapsed * 0.24;
            ember.intensity = 8 + Math.sin(elapsed * 2.2) * 2.4;
          }
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Liquid metal");
          folder.add(state, "amplitude", 0, 0.8, 0.01).name("amplitude");
          folder.add(state, "chrome", 0.2, 1, 0.01).name("chrome");
          folder.add(state, "heat", 0, 1, 0.01).name("heat");
          folder.add(state, "animate").name("animate");
        },
        dispose: () => {
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          pedestal.geometry.dispose();
          (pedestal.material as THREE.Material).dispose();
          reactorRing.geometry.dispose();
          (reactorRing.material as THREE.Material).dispose();
          liquidMesh.geometry.dispose();
          liquidMaterial.dispose();
          coreMesh.geometry.dispose();
          coreMaterial.dispose();
        },
      };
    },
  },
  {
    step: "Step 24",
    title: "Iridescent Crystal Garden",
    summary: "Stack transmission, iridescence, and sharp spotlight shadows into a crystal cluster that changes color as you orbit it.",
    notes:
      "This one is less about blur and more about angle response. Orbit around it and watch the same crystal swing between cool and warm colors as the lighting catches the facets differently. The rear test wall and props are there so you can see the transmission bend, tint, and split the scene behind the crystals.",
    tags: ["Iridescence", "Transmission", "Refraction target"],
    cameraPosition: [9.2, 5.6, 9.2],
    target: [0.2, 1.8, -0.2],
    create: ({ scene, renderer }) => {
      scene.background = new THREE.Color("#c8ced8");
      scene.fog = new THREE.Fog("#c8ced8", 16, 32);
      renderer.toneMappingExposure = 0.96;

      const createRefractionBackdropTexture = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 768;
        canvas.height = 384;

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Could not create 2D canvas context");
        }

        const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, "#e6edf7");
        gradient.addColorStop(1, "#bccbdd");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);

        context.fillStyle = "#182636";
        context.fillRect(32, 32, canvas.width - 64, canvas.height - 64);

        const stripeColors = ["#ff8f6b", "#f5f8ff", "#74dfff", "#ffd96d", "#8ce2a4", "#d4c1ff"];
        stripeColors.forEach((stripeColor, index) => {
          context.fillStyle = stripeColor;
          context.fillRect(76 + index * 98, 74, 56, 236);
        });

        context.strokeStyle = "rgba(255, 255, 255, 0.82)";
        context.lineWidth = 8;
        context.beginPath();
        context.moveTo(56, 300);
        context.lineTo(706, 96);
        context.stroke();

        context.strokeStyle = "rgba(116, 223, 255, 0.9)";
        context.lineWidth = 18;
        context.beginPath();
        context.arc(588, 186, 74, 0, Math.PI * 2);
        context.stroke();

        context.fillStyle = "#fff6cc";
        context.beginPath();
        context.arc(164, 124, 36, 0, Math.PI * 2);
        context.fill();

        context.fillStyle = "#74dfff";
        context.fillRect(266, 226, 174, 48);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
      };

      const roomEnvironment = new RoomEnvironment();
      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      const environmentTarget = pmremGenerator.fromScene(roomEnvironment, 0.03);
      scene.environment = environmentTarget.texture;
      const backdropTexture = createRefractionBackdropTexture();

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(12, 12),
        new THREE.MeshPhysicalMaterial({
          color: "#b9c3cf",
          roughness: 0.9,
          metalness: 0.02,
          clearcoat: 0.04,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;

      const ambient = new THREE.AmbientLight("#89b4ff", 0.24);
      const key = new THREE.SpotLight("#fff3dc", 26, 28, Math.PI / 5, 0.3, 1.12);
      key.position.set(2.4, 8.8, 5.6);
      const keyTarget = new THREE.Object3D();
      keyTarget.position.set(0.2, 1.5, 0);
      key.target = keyTarget;
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.normalBias = 0.12;
      const fill = new THREE.PointLight("#7de0ff", 8, 16, 2);
      fill.position.set(-4.4, 3.2, -2.8);
      scene.add(floor, ambient, key, keyTarget, fill);

      const state = {
        animate: true,
        iridescence: 0.92,
        roughness: 0.14,
        thickness: 1.6,
        showBackdrop: true,
      };

      const crystalMaterial = new THREE.MeshPhysicalNodeMaterial();
      const sparkle = sin(positionLocal.y.mul(9).add(positionLocal.x.mul(6)).add(time.mul(1.2))).mul(0.5).add(0.5);
      crystalMaterial.colorNode = mix(color("#c8e7ff"), color("#fef4ff"), sparkle);
      crystalMaterial.roughnessNode = sparkle.mul(0.08).add(0.06);
      crystalMaterial.transmission = 1;
      crystalMaterial.thickness = state.thickness;
      crystalMaterial.ior = 1.18;
      crystalMaterial.clearcoat = 0.38;
      crystalMaterial.clearcoatRoughness = 0.08;
      crystalMaterial.iridescence = state.iridescence;

      const createCrystal = (height: number) =>
        new THREE.CylinderGeometry(0.42, 0.92, height, 6, 8, false);

      const crystalA = new THREE.Mesh(createCrystal(3.2), crystalMaterial);
      crystalA.position.set(-0.92, 1.46, 0.2);
      crystalA.rotation.set(0.12, 0.32, 0.06);
      crystalA.castShadow = true;
      crystalA.receiveShadow = true;

      const crystalB = new THREE.Mesh(createCrystal(2.8), crystalMaterial);
      crystalB.position.set(0.55, 1.28, -0.22);
      crystalB.rotation.set(-0.08, -0.22, -0.08);
      crystalB.castShadow = true;
      crystalB.receiveShadow = true;

      const crystalC = new THREE.Mesh(createCrystal(2.35), crystalMaterial);
      crystalC.position.set(1.48, 1.1, 0.52);
      crystalC.rotation.set(0.14, 0.56, 0.12);
      crystalC.castShadow = true;
      crystalC.receiveShadow = true;

      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(1.8, 2.1, 0.42, 48),
        new THREE.MeshStandardMaterial({
          color: "#3d4b5f",
          roughness: 0.82,
          metalness: 0.08,
        }),
      );
      base.position.y = 0.2;
      base.castShadow = true;
      base.receiveShadow = true;

      const backdrop = new THREE.Mesh(
        new THREE.PlaneGeometry(6.6, 3.8),
        new THREE.MeshStandardMaterial({
          map: backdropTexture,
          roughness: 0.86,
          metalness: 0.04,
          emissive: "#16283c",
          emissiveIntensity: 0.16,
        }),
      );
      backdrop.position.set(0.1, 2.05, -2.28);
      backdrop.rotation.y = -0.1;
      backdrop.receiveShadow = true;

      const rearOrb = new THREE.Mesh(
        new THREE.SphereGeometry(0.48, 32, 24),
        new THREE.MeshStandardMaterial({
          color: "#ff9e77",
          roughness: 0.26,
          metalness: 0.08,
          emissive: "#ff8454",
          emissiveIntensity: 0.18,
        }),
      );
      rearOrb.position.set(-1.38, 1.08, -1.72);
      rearOrb.castShadow = true;
      rearOrb.receiveShadow = true;

      const rearColumn = new THREE.Mesh(
        new THREE.BoxGeometry(0.48, 1.58, 0.48),
        new THREE.MeshStandardMaterial({
          color: "#7ce5d0",
          roughness: 0.34,
          metalness: 0.06,
        }),
      );
      rearColumn.position.set(1.82, 1.1, -1.94);
      rearColumn.castShadow = true;
      rearColumn.receiveShadow = true;

      const rearRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.56, 0.12, 18, 48),
        new THREE.MeshStandardMaterial({
          color: "#f3f7ff",
          roughness: 0.2,
          metalness: 0.42,
        }),
      );
      rearRing.position.set(0.66, 1.96, -1.64);
      rearRing.rotation.set(0.48, 0.12, 0.82);
      rearRing.castShadow = true;
      rearRing.receiveShadow = true;

      scene.add(base, backdrop, rearOrb, rearColumn, rearRing, crystalA, crystalB, crystalC);

      return {
        update: (elapsed) => {
          crystalMaterial.iridescence = state.iridescence;
          crystalMaterial.roughness = state.roughness;
          crystalMaterial.thickness = state.thickness;
          backdrop.visible = state.showBackdrop;
          rearOrb.visible = state.showBackdrop;
          rearColumn.visible = state.showBackdrop;
          rearRing.visible = state.showBackdrop;

          if (state.animate) {
            crystalA.rotation.y = 0.32 + Math.sin(elapsed * 0.42) * 0.12;
            crystalB.rotation.y = -0.22 - Math.sin(elapsed * 0.35) * 0.14;
            crystalC.rotation.y = 0.56 + Math.sin(elapsed * 0.48) * 0.1;
            fill.position.x = -4.4 + Math.cos(elapsed * 0.54) * 0.8;
            rearOrb.position.y = 1.08 + Math.sin(elapsed * 1.3) * 0.12;
            rearColumn.rotation.y = elapsed * 0.42;
            rearRing.rotation.z = 0.82 + elapsed * 0.54;
          }
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Crystal");
          folder.add(state, "iridescence", 0, 1, 0.01).name("iridescence");
          folder.add(state, "roughness", 0, 0.4, 0.01).name("roughness");
          folder.add(state, "thickness", 0.2, 2.4, 0.01).name("thickness");
          folder.add(state, "showBackdrop").name("rear props");
          folder.add(state, "animate").name("animate");
        },
        dispose: () => {
          scene.environment = null;
          environmentTarget.dispose();
          pmremGenerator.dispose();
          roomEnvironment.dispose();
          backdropTexture.dispose();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          base.geometry.dispose();
          (base.material as THREE.Material).dispose();
          backdrop.geometry.dispose();
          (backdrop.material as THREE.Material).dispose();
          rearOrb.geometry.dispose();
          (rearOrb.material as THREE.Material).dispose();
          rearColumn.geometry.dispose();
          (rearColumn.material as THREE.Material).dispose();
          rearRing.geometry.dispose();
          (rearRing.material as THREE.Material).dispose();
          crystalA.geometry.dispose();
          crystalB.geometry.dispose();
          crystalC.geometry.dispose();
          crystalMaterial.dispose();
        },
      };
    },
  },
  {
    step: "Step 25",
    title: "Solar Rift Gate",
    summary: "Split a pair of monoliths open and shade the energy sheet between them so the scene feels like a real portal instead of a floating effect toy.",
    notes:
      "The monoliths do the grounding work here: they cast the shadows and give the eye something hard and heavy to trust. The animated sheet, arcs, and shards can go wilder because the scene still feels physically anchored.",
    tags: ["Portal shader", "positionNode", "Shadowed monoliths"],
    cameraPosition: [8.8, 4.8, 8.8],
    target: [0, 1.4, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#06111b");
      scene.fog = new THREE.Fog("#06111b", 16, 30);

      const state = {
        animate: true,
        aperture: 0.62,
        turbulence: 0.44,
        glow: 0.82,
        shardSpin: 0.86,
      };

      const ambient = new THREE.AmbientLight("#80adff", 0.18);
      const spot = new THREE.SpotLight("#fff4de", 28, 28, Math.PI / 5.1, 0.32, 1.12);
      spot.position.set(3.8, 8.4, 5.2);
      const spotTarget = new THREE.Object3D();
      spotTarget.position.set(0, 1.2, 0);
      spot.target = spotTarget;
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.normalBias = 0.14;
      const fill = new THREE.PointLight("#49d0ff", 9, 18, 2);
      fill.position.set(-4.4, 3.1, -3.2);
      const riftLight = new THREE.PointLight("#ff8f4d", 10, 14, 2);
      riftLight.position.set(0, 1.2, 0);
      scene.add(ambient, spot, spotTarget, fill, riftLight);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(7.4, 72),
        new THREE.MeshStandardMaterial({
          color: "#0f2132",
          roughness: 0.98,
          metalness: 0.02,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.32;
      floor.receiveShadow = true;

      const pedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(1.9, 2.22, 0.52, 56),
        new THREE.MeshStandardMaterial({
          color: "#153049",
          roughness: 0.82,
          metalness: 0.08,
        }),
      );
      pedestal.position.y = -1.08;
      pedestal.castShadow = true;
      pedestal.receiveShadow = true;

      const baseRing = new THREE.Mesh(
        new THREE.TorusGeometry(2.28, 0.08, 12, 96),
        new THREE.MeshStandardMaterial({
          color: "#203f5e",
          roughness: 0.24,
          metalness: 0.38,
          emissive: "#204d76",
          emissiveIntensity: 0.34,
        }),
      );
      baseRing.rotation.x = Math.PI / 2;
      baseRing.position.y = -0.96;
      baseRing.castShadow = true;

      const leftPillar = new THREE.Mesh(
        new THREE.BoxGeometry(0.82, 3.9, 1.12),
        new THREE.MeshStandardMaterial({
          color: "#1a334a",
          roughness: 0.72,
          metalness: 0.14,
          emissive: "#102536",
          emissiveIntensity: 0.16,
        }),
      );
      leftPillar.position.set(-0.96, 0.92, 0.08);
      leftPillar.rotation.set(0.02, -0.14, 0.08);
      leftPillar.castShadow = true;
      leftPillar.receiveShadow = true;

      const rightPillar = new THREE.Mesh(
        new THREE.BoxGeometry(0.82, 4.1, 1.12),
        new THREE.MeshStandardMaterial({
          color: "#1a334a",
          roughness: 0.72,
          metalness: 0.14,
          emissive: "#102536",
          emissiveIntensity: 0.16,
        }),
      );
      rightPillar.position.set(1.02, 0.96, -0.02);
      rightPillar.rotation.set(-0.04, 0.16, -0.08);
      rightPillar.castShadow = true;
      rightPillar.receiveShadow = true;

      const apertureUniform = uniform(state.aperture, "float").setName("u_aperture");
      const turbulenceUniform = uniform(state.turbulence, "float").setName("u_turbulence");
      const glowUniform = uniform(state.glow, "float").setName("u_glow");
      const stageTimeUniform = uniform(0, "float").setName("u_time");

      const slit = uv().x.sub(0.5).abs().mul(2).oneMinus().clamp();
      const slitCore = slit.pow(4);
      const waveA = sin(uv().y.mul(18).add(stageTimeUniform.mul(3.1))).mul(0.5).add(0.5);
      const waveB = cos(uv().x.mul(12).sub(stageTimeUniform.mul(2.4)).add(uv().y.mul(9))).mul(0.5).add(0.5);
      const riftMaterial = new THREE.MeshStandardNodeMaterial({
        roughness: 0.18,
        metalness: 0.06,
        side: THREE.DoubleSide,
      });
      riftMaterial.positionNode = positionLocal.add(
        vec3(
          sin(positionLocal.y.mul(4.8).add(stageTimeUniform.mul(2.2))).mul(turbulenceUniform).mul(slit).mul(0.08),
          0,
          sin(positionLocal.y.mul(6.2).sub(stageTimeUniform.mul(3))).mul(apertureUniform).mul(slitCore).mul(0.34),
        ),
      );
      riftMaterial.colorNode = mix(
        mix(color("#10264b"), color("#72e4ff"), waveA.mul(glowUniform).clamp()),
        color("#ff9b54"),
        slitCore.mul(0.58).add(waveB.mul(0.18)).clamp(),
      );

      const rift = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 3.52, 56, 128), riftMaterial);
      rift.position.set(0.02, 0.92, 0.06);
      rift.rotation.y = 0.02;
      rift.receiveShadow = true;

      const arcA = new THREE.Mesh(
        new THREE.TorusGeometry(1.22, 0.06, 12, 96, Math.PI * 1.12),
        new THREE.MeshStandardMaterial({
          color: "#e8fbff",
          emissive: "#6ee6ff",
          emissiveIntensity: 1.12,
          roughness: 0.14,
          metalness: 0.12,
        }),
      );
      arcA.position.set(0, 1.2, 0.02);
      arcA.rotation.set(1.22, 0.18, 0.42);

      const arcB = new THREE.Mesh(
        new THREE.TorusGeometry(0.86, 0.05, 12, 84, Math.PI * 1.08),
        new THREE.MeshStandardMaterial({
          color: "#ffe9cf",
          emissive: "#ffb36a",
          emissiveIntensity: 1.04,
          roughness: 0.14,
          metalness: 0.12,
        }),
      );
      arcB.position.set(0.06, 1.78, 0.1);
      arcB.rotation.set(0.42, 0.86, -0.28);

      const shardMaterial = new THREE.MeshStandardMaterial({
        color: "#d8f7ff",
        emissive: "#67dcff",
        emissiveIntensity: 0.72,
        roughness: 0.12,
        metalness: 0.18,
      });
      const shards = Array.from({ length: 5 }, (_, index) => {
        const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.16 + index * 0.025, 0), shardMaterial.clone());
        shard.castShadow = true;
        return shard;
      });

      scene.add(floor, pedestal, baseRing, leftPillar, rightPillar, rift, arcA, arcB, ...shards);

      return {
        update: (elapsed) => {
          stageTimeUniform.value = elapsed;
          apertureUniform.value = state.aperture;
          turbulenceUniform.value = state.turbulence;
          glowUniform.value = state.glow;

          if (state.animate) {
            baseRing.rotation.z = elapsed * 0.18;
            arcA.rotation.z = 0.42 + elapsed * 0.58;
            arcB.rotation.x = 0.42 + elapsed * 0.74;
            rift.rotation.y = Math.sin(elapsed * 0.36) * 0.08;
            riftLight.intensity = 8 + Math.sin(elapsed * 4.2) * 2.2;
            riftLight.position.y = 1.12 + Math.sin(elapsed * 2.3) * 0.12;

            shards.forEach((shard, index) => {
              const angle = elapsed * (state.shardSpin + index * 0.08) + index * 1.2;
              const radius = 1.24 + index * 0.16;
              shard.position.set(Math.cos(angle) * radius, 1.16 + Math.sin(elapsed * 1.4 + index) * 0.4, Math.sin(angle) * radius * 0.38);
              shard.rotation.x = elapsed * (0.8 + index * 0.1);
              shard.rotation.y = elapsed * (1 + index * 0.12);
            });
          }
        },
        setupGui: ({ gui }) => {
          const folder = gui.addFolder("Rift");
          folder.add(state, "aperture", 0.1, 1, 0.01).name("aperture");
          folder.add(state, "turbulence", 0, 1, 0.01).name("turbulence");
          folder.add(state, "glow", 0, 1.2, 0.01).name("glow");
          folder.add(state, "shardSpin", 0, 2, 0.01).name("shard spin");
          folder.add(state, "animate").name("animate");
        },
        dispose: () => {
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          pedestal.geometry.dispose();
          (pedestal.material as THREE.Material).dispose();
          baseRing.geometry.dispose();
          (baseRing.material as THREE.Material).dispose();
          leftPillar.geometry.dispose();
          (leftPillar.material as THREE.Material).dispose();
          rightPillar.geometry.dispose();
          (rightPillar.material as THREE.Material).dispose();
          rift.geometry.dispose();
          riftMaterial.dispose();
          arcA.geometry.dispose();
          (arcA.material as THREE.Material).dispose();
          arcB.geometry.dispose();
          (arcB.material as THREE.Material).dispose();

          for (const shard of shards) {
            shard.geometry.dispose();
            (shard.material as THREE.Material).dispose();
          }
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
        and then into a run of advanced GPU labs focused on workgroups, shader-stage thinking, compute-authored geometry,
        and storage textures.
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
      compute-swarm, workgroup-prism, WGSL shader lab, compute-heightfield, and storage-texture pipeline cards are the most
      WebGPU-specific steps before jumping into custom WGSL, GPGPU, or renderer internals.
    </p>
  </main>
`;

const statusTarget = document.querySelector<HTMLDivElement>("#runtime-status");
const examplesTarget = document.querySelector<HTMLDivElement>("#examples");
const hasNativeWebGPU = WebGPU.isAvailable();

if (!statusTarget || !examplesTarget) {
  throw new Error("Could not find page targets");
}

if (!hasNativeWebGPU) {
  const warning = document.createElement("div");
  warning.className = "status-banner";
  warning.textContent =
    "WebGPU is not available in this browser right now. Three.js is falling back to WebGL2, so this page now mounts only a few nearby live scenes at once to avoid mobile context limits.";
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

const exampleCards = [...document.querySelectorAll<HTMLElement>(".example-card")];

const timer = new THREE.Timer();
timer.connect(document);
const mountedExamples: Array<MountedExample | null> = hasNativeWebGPU
  ? await Promise.all(exampleCards.map((card, index) => mountExample(card, examples[index])))
  : new Array(exampleCards.length).fill(null);
const mountingExamples = new Map<number, Promise<void>>();

const disposeMountedExample = (mounted: MountedExample) => {
  window.removeEventListener("resize", mounted.handleWindowResize);
  mounted.guiFieldObserver.disconnect();
  mounted.cameraRig.dispose();
  mounted.controls.dispose();
  mounted.wireframeController.dispose();
  mounted.gui.destroy();
  mounted.dispose?.();
  mounted.renderer.domElement.remove();
  mounted.renderer.dispose();
  mounted.fpsLabel.textContent = "0 FPS";
};

const ensureExampleMounted = async (index: number) => {
  if (mountedExamples[index] || mountingExamples.has(index)) {
    return;
  }

  const promise = mountExample(exampleCards[index], examples[index])
    .then((mounted) => {
      mountedExamples[index] = mounted;
    })
    .catch((error) => {
      const card = exampleCards[index];
      const host = card.querySelector<HTMLDivElement>(".example-viewport");

      if (host) {
        card.dataset.error = "true";
        const details = error instanceof Error ? error.message : String(error);
        host.innerHTML = `<div class="example-error">This example hit a runtime error.<br>${details}</div>`;
      }

      console.error(`Example "${examples[index].title}" failed to mount`, error);
    })
    .finally(() => {
      mountingExamples.delete(index);
    });

  mountingExamples.set(index, promise);
  await promise;
};

const unmountExample = (index: number) => {
  const mounted = mountedExamples[index];

  if (!mounted) {
    return;
  }

  disposeMountedExample(mounted);
  mountedExamples[index] = null;
};

const reconcileFallbackExamples = () => {
  if (hasNativeWebGPU) {
    return;
  }

  const viewportCenter = window.innerHeight * 0.5;
  const desired = exampleCards
    .map((card, index) => ({
      index,
      rect: card.getBoundingClientRect(),
    }))
    .filter(
      ({ rect }) =>
        rect.bottom > -FALLBACK_PREWARM_MARGIN && rect.top < window.innerHeight + FALLBACK_PREWARM_MARGIN,
    )
    .sort((a, b) => {
      const aDistance = Math.abs(a.rect.top + a.rect.height * 0.5 - viewportCenter);
      const bDistance = Math.abs(b.rect.top + b.rect.height * 0.5 - viewportCenter);
      return aDistance - bDistance;
    })
    .slice(0, FALLBACK_RENDERER_BUDGET)
    .map(({ index }) => index);

  const desiredSet = new Set(desired);

  for (let index = 0; index < mountedExamples.length; index += 1) {
    if (!desiredSet.has(index)) {
      unmountExample(index);
    }
  }

  for (const index of desired) {
    void ensureExampleMounted(index);
  }
};

let renderLoopActive = true;
let renderFrameHandle = 0;
let scrollSuspendUntil = 0;

const handleWindowScroll = () => {
  scrollSuspendUntil = performance.now() + 140;
};

window.addEventListener("scroll", handleWindowScroll, { passive: true });

const renderLoop = () => {
  if (!renderLoopActive) {
    return;
  }

  timer.update();
  const delta = timer.getDelta();
  const elapsed = timer.getElapsed();
  const fps = delta > 0 ? THREE.MathUtils.clamp(1 / delta, 0, 240) : 0;
  const scrollSuspended = performance.now() < scrollSuspendUntil;

  if (!scrollSuspended) {
    reconcileFallbackExamples();
  }

  for (const mounted of mountedExamples) {
    if (!mounted) {
      continue;
    }

    if (mounted.failed) {
      continue;
    }

    try {
      if (scrollSuspended) {
        continue;
      }

      mounted.fpsSmoothed = mounted.fpsSmoothed === 0 ? fps : THREE.MathUtils.lerp(mounted.fpsSmoothed, fps, 0.16);
      mounted.fpsLabel.textContent = `${Math.round(mounted.fpsSmoothed)} FPS`;
      if (mounted.sizeDirty) {
        mounted.syncSize();
      }
      mounted.cameraRig.update(delta);
      mounted.wireframeController.update();
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

  renderFrameHandle = requestAnimationFrame(renderLoop);
};

renderFrameHandle = requestAnimationFrame(renderLoop);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    renderLoopActive = false;
    cancelAnimationFrame(renderFrameHandle);
    window.removeEventListener("scroll", handleWindowScroll);

    const teardownExamples = () => {
      for (const mounted of mountedExamples) {
        if (mounted) {
          disposeMountedExample(mounted);
        }
      }
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(teardownExamples);
    });
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
  const initialWidth = Math.max(host.clientWidth, 1);
  const initialHeight = Math.max(host.clientHeight, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(initialWidth, initialHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  await renderer.init();

  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.touchAction = "none";
  host.append(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = true;
  controls.zoomToCursor = true;
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.PAN,
  };
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
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
  const wireframeController = createSceneWireframeController(scene);
  const gui = new GUI({
    autoPlace: false,
    container: guiHost,
    title: "Debug",
    width: 284,
  });
  const setWireframe = (enabled: boolean) => {
    wireframeController.setEnabled(enabled);
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
  const guiFieldObserver = watchGuiFieldAttributes(
    guiHost,
    `debug-${slugifyLabel(`${example.step}-${example.title}`)}`,
  );
  setWireframe(viewState.wireframe);

  const mounted: MountedExample = {
    card,
    host,
    scene,
    camera,
    renderer,
    controls,
    handleWindowResize: () => {
      mounted.sizeDirty = true;
    },
    guiFieldObserver,
    cameraRig,
    gui,
    wireframeController,
    fpsLabel,
    fpsSmoothed: 0,
    failed: false,
    sizeDirty: false,
    viewportWidth: initialWidth,
    viewportHeight: initialHeight,
    syncSize: () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      mounted.sizeDirty = false;

      if (width === mounted.viewportWidth && height === mounted.viewportHeight) {
        return;
      }

      mounted.viewportWidth = width;
      mounted.viewportHeight = height;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    },
    ...runtime,
  };

  camera.aspect = initialWidth / initialHeight;
  camera.updateProjectionMatrix();
  window.addEventListener("resize", mounted.handleWindowResize);

  return mounted;
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
