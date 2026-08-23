import maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";
import * as THREE from "three";
import type { Train } from "../sim/fleet";

const ORIGIN: [number, number] = [126.9784, 37.5665];
const BOX_LEN = 10;
const MAX = 512;

function trainScale(zoom: number): number {
  const metersPerPx = (156543.03392 * Math.cos((37.5665 * Math.PI) / 180)) / 2 ** zoom;
  const targetPx = zoom < 12.6 ? 10 : zoom < 14 ? 13 : zoom < 15.6 ? 16 : 20;
  return Math.max(1.6, (targetPx * metersPerPx) / BOX_LEN);
}

class MetroTrainOverlay {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private camera = new THREE.Camera();
  private scene = new THREE.Scene();
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private trains: Train[] = [];
  private originMerc = maplibregl.MercatorCoordinate.fromLngLat(ORIGIN, 0);
  private boxes: THREE.InstancedMesh;

  constructor(map: MapLibreMap) {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "train-overlay";
    this.canvas.setAttribute("aria-hidden", "true");
    (map.getCanvas().parentElement ?? map.getContainer()).appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = true;

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

  draw(map: MapLibreMap): void {
    const host = map.getCanvas();
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w < 2 || h < 2) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);

    this.sync(map.getZoom());

    const t = this.originMerc;
    const meter = t.meterInMercatorCoordinateUnits();
    const proj = map.transform.getProjectionDataForCustomLayer(false);
    const rotationX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const m = new THREE.Matrix4().fromArray(proj.mainMatrix);
    const l = new THREE.Matrix4()
      .makeTranslation(t.x, t.y, t.z)
      .scale(new THREE.Vector3(meter, -meter, meter))
      .multiply(rotationX);
    this.camera.projectionMatrix = m.multiply(l);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.scene.clear();
    this.renderer.dispose();
    this.canvas.remove();
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

let overlay: MetroTrainOverlay | null = null;

export function addTrainLayers(map: MapLibreMap, trains: Train[]): void {
  for (const id of ["metro-trains-3d", "metro-train-dot", "metro-train-glow", "metro-train-body"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource("metro-trains")) map.removeSource("metro-trains");

  if (overlay) {
    overlay.dispose();
    overlay = null;
  }
  overlay = new MetroTrainOverlay(map);
  overlay.setTrains(trains);
}

export function updateTrains(map: MapLibreMap, trains: Train[]): void {
  if (!overlay) return;
  overlay.setTrains(trains);
  overlay.draw(map);
}
