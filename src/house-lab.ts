import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

type HouseLabOptions = {
  prefersTouchInput: boolean;
  hasNativeWebGPU: boolean;
};

type HouseTool = "walls" | "rooms" | "select";
type SelectionKind = "wall" | "room";
type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type RoomResizeHandle = ResizeHandle;
type WallResizeHandle = "start" | "end";
type PolygonResizeHandle = ResizeHandle;

type PlannerSelection = {
  kind: SelectionKind;
  id: string;
} | null;

type RoomPreset = {
  label: string;
  width: number;
  depth: number;
  height: number;
  color: string;
};

type RoomFootprint = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  height: number;
  wallThickness: number;
  color: string;
};

type SketchWall = {
  id: string;
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  height: number;
  thickness: number;
  color: string;
};

type DraftShape =
  | {
      kind: "wall";
      start: THREE.Vector2;
      current: THREE.Vector2;
    }
  | {
      kind: "room";
      start: THREE.Vector2;
      current: THREE.Vector2;
    }
  | null;

type PlannerSnapshot = {
  rooms: RoomFootprint[];
  walls: SketchWall[];
  selection: PlannerSelection;
  tool: HouseTool;
};

type WallDragOrigin = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type LoopBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

export type HouseLabHandle = {
  setVisible: (visible: boolean) => void;
  dispose: () => void;
};

const GRID_STEP_METERS = 0.5;
const GRID_COLUMNS = 56;
const GRID_ROWS = 40;
const PIXELS_PER_METER = 56;
const GRID_WIDTH_METERS = GRID_COLUMNS * GRID_STEP_METERS;
const GRID_HEIGHT_METERS = GRID_ROWS * GRID_STEP_METERS;
const DEFAULT_WALL_HEIGHT = 2.8;
const DEFAULT_WALL_THICKNESS = 0.18;
const HANDLE_PICK_RADIUS_METERS = 0.5;
const PLAN_PAN_MARGIN_METERS = 2;
const PLAN_MIN_ZOOM = 0.45;
const PLAN_MAX_ZOOM = 4;
const WALL_COLORS = ["#102033", "#2f4360", "#294766", "#3d5777"];
const ROOM_COLORS = ["#5f89d8", "#7ea66d", "#c78a62", "#8b79cf", "#4aa3a0"];

const ROOM_PRESETS: RoomPreset[] = [
  {
    label: "Living",
    width: 6,
    depth: 4.5,
    height: 3,
    color: "#5f89d8",
  },
  {
    label: "Bedroom",
    width: 4,
    depth: 3.5,
    height: 2.8,
    color: "#7ea66d",
  },
  {
    label: "Kitchen",
    width: 3.5,
    depth: 3,
    height: 2.8,
    color: "#c78a62",
  },
  {
    label: "Bath",
    width: 2.5,
    depth: 2.5,
    height: 2.6,
    color: "#8b79cf",
  },
];

function snapMeters(value: number): number {
  return Math.round(value / GRID_STEP_METERS) * GRID_STEP_METERS;
}

function clampMeters(value: number, min: number, max: number): number {
  return THREE.MathUtils.clamp(snapMeters(value), min, max);
}

function formatMeters(value: number): string {
  return `${value.toFixed(1)} m`;
}

function formatWallOrientation(wall: SketchWall): string {
  return Math.abs(wall.x2 - wall.x1) >= Math.abs(wall.y2 - wall.y1) ? "Horizontal" : "Vertical";
}

function wallLength(wall: SketchWall): number {
  return Math.abs(wall.x2 - wall.x1) + Math.abs(wall.y2 - wall.y1);
}

function roomCenterX(room: RoomFootprint): number {
  return -GRID_WIDTH_METERS * 0.5 + room.x + room.width * 0.5;
}

function roomCenterZ(room: RoomFootprint): number {
  return -GRID_HEIGHT_METERS * 0.5 + room.y + room.depth * 0.5;
}

function wallCenterX(wall: SketchWall): number {
  return -GRID_WIDTH_METERS * 0.5 + (wall.x1 + wall.x2) * 0.5;
}

function wallCenterZ(wall: SketchWall): number {
  return -GRID_HEIGHT_METERS * 0.5 + (wall.y1 + wall.y2) * 0.5;
}

function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    if ("geometry" in object && object.geometry instanceof THREE.BufferGeometry) {
      object.geometry.dispose();
    }

    if ("material" in object) {
      const material = object.material;

      if (Array.isArray(material)) {
        for (const item of material) {
          item.dispose();
        }
      } else if (material instanceof THREE.Material) {
        material.dispose();
      }
    }
  });
}

function createRoomFromPreset(preset: RoomPreset, x: number, y: number, index: number): RoomFootprint {
  return {
    id: `room-${crypto.randomUUID()}`,
    label: `${preset.label} ${index + 1}`,
    x,
    y,
    width: preset.width,
    depth: preset.depth,
    height: preset.height,
    wallThickness: DEFAULT_WALL_THICKNESS,
    color: preset.color,
  };
}

function createSketchWall(
  label: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color = WALL_COLORS[0],
): SketchWall {
  return {
    id: `wall-${crypto.randomUUID()}`,
    label,
    x1: snapMeters(x1),
    y1: snapMeters(y1),
    x2: snapMeters(x2),
    y2: snapMeters(y2),
    height: DEFAULT_WALL_HEIGHT,
    thickness: DEFAULT_WALL_THICKNESS,
    color,
  };
}

function createStarterWalls(): SketchWall[] {
  return [];
}

function createStarterRooms(): RoomFootprint[] {
  return [];
}

function findPlacement(width: number, depth: number, rooms: RoomFootprint[]): { x: number; y: number } {
  for (let y = GRID_STEP_METERS; y <= GRID_HEIGHT_METERS - depth - GRID_STEP_METERS; y += GRID_STEP_METERS) {
    for (let x = GRID_STEP_METERS; x <= GRID_WIDTH_METERS - width - GRID_STEP_METERS; x += GRID_STEP_METERS) {
      const overlaps = rooms.some(
        (room) =>
          x < room.x + room.width + GRID_STEP_METERS &&
          x + width > room.x - GRID_STEP_METERS &&
          y < room.y + room.depth + GRID_STEP_METERS &&
          y + depth > room.y - GRID_STEP_METERS,
      );

      if (!overlaps) {
        return { x, y };
      }
    }
  }

  return { x: GRID_STEP_METERS, y: GRID_STEP_METERS };
}

function clampGridPoint(x: number, y: number): THREE.Vector2 {
  return new THREE.Vector2(
    clampMeters(x, 0, GRID_WIDTH_METERS),
    clampMeters(y, 0, GRID_HEIGHT_METERS),
  );
}

function axisLockPoint(start: THREE.Vector2, candidate: THREE.Vector2): THREE.Vector2 {
  const dx = candidate.x - start.x;
  const dy = candidate.y - start.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return clampGridPoint(candidate.x, start.y);
  }

  return clampGridPoint(start.x, candidate.y);
}

function roomHandleUsesLeft(handle: RoomResizeHandle): boolean {
  return handle === "nw" || handle === "w" || handle === "sw";
}

function roomHandleUsesTop(handle: RoomResizeHandle): boolean {
  return handle === "nw" || handle === "n" || handle === "ne";
}

function roomHandleUsesRight(handle: RoomResizeHandle): boolean {
  return handle === "ne" || handle === "e" || handle === "se";
}

function roomHandleUsesBottom(handle: RoomResizeHandle): boolean {
  return handle === "sw" || handle === "s" || handle === "se";
}

function wallIsHorizontal(wall: SketchWall): boolean {
  return Math.abs(wall.x2 - wall.x1) >= Math.abs(wall.y2 - wall.y1);
}

function createBoundsHandleCandidates(bounds: LoopBounds): Array<{ handle: ResizeHandle; x: number; y: number }> {
  const midX = (bounds.minX + bounds.maxX) * 0.5;
  const midY = (bounds.minY + bounds.maxY) * 0.5;

  return [
    { handle: "nw", x: bounds.minX, y: bounds.minY },
    { handle: "n", x: midX, y: bounds.minY },
    { handle: "ne", x: bounds.maxX, y: bounds.minY },
    { handle: "e", x: bounds.maxX, y: midY },
    { handle: "se", x: bounds.maxX, y: bounds.maxY },
    { handle: "s", x: midX, y: bounds.maxY },
    { handle: "sw", x: bounds.minX, y: bounds.maxY },
    { handle: "w", x: bounds.minX, y: midY },
  ];
}

function wallEndpointKey(x: number, y: number): string {
  return `${snapMeters(x).toFixed(2)},${snapMeters(y).toFixed(2)}`;
}

function cloneRooms(rooms: RoomFootprint[]): RoomFootprint[] {
  return rooms.map((room) => ({ ...room }));
}

function cloneWalls(walls: SketchWall[]): SketchWall[] {
  return walls.map((wall) => ({ ...wall }));
}

function cloneSelection(selection: PlannerSelection): PlannerSelection {
  return selection ? { ...selection } : null;
}

function computeLoopBounds(walls: WallDragOrigin[]): LoopBounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const wall of walls) {
    minX = Math.min(minX, wall.x1, wall.x2);
    maxX = Math.max(maxX, wall.x1, wall.x2);
    minY = Math.min(minY, wall.y1, wall.y2);
    maxY = Math.max(maxY, wall.y1, wall.y2);
  }

  return { minX, maxX, minY, maxY };
}

function pickBoundsResizeHandle(bounds: LoopBounds, pointer: THREE.Vector2): ResizeHandle | null {
  const thresholdSq = HANDLE_PICK_RADIUS_METERS * HANDLE_PICK_RADIUS_METERS;
  let bestHandle: ResizeHandle | null = null;
  let bestDistanceSq = Number.POSITIVE_INFINITY;

  for (const candidate of createBoundsHandleCandidates(bounds)) {
    const dx = pointer.x - candidate.x;
    const dy = pointer.y - candidate.y;
    const distanceSq = dx * dx + dy * dy;

    if (distanceSq <= thresholdSq && distanceSq < bestDistanceSq) {
      bestHandle = candidate.handle;
      bestDistanceSq = distanceSq;
    }
  }

  return bestHandle;
}

function createSkyDomeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext("2d");

  if (!context) {
    const fallback = new THREE.CanvasTexture(canvas);
    fallback.colorSpace = THREE.SRGBColorSpace;
    return fallback;
  }

  const skyGradient = context.createLinearGradient(0, 0, 0, canvas.height);
  skyGradient.addColorStop(0, "#92b7d1");
  skyGradient.addColorStop(0.42, "#c6dbe6");
  skyGradient.addColorStop(0.62, "#eef2ee");
  skyGradient.addColorStop(0.82, "#f1e8da");
  skyGradient.addColorStop(1, "#d8ccb8");
  context.fillStyle = skyGradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const sunGlow = context.createRadialGradient(
    canvas.width * 0.72,
    canvas.height * 0.34,
    8,
    canvas.width * 0.72,
    canvas.height * 0.34,
    canvas.width * 0.22,
  );
  sunGlow.addColorStop(0, "rgba(255, 245, 221, 0.68)");
  sunGlow.addColorStop(0.18, "rgba(249, 225, 186, 0.34)");
  sunGlow.addColorStop(0.5, "rgba(247, 214, 171, 0.09)");
  sunGlow.addColorStop(1, "rgba(247, 214, 171, 0)");
  context.fillStyle = sunGlow;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.globalAlpha = 0.18;

  for (let index = 0; index < 5; index += 1) {
    const cloudX = canvas.width * (0.14 + index * 0.17);
    const cloudY = canvas.height * (0.22 + (index % 2) * 0.08);
    const cloud = context.createRadialGradient(cloudX, cloudY, 10, cloudX, cloudY, canvas.width * 0.12);
    cloud.addColorStop(0, "rgba(255,255,255,0.9)");
    cloud.addColorStop(0.55, "rgba(255,255,255,0.18)");
    cloud.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = cloud;
    context.beginPath();
    context.ellipse(cloudX, cloudY, canvas.width * 0.14, canvas.height * 0.05, 0, 0, Math.PI * 2);
    context.fill();
  }

  context.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function findClosedWallLoop(walls: SketchWall[], wallId: string): string[] | null {
  const wallById = new Map(walls.map((wall) => [wall.id, wall] as const));
  const wallsByEndpoint = new Map<string, string[]>();

  for (const wall of walls) {
    const startKey = wallEndpointKey(wall.x1, wall.y1);
    const endKey = wallEndpointKey(wall.x2, wall.y2);
    wallsByEndpoint.set(startKey, [...(wallsByEndpoint.get(startKey) ?? []), wall.id]);
    wallsByEndpoint.set(endKey, [...(wallsByEndpoint.get(endKey) ?? []), wall.id]);
  }

  const seed = wallById.get(wallId);

  if (!seed) {
    return null;
  }

  const queue = [seed.id];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentId = queue.shift()!;

    if (visited.has(currentId)) {
      continue;
    }

    visited.add(currentId);
    const current = wallById.get(currentId);

    if (!current) {
      continue;
    }

    const startNeighbors = wallsByEndpoint.get(wallEndpointKey(current.x1, current.y1)) ?? [];
    const endNeighbors = wallsByEndpoint.get(wallEndpointKey(current.x2, current.y2)) ?? [];

    for (const neighborId of [...startNeighbors, ...endNeighbors]) {
      if (!visited.has(neighborId)) {
        queue.push(neighborId);
      }
    }
  }

  if (visited.size < 3) {
    return null;
  }

  const degreeByEndpoint = new Map<string, number>();

  for (const id of visited) {
    const wall = wallById.get(id);

    if (!wall) {
      continue;
    }

    const startKey = wallEndpointKey(wall.x1, wall.y1);
    const endKey = wallEndpointKey(wall.x2, wall.y2);
    degreeByEndpoint.set(startKey, (degreeByEndpoint.get(startKey) ?? 0) + 1);
    degreeByEndpoint.set(endKey, (degreeByEndpoint.get(endKey) ?? 0) + 1);
  }

  if ([...degreeByEndpoint.values()].every((degree) => degree === 2)) {
    return [...visited];
  }

  return null;
}

function normalizeWallSegment(wall: SketchWall, previous: SketchWall): void {
  wall.x1 = clampMeters(wall.x1, 0, GRID_WIDTH_METERS);
  wall.y1 = clampMeters(wall.y1, 0, GRID_HEIGHT_METERS);
  wall.x2 = clampMeters(wall.x2, 0, GRID_WIDTH_METERS);
  wall.y2 = clampMeters(wall.y2, 0, GRID_HEIGHT_METERS);

  const dx = wall.x2 - wall.x1;
  const dy = wall.y2 - wall.y1;
  const horizontal = Math.abs(dx) >= Math.abs(dy);

  if (horizontal) {
    wall.y2 = wall.y1;
    let sign = Math.sign(dx);

    if (sign === 0) {
      sign = Math.sign(previous.x2 - previous.x1) || 1;
    }

    if (Math.abs(wall.x2 - wall.x1) < GRID_STEP_METERS) {
      wall.x2 = THREE.MathUtils.clamp(wall.x1 + sign * GRID_STEP_METERS, 0, GRID_WIDTH_METERS);

      if (Math.abs(wall.x2 - wall.x1) < GRID_STEP_METERS) {
        wall.x1 = THREE.MathUtils.clamp(wall.x2 - sign * GRID_STEP_METERS, 0, GRID_WIDTH_METERS);
      }
    }
  } else {
    wall.x2 = wall.x1;
    let sign = Math.sign(dy);

    if (sign === 0) {
      sign = Math.sign(previous.y2 - previous.y1) || 1;
    }

    if (Math.abs(wall.y2 - wall.y1) < GRID_STEP_METERS) {
      wall.y2 = THREE.MathUtils.clamp(wall.y1 + sign * GRID_STEP_METERS, 0, GRID_HEIGHT_METERS);

      if (Math.abs(wall.y2 - wall.y1) < GRID_STEP_METERS) {
        wall.y1 = THREE.MathUtils.clamp(wall.y2 - sign * GRID_STEP_METERS, 0, GRID_HEIGHT_METERS);
      }
    }
  }

  wall.x1 = snapMeters(wall.x1);
  wall.y1 = snapMeters(wall.y1);
  wall.x2 = snapMeters(wall.x2);
  wall.y2 = snapMeters(wall.y2);
  wall.height = THREE.MathUtils.clamp(wall.height, 2, 6);
  wall.thickness = THREE.MathUtils.clamp(wall.thickness, 0.08, 0.5);
}

