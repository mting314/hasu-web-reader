import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { createEyeHighlightMaterial } from "../UberToonMaterial";
import { createPjskFace } from "./pjskFace";
import { createPjskRetarget } from "./pjskRetarget";

/**
 * The PJSK cast swap: a Project Sekai model stands in for a Hasu character. The Hasu character
 * stays loaded with its meshes hidden, so the story motion, breathing, look-at and expressions keep
 * running on it exactly as before; every frame its pose and face weights are copied onto the PJSK
 * model (pjskRetarget.ts, pjskFace.ts). Models come from scripts/export_pjsk_model.py, listed in
 * `pjsk/models.json`.
 */

export interface PjskModelEntry {
  id: string;
  name: string;
  characterId: number;
  heightM: number;
  glbUrl: string;
}

/** How tall the stand-in is: the replaced character's size (by rest hip height), or its own. */
export type CastHeightMode = "replaced" | "pjsk";

export interface CastSwap {
  modelId: string;
  /** Copy pose and face from the hidden Hasu character (after its motion, look-at and emotion). */
  update(): void;
  setHeightMode(mode: CastHeightMode): void;
  detach(): void;
}

/**
 * Simple materials for M1: the colour texture unlit (decoded and re-encoded as sRGB, so it shows
 * the stored values like the game's gamma-space rendering). PJSK's own shaders
 * (`Sekai/Live/Character/Toon-v3`, `Eye-Base`, `Eye-Highlight`) aren't ported yet.
 */
function preparePjskMaterials(scene: THREE.Object3D) {
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false;
    const convert = (m: THREE.Material) => {
      const std = m as THREE.MeshStandardMaterial;
      const shader: string = m.userData?.unity?.shader ?? "";
      const map = std.map ?? null;
      if (shader.endsWith("/Eye-Highlight") && map) {
        const hi = createEyeHighlightMaterial(map);
        mesh.renderOrder = 2;
        return hi;
      }
      const basic = new THREE.MeshBasicMaterial({ map, name: m.name });
      if (/Eyelash|Eyebrow/i.test(m.name)) {
        basic.alphaTest = 0.5;
        basic.transparent = false;
      }
      return basic;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });
}

function restTop(model: THREE.Object3D): number {
  model.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(model, true).max.y;
}

export async function attachCastSwap(opts: {
  rootGroup: THREE.Group;
  /** the Hasu character's model (keeps animating, meshes hidden) */
  source: THREE.Object3D;
  entry: PjskModelEntry;
  loadGltf: (url: string) => Promise<GLTF>;
  heightMode: CastHeightMode;
}): Promise<CastSwap | null> {
  const gltf = await opts.loadGltf(opts.entry.glbUrl);
  if (!gltf.scene.userData.__pjskPrepared) {
    gltf.scene.userData.__pjskPrepared = true;
    preparePjskMaterials(gltf.scene);
  }
  const model = SkeletonUtils.clone(gltf.scene);
  model.name = `pjsk_${opts.entry.id}`;
  const retarget = createPjskRetarget(opts.source, model);
  if (!retarget) {
    console.warn(`[castSwap] ${opts.entry.id}: no hips to retarget from/to`);
    return null;
  }
  if (retarget.missing.length) console.info(`[castSwap] ${opts.entry.id}: unmapped bones`, retarget.missing);
  const face = createPjskFace(opts.source, model);
  const nativeTop = restTop(model);

  // The Hasu scene can be shared by two overlapping syncs of the same character, so the hidden
  // meshes are recorded on the scene and only the latest swap may show them again.
  const token = Symbol(opts.entry.id);
  const state = opts.source.userData as { castSwapHidden?: THREE.Object3D[]; castSwapToken?: symbol };
  if (!state.castSwapHidden) {
    state.castSwapHidden = [];
    opts.source.traverse((n) => {
      if ((n as THREE.Mesh).isMesh && n.visible) {
        n.visible = false;
        state.castSwapHidden!.push(n);
      }
    });
  }
  state.castSwapToken = token;
  opts.rootGroup.add(model);

  const setHeightMode = (mode: CastHeightMode) => {
    model.scale.setScalar(mode === "pjsk" ? opts.entry.heightM / nativeTop : retarget.hipRatio);
  };
  setHeightMode(opts.heightMode);
  if (import.meta.env.DEV) {
    const w = window as unknown as { __castSwaps?: Record<string, unknown> };
    (w.__castSwaps ??= {})[opts.entry.id] = { model, source: opts.source, retarget, nativeTop, THREE };
  }

  return {
    modelId: opts.entry.id,
    update() {
      retarget.update();
      face?.();
    },
    setHeightMode,
    detach() {
      opts.rootGroup.remove(model);
      if (state.castSwapToken !== token) return;
      for (const n of state.castSwapHidden ?? []) n.visible = true;
      state.castSwapHidden = undefined;
      state.castSwapToken = undefined;
    },
  };
}
