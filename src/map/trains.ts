import maplibregl from "maplibre-gl";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import * as THREE from "three";
import type { Train } from "../sim/fleet";

const ORIGIN: [number, number] = [126.9784, 37.5665];
const BOX_LEN = 10;
const MAX = 512;
const LAYER_ID = "metro-trains-3d";

function trainScale(zoom: number): number {
  const metersPerPx = (156543.03392 * Math.cos((37.5665 * Math.PI) / 180)) / 2 ** zoom;
  const targetPx = zoom < 12.6 ? 10 : zoom < 14 ? 13 : zoom < 15.6 ? 16 : 20;
  return Math.max(1.6, (targetPx * metersPerPx) / BOX_LEN);
}

/**
 * MapLibre 커스텀 3D 레이어. 맵의 GL 컨텍스트와 투영 행렬을 그대로 사용해서
 * 열차 박스를 노선 위에 정확히 올린다.
 */
class TrainLayer implements CustomLayerInterface {
  readonly id = LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private camera = new THREE.Camera();
  private scene = new THREE.Scene();
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private trains: Train[] = [];
  private originMerc = maplibregl.MercatorCoordinate.fromLngLat(ORIGIN, 0);
  private boxes: THREE.InstancedMesh;
  private rotX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  private local = new THREE.Matrix4();
  private proj = new THREE.Matrix4();
  private scaleV = new THREE.Vector3();
  private bufW = 0;
  private bufH = 0;

  constructor() {
    const geo = new THREE.BoxGeometry(BOX_LEN, 3.2, 3.2);
    geo.translate(0, 1.6, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    mat.toneMapped = false;
    this.boxes = new THREE.InstancedMesh(geo, mat, MAX);
    this.boxes.frustumCulled = false;
    this.boxes.count = 0;
    this.scene.add(this.boxes);
  }

  setTrains(trains: Train[]): void {
    this.trains = trains;
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
    });
    this.renderer.autoClear = false;
  }

  onRemove(): void {
    this.scene.clear();
    this.boxes.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  render(_gl: unknown, args: CustomRenderMethodInput): void {
    const map = this.map;
    const renderer = this.renderer;
    if (!map || !renderer) return;

    this.syncViewport(renderer, map.getCanvas());
    this.sync(map.getZoom());
    if (this.boxes.count === 0) return;

    const t = this.originMerc;
    const meter = t.meterInMercatorCoordinateUnits();
    this.scaleV.set(meter, -meter, meter);
    this.local
      .identity()
      .makeTranslation(t.x, t.y, t.z)
      .scale(this.scaleV)
      .multiply(this.rotX);

    this.camera.projectionMatrix = this.proj
      .fromArray(args.defaultProjectionData.mainMatrix)
      .multiply(this.local);

    renderer.resetState();
    renderer.render(this.scene, this.camera);
    map.triggerRepaint();
  }

  /**
   * three는 생성 시점의 캔버스 크기로 뷰포트를 고정한다. 창 크기나 devicePixelRatio가
   * 바뀌면 GL 뷰포트가 옛 값에 묶여 화면 일부만 그려지므로 매 프레임 맞춰 준다.
   */
  private syncViewport(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement): void {
    if (canvas.width === this.bufW && canvas.height === this.bufH) return;
    this.bufW = canvas.width;
    this.bufH = canvas.height;
    renderer.setPixelRatio(1);
    renderer.setViewport(0, 0, this.bufW, this.bufH);
  }

  private sync(zoom: number): void {
    const origin = this.originMerc;
    const meter = origin.meterInMercatorCoordinateUnits();
    const s = trainScale(zoom);
    let n = 0;

    for (const train of this.trains) {
      if (n >= MAX) break;
      const p = maplibregl.MercatorCoordinate.fromLngLat(train.coord, 0);
      this.dummy.position.set((p.x - origin.x) / meter, 2.4, (p.y - origin.y) / meter);
      this.dummy.rotation.set(0, ((90 - train.heading) * Math.PI) / 180, 0);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.boxes.setMatrixAt(n, this.dummy.matrix);
      this.color.set(train.color);
      this.boxes.setColorAt(n, this.color);
      n++;
    }

    this.boxes.count = n;
    this.boxes.instanceMatrix.needsUpdate = true;
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
  }
}

let layer: TrainLayer | null = null;

export function addTrainLayers(map: MapLibreMap, trains: Train[]): void {
  for (const id of [LAYER_ID, "metro-train-dot", "metro-train-glow", "metro-train-body"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource("metro-trains")) map.removeSource("metro-trains");

  document.querySelector("#train-overlay")?.remove();

  layer = new TrainLayer();
  layer.setTrains(trains);
  map.addLayer(layer);
}

export function updateTrains(map: MapLibreMap, trains: Train[]): void {
  if (!layer || !map.getLayer(LAYER_ID)) return;
  layer.setTrains(trains);
  map.triggerRepaint();
}