export async function mountHouseLab(target: HTMLElement, options: HouseLabOptions): Promise<HouseLabHandle> {
  const presetMarkup = ROOM_PRESETS.map(
    (preset) => `
      <button class="house-preset-card" data-house-preset="${preset.label}" type="button">
        <strong>${preset.label}</strong>
        <span>${formatMeters(preset.width)} × ${formatMeters(preset.depth)}</span>
      </button>
    `,
  ).join("");

  target.innerHTML = `
    <div class="house-shell">
      <div class="house-lab-header">
        <div>
          <div class="house-lab-kicker">Planner Workspace</div>
          <h2>House Lab</h2>
          <p>Sketch wall runs in 2D, block in rooms fast, and keep the 3D massing preview live beside the drawing canvas.</p>
        </div>
        <div class="house-backend-chip">${options.hasNativeWebGPU ? "Preview: WebGPU" : "Preview: WebGL2 fallback"}</div>
      </div>
      <div class="house-help">
        <strong>${options.prefersTouchInput ? "Touch controls" : "Mouse controls"}</strong>
        <p>${
          options.prefersTouchInput
            ? "Walls is the default. Drag one finger to place wall segments and keep chaining them, use two fingers on the plan to pan and pinch-zoom, switch to Rooms to draw blocks, use Select to move or resize them, and tap Select to stop drawing. In the preview, orbit with one finger, pinch to zoom, and drag with two fingers to pan."
            : "Walls is the default. Left-drag to place a wall segment, then keep chaining from the released endpoint until you hit Escape. Right or middle drag pans the plan, the scroll wheel zooms, Rooms blocks out spaces, Select moves or resizes things, and Ctrl/Cmd+Z undoes planner edits."
        }</p>
      </div>
      <div class="house-workbench">
        <aside class="house-sidebar">
          <div class="house-section">
            <div class="house-section-title">Tools</div>
            <div class="house-tool-row">
              <button class="house-tool-button is-active" data-house-tool="walls" type="button">Walls</button>
              <button class="house-tool-button" data-house-tool="rooms" type="button">Rooms</button>
              <button class="house-tool-button" data-house-tool="select" type="button">Select</button>
            </div>
            <div class="house-action-row">
              <button class="house-secondary-button" data-house-action="delete" type="button">Delete selected</button>
              <button class="house-secondary-button" data-house-action="reset" type="button">Reset layout</button>
            </div>
          </div>
          <div class="house-section">
            <div class="house-section-title">Quick Add Rooms</div>
            <div class="house-preset-list">
              ${presetMarkup}
            </div>
          </div>
          <div class="house-section">
            <div class="house-section-title">Properties</div>
            <div class="house-properties-empty" data-house-properties-empty>Select a wall or room to tweak its dimensions, wall height, and thickness.</div>
            <div class="house-properties-form" data-house-properties-form hidden>
              <label class="house-field">
                <span data-house-field-label="label">Label</span>
                <input data-house-field="label" name="house-label" type="text" />
              </label>
              <div class="house-field-grid">
                <label class="house-field">
                  <span data-house-field-label="x">X</span>
                  <input data-house-field="x" name="house-x" type="number" step="${GRID_STEP_METERS}" min="0" max="${GRID_WIDTH_METERS}" />
                </label>
                <label class="house-field">
                  <span data-house-field-label="y">Y</span>
                  <input data-house-field="y" name="house-y" type="number" step="${GRID_STEP_METERS}" min="0" max="${GRID_HEIGHT_METERS}" />
                </label>
                <label class="house-field">
                  <span data-house-field-label="width">Width</span>
                  <input data-house-field="width" name="house-width" type="number" step="${GRID_STEP_METERS}" min="${GRID_STEP_METERS}" max="${GRID_WIDTH_METERS}" />
                </label>
                <label class="house-field">
                  <span data-house-field-label="depth">Depth</span>
                  <input data-house-field="depth" name="house-depth" type="number" step="${GRID_STEP_METERS}" min="${GRID_STEP_METERS}" max="${GRID_HEIGHT_METERS}" />
                </label>
                <label class="house-field">
                  <span data-house-field-label="height">Wall height</span>
                  <input data-house-field="height" name="house-height" type="number" step="0.1" min="2" max="6" />
                </label>
                <label class="house-field">
                  <span data-house-field-label="wallThickness">Wall thickness</span>
                  <input data-house-field="wallThickness" name="house-wall-thickness" type="number" step="0.02" min="0.08" max="0.5" />
                </label>
              </div>
              <div class="house-room-summary" data-house-room-summary></div>
            </div>
          </div>
        </aside>
        <section class="house-plan-column">
          <div class="house-panel-card">
            <div class="house-panel-header">
              <div>
                <strong>2D Floor Plan</strong>
                <span>${
                  options.prefersTouchInput
                    ? `One grid step is ${formatMeters(GRID_STEP_METERS)}. One finger places wall segments or edits shapes, two fingers pan and pinch-zoom the plan, and the Select tool stops wall chaining.`
                    : `One grid step is ${formatMeters(GRID_STEP_METERS)}. Left-drag to place wall segments and chain them, press Escape to return to Select, right or middle drag to pan, scroll to zoom, and drag closed wall loops as one.`
                }</span>
              </div>
              <div class="house-panel-meta">${formatMeters(GRID_WIDTH_METERS)} × ${formatMeters(GRID_HEIGHT_METERS)}</div>
            </div>
            <div class="house-grid-wrap">
              <div class="house-grid-surface" data-house-grid-surface>
                <svg
                  class="house-grid-svg"
                  data-house-grid-svg
                  viewBox="0 0 ${GRID_WIDTH_METERS * PIXELS_PER_METER} ${GRID_HEIGHT_METERS * PIXELS_PER_METER}"
                ></svg>
              </div>
            </div>
          </div>
        </section>
        <section class="house-preview-column">
          <div class="house-panel-card house-preview-card">
            <div class="house-panel-header">
              <div>
                <strong>3D Preview</strong>
                <span>${options.prefersTouchInput ? "Orbit with one finger, pinch to zoom, and drag with two fingers to pan." : "Drag to orbit, scroll to zoom, and right-drag to pan the camera."}</span>
              </div>
              <div class="house-panel-meta">Live massing</div>
            </div>
            <div class="house-preview-viewport" data-house-preview-viewport></div>
          </div>
        </section>
      </div>
    </div>
  `;

  const gridSurface = target.querySelector<HTMLDivElement>("[data-house-grid-surface]");
  const gridSvg = target.querySelector<SVGSVGElement>("[data-house-grid-svg]");
  const previewHost = target.querySelector<HTMLDivElement>("[data-house-preview-viewport]");
  const propertiesEmpty = target.querySelector<HTMLDivElement>("[data-house-properties-empty]");
  const propertiesForm = target.querySelector<HTMLDivElement>("[data-house-properties-form]");
  const roomSummary = target.querySelector<HTMLDivElement>("[data-house-room-summary]");
  const toolButtons = [...target.querySelectorAll<HTMLButtonElement>("[data-house-tool]")];
  const presetButtons = [...target.querySelectorAll<HTMLButtonElement>("[data-house-preset]")];
  const deleteButton = target.querySelector<HTMLButtonElement>("[data-house-action='delete']");
  const resetButton = target.querySelector<HTMLButtonElement>("[data-house-action='reset']");
  const fieldLabelEls = {
    label: target.querySelector<HTMLSpanElement>("[data-house-field-label='label']"),
    x: target.querySelector<HTMLSpanElement>("[data-house-field-label='x']"),
    y: target.querySelector<HTMLSpanElement>("[data-house-field-label='y']"),
    width: target.querySelector<HTMLSpanElement>("[data-house-field-label='width']"),
    depth: target.querySelector<HTMLSpanElement>("[data-house-field-label='depth']"),
    height: target.querySelector<HTMLSpanElement>("[data-house-field-label='height']"),
    wallThickness: target.querySelector<HTMLSpanElement>("[data-house-field-label='wallThickness']"),
  };
  const fieldInputs = {
    label: target.querySelector<HTMLInputElement>("[data-house-field='label']"),
    x: target.querySelector<HTMLInputElement>("[data-house-field='x']"),
    y: target.querySelector<HTMLInputElement>("[data-house-field='y']"),
    width: target.querySelector<HTMLInputElement>("[data-house-field='width']"),
    depth: target.querySelector<HTMLInputElement>("[data-house-field='depth']"),
    height: target.querySelector<HTMLInputElement>("[data-house-field='height']"),
    wallThickness: target.querySelector<HTMLInputElement>("[data-house-field='wallThickness']"),
  };

  if (
    !gridSurface ||
    !gridSvg ||
    !previewHost ||
    !propertiesEmpty ||
    !propertiesForm ||
    !roomSummary ||
    !deleteButton ||
    !resetButton ||
    Object.values(fieldLabelEls).some((value) => !value) ||
    Object.values(fieldInputs).some((value) => !value)
  ) {
    throw new Error("House Lab failed to mount required UI elements.");
  }

  const state = {
    tool: "walls" as HouseTool,
    rooms: createStarterRooms(),
    walls: createStarterWalls(),
    selection: null as PlannerSelection,
    draft: null as DraftShape,
    dragRoomId: null as string | null,
    dragRoomOffset: null as THREE.Vector2 | null,
    dragWallId: null as string | null,
    dragWallStartPointer: null as THREE.Vector2 | null,
    dragWallOrigins: null as WallDragOrigin[] | null,
    resizeRoomId: null as string | null,
    resizeRoomHandle: null as RoomResizeHandle | null,
    resizeRoomAnchor: null as THREE.Vector2 | null,
    resizeRoomBounds: null as LoopBounds | null,
    resizeWallId: null as string | null,
    resizeWallHandle: null as WallResizeHandle | null,
    resizeLoopWallIds: null as string[] | null,
    resizeLoopOrigins: null as WallDragOrigin[] | null,
    resizeLoopHandle: null as PolygonResizeHandle | null,
    resizeLoopBounds: null as LoopBounds | null,
    panPlanPointerId: null as number | null,
    panPlanStartClient: null as THREE.Vector2 | null,
    planViewOffset: new THREE.Vector2(0, 0),
    planViewStartOffset: null as THREE.Vector2 | null,
    planViewZoom: 1,
    zoomPlanPointerId: null as number | null,
    zoomPlanStartClientY: 0,
    zoomPlanStartValue: 1,
    zoomPlanAnchorRatio: null as THREE.Vector2 | null,
    zoomPlanAnchorGrid: null as THREE.Vector2 | null,
    touchPoints: new Map<number, THREE.Vector2>(),
    touchGestureActive: false,
    touchGestureStartDistance: 0,
    touchGestureStartZoom: 1,
    touchGestureAnchorGrid: null as THREE.Vector2 | null,
    history: [] as PlannerSnapshot[],
    isVisible: false,
    previewDirty: true,
    planDirty: true,
  };

  state.selection = null;

  const selectedRoom = () =>
    state.selection?.kind === "room"
      ? state.rooms.find((room) => room.id === state.selection?.id) ?? null
      : null;

  const selectedWall = () =>
    state.selection?.kind === "wall"
      ? state.walls.find((wall) => wall.id === state.selection?.id) ?? null
      : null;

  const snapshotPlanner = (): PlannerSnapshot => ({
    rooms: cloneRooms(state.rooms),
    walls: cloneWalls(state.walls),
    selection: cloneSelection(state.selection),
    tool: state.tool,
  });

  const clearTransientInteractionState = () => {
    state.draft = null;
    state.dragRoomId = null;
    state.dragRoomOffset = null;
    state.dragWallId = null;
    state.dragWallStartPointer = null;
    state.dragWallOrigins = null;
    state.resizeRoomId = null;
    state.resizeRoomHandle = null;
    state.resizeRoomAnchor = null;
    state.resizeRoomBounds = null;
    state.resizeWallId = null;
    state.resizeWallHandle = null;
    state.resizeLoopWallIds = null;
    state.resizeLoopOrigins = null;
    state.resizeLoopHandle = null;
    state.resizeLoopBounds = null;
    state.panPlanPointerId = null;
    state.panPlanStartClient = null;
    state.planViewStartOffset = null;
    state.zoomPlanPointerId = null;
    state.zoomPlanStartClientY = 0;
    state.zoomPlanStartValue = state.planViewZoom;
    state.zoomPlanAnchorRatio = null;
    state.zoomPlanAnchorGrid = null;
    state.touchGestureActive = false;
    state.touchGestureStartDistance = 0;
    state.touchGestureStartZoom = state.planViewZoom;
    state.touchGestureAnchorGrid = null;
  };

  const pushHistory = () => {
    state.history.push(snapshotPlanner());

    if (state.history.length > 120) {
      state.history.shift();
    }
  };

  const undoPlanner = () => {
    const snapshot = state.history.pop();

    if (!snapshot) {
      return;
    }

    state.rooms = cloneRooms(snapshot.rooms);
    state.walls = cloneWalls(snapshot.walls);
    state.selection = cloneSelection(snapshot.selection);
    state.tool = snapshot.tool;
    clearTransientInteractionState();
    syncToolButtons();
    requestRefresh();
  };

  const initialBodyOverflow = document.body.style.overflow;
  const initialHtmlOverflow = document.documentElement.style.overflow;
  const initialBodyTouchAction = document.body.style.touchAction;
  const initialHtmlOverscroll = document.documentElement.style.overscrollBehavior;
  let interactionScrollLocked = false;

  const setInteractionScrollLock = (locked: boolean) => {
    if (interactionScrollLocked === locked) {
      return;
    }

    interactionScrollLocked = locked;
    document.body.style.overflow = locked ? "hidden" : initialBodyOverflow;
    document.documentElement.style.overflow = locked ? "hidden" : initialHtmlOverflow;
    document.body.style.touchAction = locked ? "none" : initialBodyTouchAction;
    document.documentElement.style.overscrollBehavior = locked ? "none" : initialHtmlOverscroll;
  };

  const worldFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_WIDTH_METERS * 3.2, GRID_HEIGHT_METERS * 3.2),
    new THREE.MeshStandardMaterial({
      color: "#c4c4bb",
      roughness: 1,
      metalness: 0.01,
    }),
  );
  worldFloor.rotation.x = -Math.PI / 2;
  worldFloor.receiveShadow = true;

  const sitePad = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_WIDTH_METERS + 5.5, GRID_HEIGHT_METERS + 5.5),
    new THREE.MeshStandardMaterial({
      color: "#e8e0d2",
      roughness: 0.98,
      metalness: 0.02,
    }),
  );
  sitePad.rotation.x = -Math.PI / 2;
  sitePad.position.y = 0.003;
  sitePad.receiveShadow = true;

  const skyDomeTexture = createSkyDomeTexture();
  const skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(80, 48, 24),
    new THREE.MeshBasicMaterial({
      map: skyDomeTexture,
      side: THREE.BackSide,
      fog: false,
    }),
  );
  skyDome.position.y = 8;
  skyDome.renderOrder = -10;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#d7e0df");
  scene.fog = new THREE.Fog("#e8ece7", 28, 66);
  scene.add(skyDome, worldFloor, sitePad);

  const gridHelper = new THREE.GridHelper(
    Math.max(GRID_WIDTH_METERS, GRID_HEIGHT_METERS) * 2.4,
    Math.max(GRID_COLUMNS, GRID_ROWS) * 2,
    "#b9c5ce",
    "#d9d7cf",
  );
  gridHelper.position.y = 0.002;
  const gridMaterials = Array.isArray(gridHelper.material) ? gridHelper.material : [gridHelper.material];
  for (const material of gridMaterials) {
    material.transparent = true;
    material.opacity = 0.42;
  }
  scene.add(gridHelper);

  const ambient = new THREE.AmbientLight("#f6f0e5", 0.78);
  const hemi = new THREE.HemisphereLight("#eef3ef", "#b8b0a3", 1.25);
  const sun = new THREE.DirectionalLight("#f9edd8", 1.85);
  sun.position.set(10.5, 14.2, 8.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -18;
  sun.shadow.camera.right = 18;
  sun.shadow.camera.top = 18;
  sun.shadow.camera.bottom = -18;
  sun.shadow.normalBias = 0.12;
  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(0, 0, 0);
  sun.target = sunTarget;
  const fill = new THREE.DirectionalLight("#d9d5ca", 0.36);
  fill.position.set(-9, 7.8, -6.5);
  const rim = new THREE.PointLight("#f1e7d4", 1.9, 26, 2);
  rim.position.set(-8.5, 4.8, -7.6);
  scene.add(ambient, hemi, sun, sunTarget, fill, rim);

  const previewRooms = new THREE.Group();
  const previewWalls = new THREE.Group();
  scene.add(previewRooms, previewWalls);
  const previewBoxGeometry = new THREE.BoxGeometry(1, 1, 1);

  type RoomPreviewEntry = {
    group: THREE.Group;
    plate: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
    volume: THREE.Mesh<THREE.BoxGeometry, THREE.MeshPhysicalMaterial>;
    topCap: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  };

  type WallPreviewEntry = {
    mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  };

  const roomPreviewEntries = new Map<string, RoomPreviewEntry>();
  const wallPreviewEntries = new Map<string, WallPreviewEntry>();

  const createRoomPreviewEntry = (): RoomPreviewEntry => {
    const group = new THREE.Group();

    const plate = new THREE.Mesh(
      previewBoxGeometry,
      new THREE.MeshStandardMaterial({
        roughness: 0.98,
        metalness: 0.02,
      }),
    );
    plate.receiveShadow = true;

    const volume = new THREE.Mesh(
      previewBoxGeometry,
      new THREE.MeshPhysicalMaterial({
        roughness: 0.42,
        metalness: 0.02,
        transparent: true,
        opacity: 0.52,
        transmission: 0.08,
        thickness: 0.28,
        clearcoat: 0.14,
        clearcoatRoughness: 0.36,
      }),
    );
    volume.castShadow = true;
    volume.receiveShadow = true;

    const topCap = new THREE.Mesh(
      previewBoxGeometry,
      new THREE.MeshStandardMaterial({
        roughness: 0.74,
        metalness: 0.02,
      }),
    );
    topCap.castShadow = true;
    topCap.receiveShadow = true;

    group.add(plate, volume, topCap);
    previewRooms.add(group);

    return { group, plate, volume, topCap };
  };

  const disposeRoomPreviewEntry = (entry: RoomPreviewEntry) => {
    previewRooms.remove(entry.group);
    entry.plate.material.dispose();
    entry.volume.material.dispose();
    entry.topCap.material.dispose();
  };

  const createWallPreviewEntry = (): WallPreviewEntry => {
    const mesh = new THREE.Mesh(
      previewBoxGeometry,
      new THREE.MeshStandardMaterial({
        roughness: 0.86,
        metalness: 0.02,
      }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    previewWalls.add(mesh);
    return { mesh };
  };

  const disposeWallPreviewEntry = (entry: WallPreviewEntry) => {
    previewWalls.remove(entry.mesh);
    entry.mesh.material.dispose();
  };

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(12.5, 9.2, 12.5);

  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  await renderer.init();
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.touchAction = "none";
  previewHost.append(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = true;
  controls.zoomToCursor = true;
  controls.target.set(0, 1.4, 0);
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };
  controls.minDistance = 4;
  controls.maxDistance = 32;
  controls.update();

  let previewWidth = 0;
  let previewHeight = 0;
  let previewSizeDirty = true;
  let disposed = false;
  let renderFrame = 0;

  const syncPreviewSize = () => {
    const width = Math.max(previewHost.clientWidth, 1);
    const height = Math.max(previewHost.clientHeight, 1);
    previewSizeDirty = false;

    if (width === previewWidth && height === previewHeight) {
      return;
    }

    previewWidth = width;
    previewHeight = height;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };

  const planWidthPx = GRID_WIDTH_METERS * PIXELS_PER_METER;
  const planHeightPx = GRID_HEIGHT_METERS * PIXELS_PER_METER;
  const minorStepPx = GRID_STEP_METERS * PIXELS_PER_METER;
  const gridBackdropMarkup = (() => {
    const parts: string[] = [
      `<rect class="house-grid-board" x="0" y="0" width="${planWidthPx}" height="${planHeightPx}" rx="0" ry="0" />`,
      `<rect class="house-grid-ruler-band" x="0" y="0" width="${planWidthPx}" height="${minorStepPx * 1.4}" />`,
    ];

    for (let column = 0; column <= GRID_COLUMNS; column += 1) {
      const x = column * minorStepPx;
      const isMajor = column % 2 === 0;
      parts.push(
        `<line class="${isMajor ? "house-grid-line-major" : "house-grid-line-minor"}" x1="${x}" y1="0" x2="${x}" y2="${planHeightPx}" />`,
      );

      if (column < GRID_COLUMNS && isMajor) {
        const meterMark = (column * GRID_STEP_METERS).toFixed(1);
        parts.push(
          `<text class="house-grid-ruler" x="${x + 6}" y="${minorStepPx * 0.9}">${meterMark} m</text>`,
        );
      }
    }

    for (let row = 0; row <= GRID_ROWS; row += 1) {
      const y = row * minorStepPx;
      const isMajor = row % 2 === 0;
      parts.push(
        `<line class="${isMajor ? "house-grid-line-major" : "house-grid-line-minor"}" x1="0" y1="${y}" x2="${planWidthPx}" y2="${y}" />`,
      );
    }

    return parts.join("");
  })();

  const rebuildPreview = () => {
    const nextRoomIds = new Set(state.rooms.map((room) => room.id));
    for (const [roomId, entry] of roomPreviewEntries) {
      if (!nextRoomIds.has(roomId)) {
        disposeRoomPreviewEntry(entry);
        roomPreviewEntries.delete(roomId);
      }
    }

    const nextWallIds = new Set(state.walls.map((wall) => wall.id));
    for (const [wallId, entry] of wallPreviewEntries) {
      if (!nextWallIds.has(wallId)) {
        disposeWallPreviewEntry(entry);
        wallPreviewEntries.delete(wallId);
      }
    }

    for (const room of state.rooms) {
      const selected = state.selection?.kind === "room" && state.selection.id === room.id;
      const baseColor = new THREE.Color(room.color);
      const plateColor = baseColor.clone().lerp(new THREE.Color("#e7dfd1"), 0.72);
      const volumeColor = baseColor.clone().lerp(new THREE.Color("#f3ede2"), 0.42);
      const topColor = baseColor.clone().lerp(new THREE.Color("#ffffff"), 0.55);
      const volumeWidth = Math.max(room.width - 0.14, 0.18);
      const volumeDepth = Math.max(room.depth - 0.14, 0.18);
      const volumeHeight = Math.max(room.height - 0.12, 0.18);
      const topWidth = Math.max(room.width - 0.1, 0.2);
      const topDepth = Math.max(room.depth - 0.1, 0.2);
      const centerX = roomCenterX(room);
      const centerZ = roomCenterZ(room);
      const entry = roomPreviewEntries.get(room.id) ?? createRoomPreviewEntry();
      roomPreviewEntries.set(room.id, entry);

      entry.plate.scale.set(room.width, 0.08, room.depth);
      entry.plate.position.set(centerX, 0.04, centerZ);
      entry.plate.material.color.copy(plateColor);
      entry.plate.material.emissive.copy(selected ? baseColor.clone().multiplyScalar(0.1) : new THREE.Color("#000000"));
      entry.plate.material.emissiveIntensity = selected ? 0.6 : 0;

      entry.volume.scale.set(volumeWidth, volumeHeight, volumeDepth);
      entry.volume.position.set(centerX, volumeHeight * 0.5 + 0.08, centerZ);
      entry.volume.material.color.copy(volumeColor);
      entry.volume.material.opacity = selected ? 0.72 : 0.52;
      entry.volume.material.emissive.copy(selected ? baseColor.clone().multiplyScalar(0.12) : new THREE.Color("#000000"));
      entry.volume.material.emissiveIntensity = selected ? 0.55 : 0;

      entry.topCap.scale.set(topWidth, 0.035, topDepth);
      entry.topCap.position.set(centerX, room.height + 0.02, centerZ);
      entry.topCap.material.color.copy(topColor);
      entry.topCap.material.emissive.copy(selected ? baseColor.clone().multiplyScalar(0.16) : new THREE.Color("#000000"));
      entry.topCap.material.emissiveIntensity = selected ? 0.35 : 0;
    }

    for (const wall of state.walls) {
      const selected = state.selection?.kind === "wall" && state.selection.id === wall.id;
      const length = wallLength(wall);
      const horizontal = Math.abs(wall.x2 - wall.x1) >= Math.abs(wall.y2 - wall.y1);
      const entry = wallPreviewEntries.get(wall.id) ?? createWallPreviewEntry();
      wallPreviewEntries.set(wall.id, entry);

      entry.mesh.scale.set(
        horizontal ? length : wall.thickness,
        wall.height,
        horizontal ? wall.thickness : length,
      );
      entry.mesh.position.set(wallCenterX(wall), wall.height * 0.5, wallCenterZ(wall));
      entry.mesh.material.color.set(selected ? "#efe4d4" : new THREE.Color(wall.color).lerp(new THREE.Color("#d4ccbf"), 0.78));
      entry.mesh.material.emissive.set(selected ? "#e6c29a" : "#000000");
      entry.mesh.material.emissiveIntensity = selected ? 0.08 : 0;
    }

    state.previewDirty = false;
  };

  const renderPlan = () => {
    const selectedId = state.selection?.id ?? "";
    const selectedKind = state.selection?.kind ?? "";
    const viewLeftPx = state.planViewOffset.x * PIXELS_PER_METER;
    const viewTopPx = state.planViewOffset.y * PIXELS_PER_METER;
    const viewWidthPx = planVisibleWidth() * PIXELS_PER_METER;
    const viewHeightPx = planVisibleHeight() * PIXELS_PER_METER;

    const roomMarkup = state.rooms
      .map((room) => {
        const selected = selectedKind === "room" && room.id === selectedId;
        const x = room.x * PIXELS_PER_METER;
        const y = room.y * PIXELS_PER_METER;
        const width = room.width * PIXELS_PER_METER;
        const height = room.depth * PIXELS_PER_METER;
        const midX = x + width * 0.5;
        const midY = y + height * 0.5;
        const fill = new THREE.Color(room.color).lerp(new THREE.Color("#ffffff"), 0.58).getStyle();
        const stroke = new THREE.Color(room.color).offsetHSL(0, 0, selected ? -0.08 : -0.18).getStyle();
        const handles = selected
          ? `
            <g class="house-room-handles">
              <circle class="house-room-handle-hit" data-room-id="${room.id}" data-room-handle="nw" cx="${x}" cy="${y}" r="14" />
              <circle class="house-room-handle-hit" data-room-id="${room.id}" data-room-handle="n" cx="${midX}" cy="${y}" r="14" />
              <circle class="house-room-handle-hit" data-room-id="${room.id}" data-room-handle="ne" cx="${x + width}" cy="${y}" r="14" />
              <circle class="house-room-handle-hit" data-room-id="${room.id}" data-room-handle="e" cx="${x + width}" cy="${midY}" r="14" />
              <circle class="house-room-handle-hit" data-room-id="${room.id}" data-room-handle="se" cx="${x + width}" cy="${y + height}" r="14" />
              <circle class="house-room-handle-hit" data-room-id="${room.id}" data-room-handle="s" cx="${midX}" cy="${y + height}" r="14" />
              <circle class="house-room-handle-hit" data-room-id="${room.id}" data-room-handle="sw" cx="${x}" cy="${y + height}" r="14" />
              <circle class="house-room-handle-hit" data-room-id="${room.id}" data-room-handle="w" cx="${x}" cy="${midY}" r="14" />
              <circle class="house-room-handle" cx="${x}" cy="${y}" r="5.5" />
              <circle class="house-room-handle house-room-handle-edge" cx="${midX}" cy="${y}" r="5.5" />
              <circle class="house-room-handle" cx="${x + width}" cy="${y}" r="5.5" />
              <circle class="house-room-handle house-room-handle-edge" cx="${x + width}" cy="${midY}" r="5.5" />
              <circle class="house-room-handle" cx="${x + width}" cy="${y + height}" r="5.5" />
              <circle class="house-room-handle house-room-handle-edge" cx="${midX}" cy="${y + height}" r="5.5" />
              <circle class="house-room-handle" cx="${x}" cy="${y + height}" r="5.5" />
              <circle class="house-room-handle house-room-handle-edge" cx="${x}" cy="${midY}" r="5.5" />
            </g>
          `
          : "";

        return `
          <g class="house-room${selected ? " is-selected" : ""}" data-room-id="${room.id}">
            <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="16" ry="16" fill="${fill}" stroke="${stroke}" stroke-width="${selected ? 4 : 2}" />
            <text x="${x + width / 2}" y="${y + height / 2 - 8}" text-anchor="middle" class="house-room-label">${room.label}</text>
            <text x="${x + width / 2}" y="${y + height / 2 + 16}" text-anchor="middle" class="house-room-dim">${formatMeters(room.width)} × ${formatMeters(room.depth)}</text>
            ${handles}
          </g>
        `;
      })
      .join("");

    let loopHandleMarkup = "";
    const selectedWallItem = selectedKind === "wall" ? state.walls.find((wall) => wall.id === selectedId) ?? null : null;

    if (selectedWallItem) {
      const selectedLoopIds = findClosedWallLoop(state.walls, selectedWallItem.id);

      if (selectedLoopIds) {
        const selectedLoopBounds = computeLoopBounds(
          selectedLoopIds
            .map((id) => state.walls.find((wall) => wall.id === id))
            .filter((wall): wall is SketchWall => !!wall)
            .map((wall) => ({
              id: wall.id,
              x1: wall.x1,
              y1: wall.y1,
              x2: wall.x2,
              y2: wall.y2,
            })),
        );

        loopHandleMarkup = createBoundsHandleCandidates(selectedLoopBounds)
          .map((candidate) => {
            const cx = candidate.x * PIXELS_PER_METER;
            const cy = candidate.y * PIXELS_PER_METER;
            const edgeClass = candidate.handle.length === 1 ? " house-loop-handle-edge" : "";

            return `
              <circle class="house-loop-handle-hit" data-loop-handle="${candidate.handle}" cx="${cx}" cy="${cy}" r="14" />
              <circle class="house-loop-handle${edgeClass}" cx="${cx}" cy="${cy}" r="5.5" />
            `;
          })
          .join("");
      }
    }

    const wallMarkup = state.walls
      .map((wall) => {
        const selected = selectedKind === "wall" && wall.id === selectedId;
        const x1 = wall.x1 * PIXELS_PER_METER;
        const y1 = wall.y1 * PIXELS_PER_METER;
        const x2 = wall.x2 * PIXELS_PER_METER;
        const y2 = wall.y2 * PIXELS_PER_METER;
        const horizontal = Math.abs(wall.x2 - wall.x1) >= Math.abs(wall.y2 - wall.y1);
        const labelX = (x1 + x2) * 0.5 + (horizontal ? 0 : 22);
        const labelY = (y1 + y2) * 0.5 + (horizontal ? -16 : 4);
        const handles = selected
          ? `
            <circle class="house-wall-handle-hit" data-wall-id="${wall.id}" data-wall-handle="start" cx="${x1}" cy="${y1}" r="14" />
            <circle class="house-wall-handle-hit" data-wall-id="${wall.id}" data-wall-handle="end" cx="${x2}" cy="${y2}" r="14" />
          `
          : "";

        return `
          <g class="house-wall${selected ? " is-selected" : ""}" data-wall-id="${wall.id}">
            <line class="house-wall-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
            <line class="house-wall-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
            ${handles}
            <circle class="house-wall-node" cx="${x1}" cy="${y1}" r="4.5" />
            <circle class="house-wall-node" cx="${x2}" cy="${y2}" r="4.5" />
            <text x="${labelX}" y="${labelY}" text-anchor="middle" class="house-wall-label">${formatMeters(wallLength(wall))}</text>
          </g>
        `;
      })
      .join("");

    let draftMarkup = "";

    if (state.draft?.kind === "room") {
      const startX = Math.min(state.draft.start.x, state.draft.current.x);
      const startY = Math.min(state.draft.start.y, state.draft.current.y);
      const width = Math.max(GRID_STEP_METERS, Math.abs(state.draft.current.x - state.draft.start.x));
      const depth = Math.max(GRID_STEP_METERS, Math.abs(state.draft.current.y - state.draft.start.y));

      draftMarkup = `
        <rect
          class="house-draft-room"
          x="${startX * PIXELS_PER_METER}"
          y="${startY * PIXELS_PER_METER}"
          width="${width * PIXELS_PER_METER}"
          height="${depth * PIXELS_PER_METER}"
          rx="16"
          ry="16"
        />
      `;
    }

    if (state.draft?.kind === "wall") {
      const x1 = state.draft.start.x * PIXELS_PER_METER;
      const y1 = state.draft.start.y * PIXELS_PER_METER;
      const x2 = state.draft.current.x * PIXELS_PER_METER;
      const y2 = state.draft.current.y * PIXELS_PER_METER;
      const horizontal = Math.abs(state.draft.current.x - state.draft.start.x) >= Math.abs(state.draft.current.y - state.draft.start.y);
      const labelX = (x1 + x2) * 0.5 + (horizontal ? 0 : 22);
      const labelY = (y1 + y2) * 0.5 + (horizontal ? -16 : 4);
      const draftLength = Math.abs(state.draft.current.x - state.draft.start.x) + Math.abs(state.draft.current.y - state.draft.start.y);

      draftMarkup = `
        <g class="house-draft-wall">
          <line class="house-draft-wall-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
          <line class="house-draft-wall-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
          <text x="${labelX}" y="${labelY}" text-anchor="middle" class="house-wall-label">${formatMeters(draftLength)}</text>
        </g>
      `;
    }

    gridSvg.setAttribute("viewBox", `${viewLeftPx} ${viewTopPx} ${viewWidthPx} ${viewHeightPx}`);
    gridSvg.innerHTML = `${gridBackdropMarkup}${roomMarkup}${wallMarkup}${loopHandleMarkup}${draftMarkup}`;
    state.planDirty = false;
  };

  const syncToolButtons = () => {
    toolButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.houseTool === state.tool);
    });
  };

  const syncProperties = () => {
    const room = selectedRoom();
    const wall = selectedWall();
    const hasSelection = !!room || !!wall;

    propertiesEmpty.hidden = hasSelection;
    propertiesForm.hidden = !hasSelection;
    deleteButton.disabled = !hasSelection;

    if (!hasSelection) {
      roomSummary.textContent = "";
      return;
    }

    if (room) {
      fieldLabelEls.label!.textContent = "Label";
      fieldLabelEls.x!.textContent = "X";
      fieldLabelEls.y!.textContent = "Y";
      fieldLabelEls.width!.textContent = "Width";
      fieldLabelEls.depth!.textContent = "Depth";
      fieldLabelEls.height!.textContent = "Wall height";
      fieldLabelEls.wallThickness!.textContent = "Wall thickness";
      fieldInputs.label!.value = room.label;
      fieldInputs.x!.value = room.x.toFixed(1);
      fieldInputs.y!.value = room.y.toFixed(1);
      fieldInputs.width!.value = room.width.toFixed(1);
      fieldInputs.depth!.value = room.depth.toFixed(1);
      fieldInputs.height!.value = room.height.toFixed(1);
      fieldInputs.wallThickness!.value = room.wallThickness.toFixed(2);
      roomSummary.textContent = `Room footprint ${formatMeters(room.width)} × ${formatMeters(room.depth)} | Wall height ${formatMeters(room.height)}`;
      return;
    }

    if (wall) {
      fieldLabelEls.label!.textContent = "Label";
      fieldLabelEls.x!.textContent = "Start X";
      fieldLabelEls.y!.textContent = "Start Y";
      fieldLabelEls.width!.textContent = "End X";
      fieldLabelEls.depth!.textContent = "End Y";
      fieldLabelEls.height!.textContent = "Wall height";
      fieldLabelEls.wallThickness!.textContent = "Wall thickness";
      fieldInputs.label!.value = wall.label;
      fieldInputs.x!.value = wall.x1.toFixed(1);
      fieldInputs.y!.value = wall.y1.toFixed(1);
      fieldInputs.width!.value = wall.x2.toFixed(1);
      fieldInputs.depth!.value = wall.y2.toFixed(1);
      fieldInputs.height!.value = wall.height.toFixed(1);
      fieldInputs.wallThickness!.value = wall.thickness.toFixed(2);
      roomSummary.textContent = `${formatWallOrientation(wall)} wall | Length ${formatMeters(wallLength(wall))} | Height ${formatMeters(wall.height)}`;
    }
  };

  const requestRefresh = () => {
    state.planDirty = true;
    state.previewDirty = true;
    syncProperties();
  };

  const requestPlanRefresh = () => {
    state.planDirty = true;
  };

  const planVisibleWidth = (zoom = state.planViewZoom) => GRID_WIDTH_METERS / zoom;
  const planVisibleHeight = (zoom = state.planViewZoom) => GRID_HEIGHT_METERS / zoom;

  const clampPlanOffset = (offset: THREE.Vector2, zoom = state.planViewZoom): THREE.Vector2 => {
    const visibleWidth = planVisibleWidth(zoom);
    const visibleHeight = planVisibleHeight(zoom);
    const centeredOffsetX = (GRID_WIDTH_METERS - visibleWidth) * 0.5;
    const centeredOffsetY = (GRID_HEIGHT_METERS - visibleHeight) * 0.5;
    const minOffsetX = visibleWidth >= GRID_WIDTH_METERS ? centeredOffsetX - PLAN_PAN_MARGIN_METERS : -PLAN_PAN_MARGIN_METERS;
    const maxOffsetX = visibleWidth >= GRID_WIDTH_METERS
      ? centeredOffsetX + PLAN_PAN_MARGIN_METERS
      : GRID_WIDTH_METERS - visibleWidth + PLAN_PAN_MARGIN_METERS;
    const minOffsetY = visibleHeight >= GRID_HEIGHT_METERS ? centeredOffsetY - PLAN_PAN_MARGIN_METERS : -PLAN_PAN_MARGIN_METERS;
    const maxOffsetY = visibleHeight >= GRID_HEIGHT_METERS
      ? centeredOffsetY + PLAN_PAN_MARGIN_METERS
      : GRID_HEIGHT_METERS - visibleHeight + PLAN_PAN_MARGIN_METERS;

    return new THREE.Vector2(
      THREE.MathUtils.clamp(offset.x, minOffsetX, maxOffsetX),
      THREE.MathUtils.clamp(offset.y, minOffsetY, maxOffsetY),
    );
  };

  const addPreset = (preset: RoomPreset) => {
    pushHistory();
    const placement = findPlacement(preset.width, preset.depth, state.rooms);
    const count = state.rooms.filter((room) => room.label.startsWith(preset.label)).length;
    const room = createRoomFromPreset(preset, placement.x, placement.y, count);
    state.rooms.push(room);
    state.selection = {
      kind: "room",
      id: room.id,
    };
    state.tool = "select";
    syncToolButtons();
    requestRefresh();
  };

  const updateSelectedRoom = (mutator: (room: RoomFootprint) => void) => {
    const room = selectedRoom();

    if (!room) {
      return;
    }

    pushHistory();
    mutator(room);
    room.width = clampMeters(room.width, GRID_STEP_METERS, GRID_WIDTH_METERS);
    room.depth = clampMeters(room.depth, GRID_STEP_METERS, GRID_HEIGHT_METERS);
    room.height = THREE.MathUtils.clamp(room.height, 2, 6);
    room.wallThickness = THREE.MathUtils.clamp(room.wallThickness, 0.08, 0.5);
    room.x = clampMeters(room.x, 0, GRID_WIDTH_METERS - room.width);
    room.y = clampMeters(room.y, 0, GRID_HEIGHT_METERS - room.depth);
    requestRefresh();
  };

  const updateSelectedWall = (mutator: (wall: SketchWall) => void) => {
    const wall = selectedWall();

    if (!wall) {
      return;
    }

    pushHistory();
    const previous = { ...wall };
    mutator(wall);
    normalizeWallSegment(wall, previous);
    requestRefresh();
  };

  const deleteSelected = () => {
    if (!state.selection) {
      return;
    }

    pushHistory();
    if (state.selection.kind === "room") {
      state.rooms = state.rooms.filter((room) => room.id !== state.selection?.id);
    } else {
      state.walls = state.walls.filter((wall) => wall.id !== state.selection?.id);
    }

    state.selection = state.walls[0]
      ? { kind: "wall", id: state.walls[0].id }
      : state.rooms[0]
        ? { kind: "room", id: state.rooms[0].id }
        : null;
    requestRefresh();
  };

  const resetLayout = () => {
    pushHistory();
    state.rooms = createStarterRooms();
    state.walls = createStarterWalls();
    state.selection = null;
    state.tool = "walls";
    clearTransientInteractionState();
    syncToolButtons();
    requestRefresh();
  };

  const computeResizedBounds = (
    bounds: LoopBounds,
    handle: ResizeHandle,
    pointer: THREE.Vector2,
  ): LoopBounds => {
    let nextMinX = bounds.minX;
    let nextMaxX = bounds.maxX;
    let nextMinY = bounds.minY;
    let nextMaxY = bounds.maxY;
    const nextX = clampMeters(pointer.x, 0, GRID_WIDTH_METERS);
    const nextY = clampMeters(pointer.y, 0, GRID_HEIGHT_METERS);

    if (roomHandleUsesLeft(handle)) {
      nextMinX = Math.min(nextX, bounds.maxX - GRID_STEP_METERS);
    } else if (roomHandleUsesRight(handle)) {
      nextMaxX = Math.max(nextX, bounds.minX + GRID_STEP_METERS);
    }

    if (roomHandleUsesTop(handle)) {
      nextMinY = Math.min(nextY, bounds.maxY - GRID_STEP_METERS);
    } else if (roomHandleUsesBottom(handle)) {
      nextMaxY = Math.max(nextY, bounds.minY + GRID_STEP_METERS);
    }

    nextMinX = THREE.MathUtils.clamp(nextMinX, 0, GRID_WIDTH_METERS);
    nextMaxX = THREE.MathUtils.clamp(nextMaxX, 0, GRID_WIDTH_METERS);
    nextMinY = THREE.MathUtils.clamp(nextMinY, 0, GRID_HEIGHT_METERS);
    nextMaxY = THREE.MathUtils.clamp(nextMaxY, 0, GRID_HEIGHT_METERS);

    return {
      minX: Math.min(nextMinX, nextMaxX - GRID_STEP_METERS),
      maxX: Math.max(nextMaxX, nextMinX + GRID_STEP_METERS),
      minY: Math.min(nextMinY, nextMaxY - GRID_STEP_METERS),
      maxY: Math.max(nextMaxY, nextMinY + GRID_STEP_METERS),
    };
  };

  const resizeRoomFromHandle = (
    room: RoomFootprint,
    handle: RoomResizeHandle,
    bounds: LoopBounds,
    pointer: THREE.Vector2,
  ) => {
    const nextBounds = computeResizedBounds(bounds, handle, pointer);
    room.x = nextBounds.minX;
    room.y = nextBounds.minY;
    room.width = nextBounds.maxX - nextBounds.minX;
    room.depth = nextBounds.maxY - nextBounds.minY;
  };

  const resizeWallFromHandle = (wall: SketchWall, handle: WallResizeHandle, pointer: THREE.Vector2) => {
    const horizontal = wallIsHorizontal(wall);

    if (horizontal) {
      const fixedX = handle === "start" ? wall.x2 : wall.x1;
      const fixedY = handle === "start" ? wall.y2 : wall.y1;
      const direction = pointer.x <= fixedX ? -1 : 1;
      let nextX = clampMeters(pointer.x, 0, GRID_WIDTH_METERS);

      if (Math.abs(nextX - fixedX) < GRID_STEP_METERS) {
        nextX = THREE.MathUtils.clamp(fixedX + direction * GRID_STEP_METERS, 0, GRID_WIDTH_METERS);

        if (Math.abs(nextX - fixedX) < GRID_STEP_METERS) {
          nextX = THREE.MathUtils.clamp(fixedX - direction * GRID_STEP_METERS, 0, GRID_WIDTH_METERS);
        }
      }

      if (handle === "start") {
        wall.x1 = nextX;
        wall.y1 = fixedY;
      } else {
        wall.x2 = nextX;
        wall.y2 = fixedY;
      }

      return;
    }

    const fixedX = handle === "start" ? wall.x2 : wall.x1;
    const fixedY = handle === "start" ? wall.y2 : wall.y1;
    const direction = pointer.y <= fixedY ? -1 : 1;
    let nextY = clampMeters(pointer.y, 0, GRID_HEIGHT_METERS);

    if (Math.abs(nextY - fixedY) < GRID_STEP_METERS) {
      nextY = THREE.MathUtils.clamp(fixedY + direction * GRID_STEP_METERS, 0, GRID_HEIGHT_METERS);

      if (Math.abs(nextY - fixedY) < GRID_STEP_METERS) {
        nextY = THREE.MathUtils.clamp(fixedY - direction * GRID_STEP_METERS, 0, GRID_HEIGHT_METERS);
      }
    }

    if (handle === "start") {
      wall.x1 = fixedX;
      wall.y1 = nextY;
    } else {
      wall.x2 = fixedX;
      wall.y2 = nextY;
    }
  };

  const resizeClosedLoopFromHandle = (
    wallsById: Map<string, SketchWall>,
    originals: WallDragOrigin[],
    bounds: LoopBounds,
    handle: PolygonResizeHandle,
    pointer: THREE.Vector2,
  ) => {
    const nextBounds = computeResizedBounds(bounds, handle, pointer);
    const originalWidth = Math.max(bounds.maxX - bounds.minX, GRID_STEP_METERS);
    const originalHeight = Math.max(bounds.maxY - bounds.minY, GRID_STEP_METERS);
    const nextWidth = Math.max(nextBounds.maxX - nextBounds.minX, GRID_STEP_METERS);
    const nextHeight = Math.max(nextBounds.maxY - nextBounds.minY, GRID_STEP_METERS);

    const remapX = (value: number) => {
      const ratio = (value - bounds.minX) / originalWidth;
      return snapMeters(nextBounds.minX + ratio * nextWidth);
    };

    const remapY = (value: number) => {
      const ratio = (value - bounds.minY) / originalHeight;
      return snapMeters(nextBounds.minY + ratio * nextHeight);
    };

    for (const original of originals) {
      const wall = wallsById.get(original.id);

      if (!wall) {
        continue;
      }

      wall.x1 = remapX(original.x1);
      wall.x2 = remapX(original.x2);
      wall.y1 = remapY(original.y1);
      wall.y2 = remapY(original.y2);
    }
  };

  const pickRoomResizeHandle = (room: RoomFootprint, pointer: THREE.Vector2): RoomResizeHandle | null => {
    return pickBoundsResizeHandle(
      {
        minX: room.x,
        maxX: room.x + room.width,
        minY: room.y,
        maxY: room.y + room.depth,
      },
      pointer,
    );
  };

  const pickWallResizeHandle = (wall: SketchWall, pointer: THREE.Vector2): WallResizeHandle | null => {
    const thresholdSq = HANDLE_PICK_RADIUS_METERS * HANDLE_PICK_RADIUS_METERS;
    const candidates: Array<{ handle: WallResizeHandle; x: number; y: number }> = [
      { handle: "start", x: wall.x1, y: wall.y1 },
      { handle: "end", x: wall.x2, y: wall.y2 },
    ];

    let bestHandle: WallResizeHandle | null = null;
    let bestDistanceSq = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const dx = pointer.x - candidate.x;
      const dy = pointer.y - candidate.y;
      const distanceSq = dx * dx + dy * dy;

      if (distanceSq <= thresholdSq && distanceSq < bestDistanceSq) {
        bestHandle = candidate.handle;
        bestDistanceSq = distanceSq;
      }
    }

    return bestHandle;
  };

  const beginPlanPan = (event: PointerEvent) => {
    state.panPlanPointerId = event.pointerId;
    state.panPlanStartClient = new THREE.Vector2(event.clientX, event.clientY);
    state.planViewStartOffset = state.planViewOffset.clone();
    setInteractionScrollLock(true);
    gridSurface.setPointerCapture(event.pointerId);
    gridSurface.classList.add("is-panning");
  };

  const updatePlanPan = (event: PointerEvent) => {
    if (!state.panPlanStartClient || !state.planViewStartOffset) {
      return;
    }

    const bounds = gridSvg.getBoundingClientRect();
    const deltaX = event.clientX - state.panPlanStartClient.x;
    const deltaY = event.clientY - state.panPlanStartClient.y;
    const visibleWidth = planVisibleWidth();
    const visibleHeight = planVisibleHeight();
    const nextOffset = clampPlanOffset(
      new THREE.Vector2(
        state.planViewStartOffset.x - (deltaX / Math.max(bounds.width, 1)) * visibleWidth,
        state.planViewStartOffset.y - (deltaY / Math.max(bounds.height, 1)) * visibleHeight,
      ),
    );

    if (!nextOffset.equals(state.planViewOffset)) {
      state.planViewOffset.copy(nextOffset);
      requestPlanRefresh();
    }
  };

  const endPlanPan = (event: PointerEvent) => {
    state.panPlanPointerId = null;
    state.panPlanStartClient = null;
    state.planViewStartOffset = null;
    setInteractionScrollLock(false);
    gridSurface.classList.remove("is-panning");

    if (gridSurface.hasPointerCapture(event.pointerId)) {
      gridSurface.releasePointerCapture(event.pointerId);
    }
  };

  const beginPlanZoom = (event: PointerEvent) => {
    const bounds = gridSvg.getBoundingClientRect();
    const ratioX = THREE.MathUtils.clamp((event.clientX - bounds.left) / Math.max(bounds.width, 1), 0, 1);
    const ratioY = THREE.MathUtils.clamp((event.clientY - bounds.top) / Math.max(bounds.height, 1), 0, 1);

    state.zoomPlanPointerId = event.pointerId;
    state.zoomPlanStartClientY = event.clientY;
    state.zoomPlanStartValue = state.planViewZoom;
    state.zoomPlanAnchorRatio = new THREE.Vector2(ratioX, ratioY);
    state.zoomPlanAnchorGrid = clientPointToGrid(event.clientX, event.clientY);
    setInteractionScrollLock(true);
    gridSurface.setPointerCapture(event.pointerId);
    gridSurface.classList.add("is-zooming");
  };

  const applyPlanZoomAt = (clientX: number, clientY: number, nextZoom: number) => {
    const bounds = gridSvg.getBoundingClientRect();
    const ratioX = THREE.MathUtils.clamp((clientX - bounds.left) / Math.max(bounds.width, 1), 0, 1);
    const ratioY = THREE.MathUtils.clamp((clientY - bounds.top) / Math.max(bounds.height, 1), 0, 1);
    const anchorGrid = clientPointToGrid(clientX, clientY);
    const clampedZoom = THREE.MathUtils.clamp(nextZoom, PLAN_MIN_ZOOM, PLAN_MAX_ZOOM);

    if (Math.abs(clampedZoom - state.planViewZoom) < 0.0001) {
      return;
    }

    state.planViewZoom = clampedZoom;
    const visibleWidth = planVisibleWidth(clampedZoom);
    const visibleHeight = planVisibleHeight(clampedZoom);
    const nextOffset = new THREE.Vector2(
      anchorGrid.x - ratioX * visibleWidth,
      anchorGrid.y - ratioY * visibleHeight,
    );
    state.planViewOffset.copy(clampPlanOffset(nextOffset, clampedZoom));
    requestPlanRefresh();
  };

  const getTouchGestureSample = () => {
    const points = [...state.touchPoints.values()];

    if (points.length < 2) {
      return null;
    }

    const first = points[0];
    const second = points[1];
    const midpoint = new THREE.Vector2((first.x + second.x) * 0.5, (first.y + second.y) * 0.5);
    const distance = Math.max(first.distanceTo(second), 1);

    return { midpoint, distance };
  };

  const beginTouchPlanGesture = () => {
    const sample = getTouchGestureSample();

    if (!sample) {
      return;
    }

    state.touchGestureActive = true;
    state.touchGestureStartDistance = sample.distance;
    state.touchGestureStartZoom = state.planViewZoom;
    state.touchGestureAnchorGrid = clientPointToGrid(sample.midpoint.x, sample.midpoint.y);
    setInteractionScrollLock(true);
    gridSurface.classList.add("is-touch-navigating");
  };

  const updateTouchPlanGesture = () => {
    if (!state.touchGestureActive || !state.touchGestureAnchorGrid) {
      return;
    }

    const sample = getTouchGestureSample();

    if (!sample) {
      return;
    }

    const bounds = gridSvg.getBoundingClientRect();
    const ratioX = THREE.MathUtils.clamp((sample.midpoint.x - bounds.left) / Math.max(bounds.width, 1), 0, 1);
    const ratioY = THREE.MathUtils.clamp((sample.midpoint.y - bounds.top) / Math.max(bounds.height, 1), 0, 1);
    const nextZoom = THREE.MathUtils.clamp(
      state.touchGestureStartZoom * (sample.distance / Math.max(state.touchGestureStartDistance, 1)),
      PLAN_MIN_ZOOM,
      PLAN_MAX_ZOOM,
    );

    state.planViewZoom = nextZoom;
    const visibleWidth = planVisibleWidth(nextZoom);
    const visibleHeight = planVisibleHeight(nextZoom);
    const nextOffset = new THREE.Vector2(
      state.touchGestureAnchorGrid.x - ratioX * visibleWidth,
      state.touchGestureAnchorGrid.y - ratioY * visibleHeight,
    );
    state.planViewOffset.copy(clampPlanOffset(nextOffset, nextZoom));
    requestPlanRefresh();
  };

  const endTouchPlanGesture = () => {
    state.touchGestureActive = false;
    state.touchGestureStartDistance = 0;
    state.touchGestureStartZoom = state.planViewZoom;
    state.touchGestureAnchorGrid = null;
    setInteractionScrollLock(false);
    gridSurface.classList.remove("is-touch-navigating");
  };

  const updatePlanZoom = (event: PointerEvent) => {
    if (!state.zoomPlanAnchorRatio || !state.zoomPlanAnchorGrid) {
      return;
    }

    const deltaY = event.clientY - state.zoomPlanStartClientY;
    const nextZoom = THREE.MathUtils.clamp(state.zoomPlanStartValue * Math.exp(-deltaY * 0.01), PLAN_MIN_ZOOM, PLAN_MAX_ZOOM);
    applyPlanZoomAt(event.clientX, event.clientY, nextZoom);
  };

  const endPlanZoom = (event: PointerEvent) => {
    state.zoomPlanPointerId = null;
    state.zoomPlanAnchorRatio = null;
    state.zoomPlanAnchorGrid = null;
    setInteractionScrollLock(false);
    gridSurface.classList.remove("is-zooming");

    if (gridSurface.hasPointerCapture(event.pointerId)) {
      gridSurface.releasePointerCapture(event.pointerId);
    }
  };

  const beginWallDrag = (wall: SketchWall, pointer: THREE.Vector2, event: PointerEvent) => {
    const wallIds = findClosedWallLoop(state.walls, wall.id) ?? [wall.id];

    state.selection = { kind: "wall", id: wall.id };
    state.dragWallId = wall.id;
    state.dragWallStartPointer = pointer.clone();
    state.dragWallOrigins = wallIds
      .map((id) => state.walls.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is SketchWall => !!candidate)
      .map((candidate) => ({
        id: candidate.id,
        x1: candidate.x1,
        y1: candidate.y1,
        x2: candidate.x2,
        y2: candidate.y2,
      }));
    requestRefresh();
    setInteractionScrollLock(true);
    gridSurface.setPointerCapture(event.pointerId);
  };

  const clientPointToGrid = (clientX: number, clientY: number) => {
    const bounds = gridSvg.getBoundingClientRect();
    const localX = THREE.MathUtils.clamp(clientX - bounds.left, 0, bounds.width);
    const localY = THREE.MathUtils.clamp(clientY - bounds.top, 0, bounds.height);
    const visibleWidth = planVisibleWidth();
    const visibleHeight = planVisibleHeight();
    return clampGridPoint(
      state.planViewOffset.x + (localX / bounds.width) * visibleWidth,
      state.planViewOffset.y + (localY / bounds.height) * visibleHeight,
    );
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      event.preventDefault();
      state.touchPoints.set(event.pointerId, new THREE.Vector2(event.clientX, event.clientY));
      gridSurface.setPointerCapture(event.pointerId);

      if (
        state.touchPoints.size === 2 &&
        !state.draft &&
        !state.dragRoomId &&
        !state.dragWallId &&
        !state.resizeRoomId &&
        !state.resizeWallId &&
        !state.resizeLoopWallIds &&
        state.panPlanPointerId === null &&
        state.zoomPlanPointerId === null
      ) {
        beginTouchPlanGesture();
        return;
      }

      if (state.touchPoints.size > 1 || state.touchGestureActive) {
        return;
      }
    }

    if (event.button === 2) {
      event.preventDefault();
      beginPlanPan(event);
      return;
    }

    if (event.button === 1) {
      event.preventDefault();
      beginPlanPan(event);
      return;
    }

    const pointer = clientPointToGrid(event.clientX, event.clientY);

    if (event.button === 0 && state.tool === "walls" && state.draft?.kind === "wall") {
      event.preventDefault();
      state.draft.current = axisLockPoint(state.draft.start, pointer);
      state.planDirty = true;
      setInteractionScrollLock(true);
      gridSurface.setPointerCapture(event.pointerId);
      return;
    }

    const roomHandleTarget = (event.target as Element | null)?.closest<SVGElement>("[data-room-handle]");
    const loopHandleTarget = (event.target as Element | null)?.closest<SVGElement>("[data-loop-handle]");
    const wallHandleTarget = (event.target as Element | null)?.closest<SVGElement>("[data-wall-handle]");
    const wallTarget = (event.target as Element | null)?.closest<SVGGElement>("[data-wall-id]");
    const roomTarget = (event.target as Element | null)?.closest<SVGGElement>("[data-room-id]");
    const activeRoom = selectedRoom();
    const activeWall = selectedWall();
    const activeLoopIds = activeWall ? findClosedWallLoop(state.walls, activeWall.id) : null;
    const activeLoopBounds = activeLoopIds
      ? computeLoopBounds(
          activeLoopIds
            .map((id) => state.walls.find((wall) => wall.id === id))
            .filter((wall): wall is SketchWall => !!wall)
            .map((wall) => ({
              id: wall.id,
              x1: wall.x1,
              y1: wall.y1,
              x2: wall.x2,
              y2: wall.y2,
            })),
        )
      : null;
    const roomHandle =
      roomHandleTarget?.dataset.roomHandle ??
      (state.tool === "select" && activeRoom ? pickRoomResizeHandle(activeRoom, pointer) : null);
    const loopHandle =
      loopHandleTarget?.dataset.loopHandle ??
      (state.tool === "select" && activeLoopBounds ? pickBoundsResizeHandle(activeLoopBounds, pointer) : null);
    const wallHandle =
      wallHandleTarget?.dataset.wallHandle ??
      (state.tool === "select" && activeWall ? pickWallResizeHandle(activeWall, pointer) : null);

    if (state.tool === "select" && roomHandle) {
      const room =
        (roomHandleTarget?.dataset.roomId ? state.rooms.find((item) => item.id === roomHandleTarget.dataset.roomId) : null) ??
        activeRoom;
      const handle = roomHandle as RoomResizeHandle;

      if (!room) {
        return;
      }

      pushHistory();
      state.selection = { kind: "room", id: room.id };
      state.resizeRoomId = room.id;
      state.resizeRoomHandle = handle;
      state.resizeRoomBounds = {
        minX: room.x,
        maxX: room.x + room.width,
        minY: room.y,
        maxY: room.y + room.depth,
      };
      requestRefresh();
      setInteractionScrollLock(true);
      gridSurface.setPointerCapture(event.pointerId);
      return;
    }

    if (state.tool === "select" && loopHandle && activeLoopIds && activeLoopBounds) {
      const loopOrigins = activeLoopIds
        .map((id) => state.walls.find((candidate) => candidate.id === id))
        .filter((candidate): candidate is SketchWall => !!candidate)
        .map((candidate) => ({
          id: candidate.id,
          x1: candidate.x1,
          y1: candidate.y1,
          x2: candidate.x2,
          y2: candidate.y2,
        }));

      if (activeWall) {
        pushHistory();
        state.selection = { kind: "wall", id: activeWall.id };
        state.resizeLoopWallIds = activeLoopIds;
        state.resizeLoopOrigins = loopOrigins;
        state.resizeLoopHandle = loopHandle as PolygonResizeHandle;
        state.resizeLoopBounds = activeLoopBounds;
        requestRefresh();
        setInteractionScrollLock(true);
        gridSurface.setPointerCapture(event.pointerId);
        return;
      }
    }

    if (state.tool === "select" && wallHandle) {
      const wall =
        (wallHandleTarget?.dataset.wallId ? state.walls.find((item) => item.id === wallHandleTarget.dataset.wallId) : null) ??
        activeWall;

      if (!wall) {
        return;
      }

      pushHistory();
      state.selection = { kind: "wall", id: wall.id };
      state.resizeWallId = wall.id;
      state.resizeWallHandle = wallHandle as WallResizeHandle;
      requestRefresh();
      setInteractionScrollLock(true);
      gridSurface.setPointerCapture(event.pointerId);
      return;
    }

    if (state.tool === "select" && wallTarget) {
      const wall = state.walls.find((item) => item.id === wallTarget.dataset.wallId);

      if (!wall) {
        return;
      }

      pushHistory();
      beginWallDrag(wall, pointer, event);
      return;
    }

    if (state.tool === "select" && roomTarget) {
      const room = state.rooms.find((item) => item.id === roomTarget.dataset.roomId);

      if (!room) {
        return;
      }

      pushHistory();
      state.selection = { kind: "room", id: room.id };
      state.dragRoomId = room.id;
      state.dragRoomOffset = new THREE.Vector2(pointer.x - room.x, pointer.y - room.y);
      requestRefresh();
      setInteractionScrollLock(true);
      gridSurface.setPointerCapture(event.pointerId);
      return;
    }

    if (state.tool === "select") {
      state.selection = null;
      requestRefresh();
      return;
    }

    state.selection = null;

    state.draft = state.tool === "walls"
      ? {
          kind: "wall",
          start: pointer,
          current: pointer.clone(),
        }
      : {
          kind: "room",
          start: pointer,
          current: pointer.clone(),
        };

    requestRefresh();
    setInteractionScrollLock(true);
    gridSurface.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch" && state.touchPoints.has(event.pointerId)) {
      state.touchPoints.set(event.pointerId, new THREE.Vector2(event.clientX, event.clientY));

      if (state.touchGestureActive) {
        event.preventDefault();
        updateTouchPlanGesture();
        return;
      }

      if (state.touchPoints.size > 1) {
        event.preventDefault();
        return;
      }
    }

    if (
      state.dragWallId ||
      state.dragRoomId ||
      state.resizeWallId ||
      state.resizeLoopWallIds ||
      state.resizeRoomId ||
      state.panPlanPointerId !== null ||
      state.zoomPlanPointerId !== null ||
      state.draft
    ) {
      event.preventDefault();
    }

    if (state.panPlanPointerId === event.pointerId) {
      updatePlanPan(event);
      return;
    }

    if (state.zoomPlanPointerId === event.pointerId) {
      updatePlanZoom(event);
      return;
    }

    const pointer = clientPointToGrid(event.clientX, event.clientY);

    if (state.resizeLoopWallIds && state.resizeLoopOrigins && state.resizeLoopHandle && state.resizeLoopBounds) {
      const wallsById = new Map(state.walls.map((wall) => [wall.id, wall] as const));
      resizeClosedLoopFromHandle(
        wallsById,
        state.resizeLoopOrigins,
        state.resizeLoopBounds,
        state.resizeLoopHandle,
        pointer,
      );
      requestRefresh();
      return;
    }

    if (state.resizeWallId && state.resizeWallHandle) {
      const wall = state.walls.find((item) => item.id === state.resizeWallId);

      if (!wall) {
        return;
      }

      resizeWallFromHandle(wall, state.resizeWallHandle, pointer);
      requestRefresh();
      return;
    }

    if (state.resizeRoomId && state.resizeRoomHandle && state.resizeRoomBounds) {
      const room = state.rooms.find((item) => item.id === state.resizeRoomId);

      if (!room) {
        return;
      }

      resizeRoomFromHandle(room, state.resizeRoomHandle, state.resizeRoomBounds, pointer);
      requestRefresh();
      return;
    }

    if (state.dragWallId && state.dragWallStartPointer && state.dragWallOrigins) {
      const wallsById = new Map(state.walls.map((wall) => [wall.id, wall] as const));
      const deltaX = snapMeters(pointer.x - state.dragWallStartPointer.x);
      const deltaY = snapMeters(pointer.y - state.dragWallStartPointer.y);

      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      for (const origin of state.dragWallOrigins) {
        minX = Math.min(minX, origin.x1, origin.x2);
        maxX = Math.max(maxX, origin.x1, origin.x2);
        minY = Math.min(minY, origin.y1, origin.y2);
        maxY = Math.max(maxY, origin.y1, origin.y2);
      }

      const clampedDeltaX = THREE.MathUtils.clamp(deltaX, -minX, GRID_WIDTH_METERS - maxX);
      const clampedDeltaY = THREE.MathUtils.clamp(deltaY, -minY, GRID_HEIGHT_METERS - maxY);

      for (const origin of state.dragWallOrigins) {
        const wall = wallsById.get(origin.id);

        if (!wall) {
          continue;
        }

        wall.x1 = snapMeters(origin.x1 + clampedDeltaX);
        wall.y1 = snapMeters(origin.y1 + clampedDeltaY);
        wall.x2 = snapMeters(origin.x2 + clampedDeltaX);
        wall.y2 = snapMeters(origin.y2 + clampedDeltaY);
      }

      if (state.dragWallOrigins.length === 0) {
        return;
      }
      requestRefresh();
      return;
    }

    if (state.dragRoomId && state.dragRoomOffset) {
      const room = state.rooms.find((item) => item.id === state.dragRoomId);

      if (!room) {
        return;
      }

      room.x = clampMeters(pointer.x - state.dragRoomOffset.x, 0, GRID_WIDTH_METERS - room.width);
      room.y = clampMeters(pointer.y - state.dragRoomOffset.y, 0, GRID_HEIGHT_METERS - room.depth);
      requestRefresh();
      return;
    }

    if (state.draft?.kind === "wall") {
      state.draft.current = axisLockPoint(state.draft.start, pointer);
      state.planDirty = true;
      return;
    }

    if (state.draft?.kind === "room") {
      state.draft.current = pointer;
      state.planDirty = true;
    }
  };

  const handlePointerUp = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      state.touchPoints.delete(event.pointerId);

      if (state.touchGestureActive) {
        event.preventDefault();

        if (state.touchPoints.size < 2) {
          endTouchPlanGesture();
        }

        if (gridSurface.hasPointerCapture(event.pointerId)) {
          gridSurface.releasePointerCapture(event.pointerId);
        }

        return;
      }
    }

    if (state.panPlanPointerId === event.pointerId) {
      event.preventDefault();
      endPlanPan(event);
      return;
    }

    if (state.zoomPlanPointerId === event.pointerId) {
      event.preventDefault();
      endPlanZoom(event);
      return;
    }

    if (state.resizeLoopWallIds) {
      event.preventDefault();
      state.resizeLoopWallIds = null;
      state.resizeLoopOrigins = null;
      state.resizeLoopHandle = null;
      state.resizeLoopBounds = null;
      setInteractionScrollLock(false);

      if (gridSurface.hasPointerCapture(event.pointerId)) {
        gridSurface.releasePointerCapture(event.pointerId);
      }

      return;
    }

    if (state.resizeWallId) {
      event.preventDefault();
      state.resizeWallId = null;
      state.resizeWallHandle = null;
      setInteractionScrollLock(false);

      if (gridSurface.hasPointerCapture(event.pointerId)) {
        gridSurface.releasePointerCapture(event.pointerId);
      }

      return;
    }

    if (state.resizeRoomId) {
      event.preventDefault();
      state.resizeRoomId = null;
      state.resizeRoomHandle = null;
      state.resizeRoomAnchor = null;
      state.resizeRoomBounds = null;
      setInteractionScrollLock(false);

      if (gridSurface.hasPointerCapture(event.pointerId)) {
        gridSurface.releasePointerCapture(event.pointerId);
      }

      return;
    }

    if (state.dragWallId) {
      event.preventDefault();
      state.dragWallId = null;
      state.dragWallStartPointer = null;
      state.dragWallOrigins = null;
      setInteractionScrollLock(false);

      if (gridSurface.hasPointerCapture(event.pointerId)) {
        gridSurface.releasePointerCapture(event.pointerId);
      }

      return;
    }

    if (state.dragRoomId) {
      event.preventDefault();
      state.dragRoomId = null;
      state.dragRoomOffset = null;
      setInteractionScrollLock(false);

      if (gridSurface.hasPointerCapture(event.pointerId)) {
        gridSurface.releasePointerCapture(event.pointerId);
      }

      return;
    }

    if (!state.draft) {
      if (gridSurface.hasPointerCapture(event.pointerId)) {
        gridSurface.releasePointerCapture(event.pointerId);
      }

      return;
    }

    event.preventDefault();

    let nextDraft: DraftShape = null;

    if (state.draft.kind === "wall") {
      const current = axisLockPoint(state.draft.start, state.draft.current);
      const length = Math.abs(current.x - state.draft.start.x) + Math.abs(current.y - state.draft.start.y);

      if (length >= GRID_STEP_METERS) {
        pushHistory();
        const wall = createSketchWall(
          `Wall ${state.walls.length + 1}`,
          state.draft.start.x,
          state.draft.start.y,
          current.x,
          current.y,
          WALL_COLORS[state.walls.length % WALL_COLORS.length],
        );
        normalizeWallSegment(wall, wall);
        state.walls.push(wall);
        state.selection = { kind: "wall", id: wall.id };
      }

      if (event.type === "pointerup" && state.tool === "walls") {
        nextDraft = {
          kind: "wall",
          start: current.clone(),
          current: current.clone(),
        };
      }
    }

    if (state.draft.kind === "room") {
      const startX = Math.min(state.draft.start.x, state.draft.current.x);
      const startY = Math.min(state.draft.start.y, state.draft.current.y);
      const width = clampMeters(Math.abs(state.draft.current.x - state.draft.start.x), GRID_STEP_METERS, GRID_WIDTH_METERS);
      const depth = clampMeters(Math.abs(state.draft.current.y - state.draft.start.y), GRID_STEP_METERS, GRID_HEIGHT_METERS);

      if (width >= GRID_STEP_METERS && depth >= GRID_STEP_METERS) {
        pushHistory();
        const room: RoomFootprint = {
          id: `room-${crypto.randomUUID()}`,
          label: `Room ${state.rooms.length + 1}`,
          x: clampMeters(startX, 0, GRID_WIDTH_METERS - width),
          y: clampMeters(startY, 0, GRID_HEIGHT_METERS - depth),
          width,
          depth,
          height: DEFAULT_WALL_HEIGHT,
          wallThickness: DEFAULT_WALL_THICKNESS,
          color: ROOM_COLORS[state.rooms.length % ROOM_COLORS.length],
        };
        state.rooms.push(room);
        state.selection = { kind: "room", id: room.id };
      }
    }

    state.draft = nextDraft;
    requestRefresh();
    setInteractionScrollLock(false);

    if (gridSurface.hasPointerCapture(event.pointerId)) {
      gridSurface.releasePointerCapture(event.pointerId);
    }
  };

  const handleGridWheel = (event: WheelEvent) => {
    event.preventDefault();
    const nextZoom = state.planViewZoom * Math.exp(-event.deltaY * 0.0015);
    applyPlanZoomAt(event.clientX, event.clientY, nextZoom);
  };

  const handleGridMouseDown = (event: MouseEvent) => {
    if (event.button === 1 || event.button === 2) {
      event.preventDefault();
    }
  };

  const handleGridAuxClick = (event: MouseEvent) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  };

  const handleGridContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };

  gridSurface.addEventListener("pointerdown", handlePointerDown);
  gridSurface.addEventListener("pointermove", handlePointerMove);
  gridSurface.addEventListener("pointerup", handlePointerUp);
  gridSurface.addEventListener("pointercancel", handlePointerUp);
  gridSurface.addEventListener("wheel", handleGridWheel, { passive: false });
  gridSurface.addEventListener("mousedown", handleGridMouseDown);
  gridSurface.addEventListener("auxclick", handleGridAuxClick);
  gridSurface.addEventListener("contextmenu", handleGridContextMenu);

  toolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.tool = button.dataset.houseTool as HouseTool;
      syncToolButtons();
    });
  });

  presetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const preset = ROOM_PRESETS.find((item) => item.label === button.dataset.housePreset);

      if (preset) {
        addPreset(preset);
      }
    });
  });

  deleteButton.addEventListener("click", deleteSelected);
  resetButton.addEventListener("click", resetLayout);

  fieldInputs.label!.addEventListener("input", () => {
    if (selectedRoom()) {
      updateSelectedRoom((room) => {
        room.label = fieldInputs.label!.value || room.label;
      });
      return;
    }

    updateSelectedWall((wall) => {
      wall.label = fieldInputs.label!.value || wall.label;
    });
  });

  fieldInputs.x!.addEventListener("input", () => {
    if (selectedRoom()) {
      updateSelectedRoom((room) => {
        room.x = Number(fieldInputs.x!.value);
      });
      return;
    }

    updateSelectedWall((wall) => {
      wall.x1 = Number(fieldInputs.x!.value);
    });
  });

  fieldInputs.y!.addEventListener("input", () => {
    if (selectedRoom()) {
      updateSelectedRoom((room) => {
        room.y = Number(fieldInputs.y!.value);
      });
      return;
    }

    updateSelectedWall((wall) => {
      wall.y1 = Number(fieldInputs.y!.value);
    });
  });

  fieldInputs.width!.addEventListener("input", () => {
    if (selectedRoom()) {
      updateSelectedRoom((room) => {
        room.width = Number(fieldInputs.width!.value);
      });
      return;
    }

    updateSelectedWall((wall) => {
      wall.x2 = Number(fieldInputs.width!.value);
    });
  });

  fieldInputs.depth!.addEventListener("input", () => {
    if (selectedRoom()) {
      updateSelectedRoom((room) => {
        room.depth = Number(fieldInputs.depth!.value);
      });
      return;
    }

    updateSelectedWall((wall) => {
      wall.y2 = Number(fieldInputs.depth!.value);
    });
  });

  fieldInputs.height!.addEventListener("input", () => {
    if (selectedRoom()) {
      updateSelectedRoom((room) => {
        room.height = Number(fieldInputs.height!.value);
      });
      return;
    }

    updateSelectedWall((wall) => {
      wall.height = Number(fieldInputs.height!.value);
    });
  });

  fieldInputs.wallThickness!.addEventListener("input", () => {
    if (selectedRoom()) {
      updateSelectedRoom((room) => {
        room.wallThickness = Number(fieldInputs.wallThickness!.value);
      });
      return;
    }

    updateSelectedWall((wall) => {
      wall.thickness = Number(fieldInputs.wallThickness!.value);
    });
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      clearTransientInteractionState();
      state.touchPoints.clear();
      endTouchPlanGesture();
      state.tool = "select";
      gridSurface.classList.remove("is-panning", "is-zooming");
      setInteractionScrollLock(false);
      syncToolButtons();
      requestRefresh();
      return;
    }

    if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.code !== "KeyZ") {
      return;
    }

    const activeElement = document.activeElement;

    if (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      (activeElement instanceof HTMLElement && activeElement.isContentEditable)
    ) {
      return;
    }

    event.preventDefault();
    undoPlanner();
  };

  syncToolButtons();
  syncProperties();
  renderPlan();
  rebuildPreview();

  const handleWindowResize = () => {
    previewSizeDirty = true;
  };

  window.addEventListener("resize", handleWindowResize);
  window.addEventListener("keydown", handleKeyDown);

  const tick = () => {
    if (disposed) {
      return;
    }

    if (state.planDirty) {
      renderPlan();
    }

    if (state.previewDirty) {
      rebuildPreview();
    }

    if (state.isVisible) {
      if (previewSizeDirty) {
        syncPreviewSize();
      }

      controls.update();
      renderer.render(scene, camera);
    }

    renderFrame = requestAnimationFrame(tick);
  };

  renderFrame = requestAnimationFrame(tick);

  return {
    setVisible(visible: boolean) {
      state.isVisible = visible;
      previewSizeDirty = true;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(renderFrame);
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("keydown", handleKeyDown);
      setInteractionScrollLock(false);
      gridSurface.removeEventListener("pointerdown", handlePointerDown);
      gridSurface.removeEventListener("pointermove", handlePointerMove);
      gridSurface.removeEventListener("pointerup", handlePointerUp);
      gridSurface.removeEventListener("pointercancel", handlePointerUp);
      gridSurface.removeEventListener("wheel", handleGridWheel);
      gridSurface.removeEventListener("mousedown", handleGridMouseDown);
      gridSurface.removeEventListener("auxclick", handleGridAuxClick);
      gridSurface.removeEventListener("contextmenu", handleGridContextMenu);
      controls.dispose();
      renderer.domElement.remove();
      renderer.dispose();
      for (const entry of roomPreviewEntries.values()) {
        disposeRoomPreviewEntry(entry);
      }
      roomPreviewEntries.clear();
      for (const entry of wallPreviewEntries.values()) {
        disposeWallPreviewEntry(entry);
      }
      wallPreviewEntries.clear();
      previewBoxGeometry.dispose();
      disposeObjectTree(worldFloor);
      disposeObjectTree(sitePad);
      disposeObjectTree(skyDome);
      skyDomeTexture.dispose();
      gridHelper.geometry.dispose();

      if (Array.isArray(gridHelper.material)) {
        for (const material of gridHelper.material) {
          material.dispose();
        }
      } else {
        gridHelper.material.dispose();
      }

      scene.clear();
    },
  };
}
