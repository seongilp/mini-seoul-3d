import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * Blender 로 만든 전동차 모델(scripts/build-train-model.py).
 * 부품은 `<차종>_<부품>` 이름의 메시로 들어 있고, 칸 단위 공간(길이 x ±0.5,
 * 높이 y 0~1, 폭 z ±0.5)에 맞춰져 있어 칸 변환 행렬을 그대로 곱하면 된다.
 */
const MODEL_URL = `${import.meta.env.BASE_URL}models/train.glb`;

const CAR_PARTS = ["body", "trim", "glass", "roof", "under"] as const;
type CarPart = (typeof CAR_PARTS)[number];
type CarGeometries = Record<CarPart, THREE.BufferGeometry>;

export interface TrainModel {
  mid: CarGeometries;
  cab: CarGeometries;
  /** 운전실차 앞면의 등. 전조등·미등이 같은 형상을 쓴다. */
  lamp: THREE.BufferGeometry;
}

/** 문짝·허리띠의 은색. */
const TRIM_COLOR = 0xeef1f4;
/** 대차·바퀴. */
const UNDER_COLOR = 0x2b3038;
const GLASS_DAY = 0x1b2330;
/** 밤에는 창에 실내등이 비친다. */
const GLASS_NIGHT_GLOW = 0xffd9a0;
const GLASS_NIGHT_INTENSITY = 0.85;

function geometryOf(root: THREE.Object3D, name: string): THREE.BufferGeometry {
  const found = root.getObjectByName(name);
  if (!(found instanceof THREE.Mesh)) {
    throw new Error(`전동차 모델에 ${name} 부품이 없습니다`);
  }
  return found.geometry as THREE.BufferGeometry;
}

function carGeometries(root: THREE.Object3D, prefix: string): CarGeometries {
  return Object.fromEntries(
    CAR_PARTS.map((part) => [part, geometryOf(root, `${prefix}_${part}`)]),
  ) as CarGeometries;
}

export async function loadTrainModel(): Promise<TrainModel> {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  return {
    mid: carGeometries(gltf.scene, "mid"),
    cab: carGeometries(gltf.scene, "cab"),
    lamp: geometryOf(gltf.scene, "cab_lamp"),
  };
}

/** 조명을 받는 재질. 지도 위에서 색이 바래지 않게 톤매핑은 끈다. */
function lit(color: number): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color });
  mat.toneMapped = false;
  return mat;
}

export function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

/** 한 차종(중간차 또는 운전실차)을 부품별 인스턴스 메시로 묶은 것. */
export class CarKit {
  private readonly parts: Record<CarPart, THREE.InstancedMesh>;
  private readonly glass: THREE.MeshLambertMaterial;
  private readonly capacity: number;
  private n = 0;

  constructor(geometries: CarGeometries, capacity: number) {
    this.capacity = capacity;
    this.glass = lit(GLASS_DAY);
    const materials: Record<CarPart, THREE.Material> = {
      body: lit(0xffffff),
      trim: lit(TRIM_COLOR),
      glass: this.glass,
      roof: lit(0xffffff),
      under: lit(UNDER_COLOR),
    };
    this.parts = Object.fromEntries(
      CAR_PARTS.map((part) => [part, instanced(geometries[part], materials[part], capacity)]),
    ) as Record<CarPart, THREE.InstancedMesh>;
  }

  addTo(scene: THREE.Scene): void {
    for (const part of CAR_PARTS) scene.add(this.parts[part]);
  }

  setNight(night: boolean): void {
    this.glass.emissive.set(night ? GLASS_NIGHT_GLOW : 0x000000);
    this.glass.emissiveIntensity = night ? GLASS_NIGHT_INTENSITY : 0;
  }

  begin(): void {
    this.n = 0;
  }

  /** 칸 하나를 놓는다. 자리가 없으면 조용히 건너뛴다. */
  place(matrix: THREE.Matrix4, body: THREE.Color, roof: THREE.Color): void {
    if (this.n >= this.capacity) return;
    for (const part of CAR_PARTS) this.parts[part].setMatrixAt(this.n, matrix);
    this.parts.body.setColorAt(this.n, body);
    this.parts.roof.setColorAt(this.n, roof);
    this.n++;
  }

  commit(): void {
    for (const part of CAR_PARTS) {
      const mesh = this.parts[part];
      mesh.count = this.n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const part of CAR_PARTS) {
      const mesh = this.parts[part];
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}

/** 전조등이 바닥에 깔리는 빛. 가운데가 밝고 가장자리로 스러지는 원. */
export function beamTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.45)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}
