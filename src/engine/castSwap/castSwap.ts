import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { createPjskFace } from "./pjskFace";
import {
  newPjskShaderState,
  preparePjskShaders,
  setPjskShaderTime,
  updatePjskShaderState,
  type PjskShaderState,
} from "./pjskMaterial";
import { createPjskRetarget } from "./pjskRetarget";
import { createUtjSpringBones } from "./utjSpringBone";

/**
 * The PJSK cast swap: a Project Sekai model stands in for a Hasu character. The Hasu character
 * stays loaded with its meshes hidden, so the story motion, breathing, look-at and expressions keep
 * running on it exactly as before; every frame its pose and face weights are copied onto the PJSK
 * model (pjskRetarget.ts, pjskFace.ts), and its hair and skirt run PJSK's spring bones
 * (utjSpringBone.ts). Models come from scripts/export_pjsk_model.py, listed in
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
  /** Copy pose and face from the hidden Hasu character (after its motion, look-at and emotion),
   * then step the spring bones by `dt` seconds. */
  update(dt: number): void;
  setHeightMode(mode: CastHeightMode): void;
  detach(): void;
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
  // Materials are shared by every clone of the model, so their per-model state (_FaceFront) is too.
  const scene = gltf.scene as THREE.Object3D & { userData: { pjskShaders?: Promise<void>; pjskState?: PjskShaderState } };
  if (!scene.userData.pjskShaders) {
    const shaderState = newPjskShaderState();
    scene.userData.pjskState = shaderState;
    scene.userData.pjskShaders = preparePjskShaders(
      scene,
      (index) => gltf.parser.getDependency("texture", index),
      shaderState
    );
  }
  await scene.userData.pjskShaders;
  const shaderState = scene.userData.pjskState!;
  const model = SkeletonUtils.clone(gltf.scene);
  model.name = `pjsk_${opts.entry.id}`;
  const retarget = createPjskRetarget(opts.source, model);
  if (!retarget) {
    console.warn(`[castSwap] ${opts.entry.id}: no hips to retarget from/to`);
    return null;
  }
  if (retarget.missing.length) console.info(`[castSwap] ${opts.entry.id}: unmapped bones`, retarget.missing);
  const face = createPjskFace(opts.source, model);
  // On the rest pose, before any scaling. readerCollision: keep the hair out of the body in Hasu's
  // tilted and seated poses (more colliders than the game gives it, along the whole bone).
  const springs = createUtjSpringBones(model, { readerCollision: true });
  const nativeTop = restTop(model);
  // CharacterModel.headTransform, and SekaiCharacterHair's offset (export_pjsk_model.py extras)
  const head = model.getObjectByName("Head") ?? null;
  let hairOffset: THREE.Vector3 | null = null;
  model.traverse((n) => {
    const h = n.userData.sekaiCharacterHair as { offset: [number, number, number] } | undefined;
    if (h && !hairOffset) hairOffset = new THREE.Vector3(...h.offset);
  });

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
    springs?.reset();
  };
  setHeightMode(opts.heightMode);
  if (import.meta.env.DEV) {
    const w = window as unknown as { __castSwaps?: Record<string, unknown> };
    (w.__castSwaps ??= {})[opts.entry.id] = { model, source: opts.source, retarget, springs, nativeTop, THREE };
  }

  return {
    modelId: opts.entry.id,
    update(dt) {
      retarget.update();
      face?.();
      springs?.update(dt);
      if (head) updatePjskShaderState(shaderState, head, hairOffset);
      setPjskShaderTime(performance.now() / 1000);
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
