import "./style.css";

import * as THREE from "three/webgpu";
import WebGPU from "three/addons/capabilities/WebGPU.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SimplexNoise } from "three/addons/math/SimplexNoise.js";
import { Fn, color, cos, instanceIndex, instancedArray, localId, mix, normalLocal, positionLocal, sin, textureStore, time, uvec2, uv, vec3, vec4, workgroupId } from "three/tsl";

type ExampleRuntime = {
  update?: (elapsed: number, delta: number) => void;
  dispose?: () => void;
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

function createOrbitLine(radius: number, colorValue: string): THREE.LineLoop {
  const points: THREE.Vector3[] = [];

  for (let index = 0; index < 96; index += 1) {
    const angle = index / 96 * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: colorValue,
    transparent: true,
    opacity: 0.45,
  });

  return new THREE.LineLoop(geometry, material);
}

const examples: ExampleDefinition[] = [
  {
    step: "Step 01",
    title: "Triangle",
    summary: "Start from raw positions and vertex colors so the scene graph stays out of the way.",
    notes:
      "This is the smallest useful Three.js WebGPU mesh: a custom BufferGeometry, one material, one camera, one orbitable canvas.",
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
          [0.25, 0.74, 1.0, 1.0, 0.58, 0.24, 0.42, 1.0, 0.72],
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
    title: "Lighting",
    summary: "Introduce normals, physically based materials, and lights that move through the scene.",
    notes:
      "Orbit around the knot and sphere to see how roughness, metalness, and shadows respond to the directional and point lights.",
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

      return {
        update: (elapsed) => {
          knot.rotation.x = elapsed * 0.4;
          knot.rotation.y = elapsed * 0.65;
          sphere.position.y = 1.1 + Math.sin(elapsed * 1.2) * 0.18;
          pointRig.rotation.y = elapsed * 0.8;
        },
        dispose: () => {
          disposeSceneResources([floor, knot, sphere, pointMesh]);
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
    summary: "Animate a mesh with bones instead of moving the vertices manually.",
    notes:
      "This example creates a little skinned tentacle from scratch, binds a skeleton, and then waves the bones to show how character rigs deform geometry.",
    tags: ["SkinnedMesh", "Bones", "Skeleton"],
    cameraPosition: [5.2, 3.8, 6.8],
    target: [0, 1.6, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#09121c");

      const ambient = new THREE.AmbientLight("#92baff", 0.5);
      const key = new THREE.DirectionalLight("#ffffff", 1.85);
      key.position.set(4, 6, 3);
      scene.add(ambient, key);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(6, 64),
        new THREE.MeshStandardMaterial({
          color: "#10263a",
          roughness: 0.94,
          metalness: 0.04,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      scene.add(floor);

      const segmentHeight = 0.72;
      const segmentCount = 6;
      const height = segmentHeight * segmentCount;
      const geometry = new THREE.BoxGeometry(0.55, height, 0.55, 2, segmentCount * 3, 2);
      const position = geometry.attributes.position;
      const vertex = new THREE.Vector3();
      const skinIndices: number[] = [];
      const skinWeights: number[] = [];

      for (let i = 0; i < position.count; i += 1) {
        vertex.fromBufferAttribute(position, i);

        const y = vertex.y + height / 2;
        const skinIndex = Math.min(Math.floor(y / segmentHeight), segmentCount - 1);
        const skinWeight = (y % segmentHeight) / segmentHeight;

        skinIndices.push(skinIndex, skinIndex + 1, 0, 0);
        skinWeights.push(1 - skinWeight, skinWeight, 0, 0);
      }

      geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
      geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));

      const bones: THREE.Bone[] = [];
      const rootBone = new THREE.Bone();
      rootBone.position.y = -height / 2;
      bones.push(rootBone);

      let previousBone = rootBone;
      for (let i = 0; i < segmentCount; i += 1) {
        const bone = new THREE.Bone();
        bone.position.y = segmentHeight;
        bones.push(bone);
        previousBone.add(bone);
        previousBone = bone;
      }

      const skeleton = new THREE.Skeleton(bones);
      const material = new THREE.MeshStandardMaterial({
        color: "#7be0ff",
        roughness: 0.46,
        metalness: 0.08,
      });
      const skinnedMesh = new THREE.SkinnedMesh(geometry, material);
      skinnedMesh.frustumCulled = false;
      skinnedMesh.add(rootBone);
      skinnedMesh.bind(skeleton);
      skinnedMesh.position.y = height / 2;

      scene.add(skinnedMesh);

      return {
        update: (elapsed) => {
          for (let i = 1; i < bones.length; i += 1) {
            const bone = bones[i];
            bone.rotation.z = Math.sin(elapsed * 1.8 + i * 0.5) * 0.16;
            bone.rotation.x = Math.cos(elapsed * 1.3 + i * 0.35) * 0.08;
          }

          skinnedMesh.rotation.y = Math.sin(elapsed * 0.35) * 0.35;
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
    step: "Step 15",
    title: "Terrain",
    summary: "Generate a height field, paint it by elevation, and light it like a tiny world.",
    notes:
      "The terrain is CPU-authored once, then the renderer only has to draw it. That makes it a good place to learn geometry processing, normals, and debug-friendly data flow.",
    tags: ["PlaneGeometry", "SimplexNoise", "Vertex colors"],
    cameraPosition: [8.5, 6.4, 8.5],
    target: [0, 0.4, 0],
    create: ({ scene }) => {
      scene.background = new THREE.Color("#07111a");

      const hemi = new THREE.HemisphereLight("#9fcbff", "#08111a", 0.85);
      const sun = new THREE.DirectionalLight("#fff2d2", 2.0);
      sun.position.set(7, 9, 4);
      sun.castShadow = true;
      scene.add(hemi, sun);

      const geometry = new THREE.PlaneGeometry(14, 14, 140, 140);
      geometry.rotateX(-Math.PI / 2);

      const simplex = new SimplexNoise();
      const positions = geometry.attributes.position;
      const colors: number[] = [];
      const worldPosition = new THREE.Vector3();
      const surfaceColor = new THREE.Color();

      for (let i = 0; i < positions.count; i += 1) {
        worldPosition.fromBufferAttribute(positions, i);

        const large = simplex.noise(worldPosition.x * 0.13, worldPosition.z * 0.13) * 1.7;
        const medium = simplex.noise(worldPosition.x * 0.32 + 21, worldPosition.z * 0.32 + 11) * 0.65;
        const small = simplex.noise(worldPosition.x * 0.75 + 8, worldPosition.z * 0.75 + 17) * 0.12;
        const radial = Math.max(0, 1 - worldPosition.length() / 11.5) * 0.85;
        const height = large + medium + small + radial - 0.3;

        positions.setY(i, height);

        if (height < -0.05) {
          surfaceColor.set("#295f8d");
        } else if (height < 0.4) {
          surfaceColor.set("#8dbf6f");
        } else if (height < 1.25) {
          surfaceColor.set("#668c52");
        } else {
          surfaceColor.set("#c7d2dc");
        }

        colors.push(surfaceColor.r, surfaceColor.g, surfaceColor.b);
      }

      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeVertexNormals();

      const terrain = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 1,
          metalness: 0,
        }),
      );
      terrain.receiveShadow = true;
      terrain.castShadow = true;

      const water = new THREE.Mesh(
        new THREE.CircleGeometry(4.8, 64),
        new THREE.MeshStandardMaterial({
          color: "#1b5a8d",
          transparent: true,
          opacity: 0.72,
          roughness: 0.18,
          metalness: 0.2,
        }),
      );
      water.rotation.x = -Math.PI / 2;
      water.position.y = -0.12;

      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 20, 20),
        new THREE.MeshBasicMaterial({ color: "#ffd88d" }),
      );
      beacon.position.set(2.2, 1.55, 1.4);

      scene.add(terrain, water, beacon);

      return {
        update: (elapsed) => {
          beacon.position.x = Math.cos(elapsed * 0.55) * 2.8;
          beacon.position.z = Math.sin(elapsed * 0.55) * 2.8;
          beacon.position.y = 1.2 + Math.sin(elapsed * 1.8) * 0.18;
          sun.position.x = Math.cos(elapsed * 0.16) * 8;
          sun.position.z = Math.sin(elapsed * 0.16) * 8;
        },
        dispose: () => {
          geometry.dispose();
          (terrain.material as THREE.Material).dispose();
          water.geometry.dispose();
          (water.material as THREE.Material).dispose();
          beacon.geometry.dispose();
          (beacon.material as THREE.Material).dispose();
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
      scene.background = new THREE.Color("#040914");

      const ambient = new THREE.AmbientLight("#7ea8ff", 0.3);
      const key = new THREE.PointLight("#8ff2ff", 26, 18, 2);
      key.position.set(0, 3.4, 2.4);
      const rim = new THREE.DirectionalLight("#ffd7a2", 1.3);
      rim.position.set(-4, 6, -3);
      scene.add(ambient, key, rim);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(8.8, 72),
        new THREE.MeshStandardMaterial({
          color: "#071520",
          roughness: 0.98,
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
          emissiveIntensity: 0.9,
          roughness: 0.24,
          metalness: 0.42,
        }),
      );
      ring.position.set(0, 2.3, -1.2);
      ring.rotation.x = 0.15;

      const textureSize = 256;
      const portalTexture = new THREE.StorageTexture(textureSize, textureSize);
      portalTexture.colorSpace = THREE.SRGBColorSpace;

      const displayTarget = new THREE.RenderTarget(textureSize, textureSize, {
        colorSpace: THREE.SRGBColorSpace,
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
        const spiral = sin(nx.mul(nx).add(ny.mul(ny)).mul(20).sub(time.mul(2.8)));
        const bands = sin(nx.mul(12).add(time.mul(1.4)).add(cos(ny.mul(7).sub(time.mul(0.85)))));
        const plasma = sin(ny.mul(14).sub(time.mul(1.9)).add(cos(nx.mul(6).add(time.mul(1.1)))));
        const energy = spiral.add(bands).add(plasma).mul(0.18).add(0.5).clamp();
        const sparks = sin(time.mul(0.9).add(nx.mul(15).sub(ny.mul(11)))).mul(0.5).add(0.5).mul(energy);
        const baseColor = mix(color("#071224"), color("#22d8ff"), energy);
        const finalColor = mix(baseColor, color("#ffd369"), sparks);

        textureStore(portalTexture, indexUV, vec4(finalColor, 1));
      })().compute(textureSize * textureSize, [64]);

      const portal = new THREE.Mesh(
        new THREE.PlaneGeometry(5.1, 5.1, 1, 1),
        new THREE.MeshBasicMaterial({
          map: sampledTexture,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      );
      portal.position.set(0, 2.3, -1.2);
      portal.rotation.x = 0.15;

      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(1.15, 64, 64),
        new THREE.MeshStandardMaterial({
          map: sampledTexture,
          emissive: new THREE.Color("#1f4f8f"),
          emissiveMap: sampledTexture,
          emissiveIntensity: 0.65,
          roughness: 0.16,
          metalness: 0.08,
        }),
      );
      orb.position.set(0, 1.25, 1.2);
      orb.castShadow = true;

      scene.add(portal, ring, orb);

      return {
        update: (elapsed) => {
          renderer.compute(computeNode);
          renderer.copyTextureToTexture(portalTexture, sampledTexture);
          ring.rotation.z = elapsed * 0.16;
          orb.rotation.y = elapsed * 0.28;
          orb.rotation.x = Math.sin(elapsed * 0.7) * 0.18;
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
      </p>
      <div class="hero-grid">
        <div class="hero-panel">
          <strong>How to use it</strong>
          <p>Drag to orbit, scroll to zoom, and pan with right mouse. Compare how each scene adds one new idea.</p>
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
      Tip: the storage-buffer, compute-swarm, workgroup-prism, compute-heightfield, and storage-texture portal cards are the most WebGPU-specific steps before jumping into custom WGSL, GPGPU, or renderer internals.
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
    <div class="example-viewport"></div>
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

  for (const mounted of mountedExamples) {
    if (mounted.failed) {
      continue;
    }

    try {
    mounted.controls.update();
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
      mounted.controls.dispose();
      mounted.dispose?.();
      mounted.renderer.dispose();
    }
  });
}

async function mountExample(card: HTMLElement, example: ExampleDefinition): Promise<MountedExample> {
  const host = card.querySelector<HTMLDivElement>(".example-viewport");

  if (!host) {
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
