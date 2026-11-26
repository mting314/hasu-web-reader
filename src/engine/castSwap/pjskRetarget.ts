import * as THREE from "three";

/**
 * Cast swap only: copy a Hasu character's pose onto a Project Sekai model every frame.
 *
 * PJSK's Avatars are Generic (no humanoid muscle data), so the motion can't be solved on the PJSK
 * rig the way Unity would. This follows Cleista's uma.cleista.cc (`js/mv/uma-retarget.js`, Uma
 * Musume models in PJSK MVs): the source character keeps playing everything (story motion,
 * breathing, look-at) on its own hidden rig, and each mapped target bone takes the source bone's
 * root-space rotation times a constant correction measured at rest:
 *
 *   correction = sourceRest⁻¹ · align(target bone direction → source bone direction) · targetRest
 *
 * so the two rest poses don't have to match (Hasu binds in an A-pose, PJSK in a T-pose). The hips
 * take the source hips' position, scaled by the ratio of the rest hip heights.
 *
 * This is the one place the reader hand-rolls a pose transfer (agreed for this feature only);
 * everything else goes through the game's own data or canonical libraries.
 */

/** Hasu body bone suffix (after `<Chr>DeA_`) -> PJSK bone name */
const BONE_MAP: Record<string, string> = {
  Hips: "Hip",
  Spine_01: "Waist",
  Spine_02: "Spine",
  Spine_03: "Chest",
  Neck: "Neck",
  Head: "Head",
};
for (const [h, p] of [
  ["L", "Left"],
  ["R", "Right"],
] as const) {
  Object.assign(BONE_MAP, {
    [`${h}Shoulder`]: `${p}_Shoulder`,
    [`${h}Arm`]: `${p}_Arm`,
    [`${h}ForeArm`]: `${p}_Elbow`,
    [`${h}Hand`]: `${p}_Wrist`,
    [`${h}UpLeg`]: `${p}_Thigh`,
    [`${h}Leg`]: `${p}_Knee`,
    [`${h}Foot`]: `${p}_Ankle`,
    [`${h}ToeBase`]: `${p}_Toe`,
  });
  for (const f of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
    for (const s of ["01", "02", "03"]) BONE_MAP[`${h}Hand${f}_${s}`] = `${p}_${f}_${s}`;
  }
}

/** PJSK bone -> the child that gives its direction (for the rest alignment) */
const NEXT: Record<string, string> = { Hip: "Waist", Waist: "Spine", Spine: "Chest", Chest: "Neck", Neck: "Head" };
for (const side of ["Left", "Right"]) {
  for (const [a, b] of [
    ["Shoulder", "Arm"],
    ["Arm", "Elbow"],
    ["Elbow", "Wrist"],
    ["Wrist", "Middle_01"],
    ["Thigh", "Knee"],
    ["Knee", "Ankle"],
    ["Ankle", "Toe"],
  ]) {
    NEXT[`${side}_${a}`] = `${side}_${b}`;
  }
  for (const f of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
    NEXT[`${side}_${f}_01`] = `${side}_${f}_02`;
    NEXT[`${side}_${f}_02`] = `${side}_${f}_03`;
  }
}

interface Pair {
  source: THREE.Object3D;
  target: THREE.Object3D;
  correction: THREE.Quaternion;
  /** this frame's target rotation in the target root's space */
  rootQ: THREE.Quaternion;
}

/** `node`'s transform relative to `root`, from the local transforms on the way up. */
export function rootSpace(root: THREE.Object3D, node: THREE.Object3D): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  for (let n: THREE.Object3D | null = node; n && n !== root; n = n.parent) {
    n.updateMatrix();
    m.premultiply(n.matrix);
  }
  return m;
}

/**
 * The bone's bind (rest) transform relative to `root`, from a skin's inverse bind matrix: the
 * source rig is usually mid-motion when a swap is attached, so its current pose isn't the rest.
 */
export function bindSpace(root: THREE.Object3D, bone: THREE.Object3D): THREE.Matrix4 | null {
  let found: THREE.Matrix4 | null = null;
  root.traverse((n) => {
    if (found || !(n as THREE.SkinnedMesh).isSkinnedMesh) return;
    const mesh = n as THREE.SkinnedMesh;
    const i = mesh.skeleton.bones.indexOf(bone as THREE.Bone);
    if (i < 0) return;
    // GLTFLoader binds with the mesh's world matrix at load, when the scene root was the origin
    found = mesh.bindMatrix.clone().multiply(mesh.skeleton.boneInverses[i].clone().invert());
  });
  return found;
}

const pos = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
const rot = (m: THREE.Matrix4) => new THREE.Quaternion().setFromRotationMatrix(m).normalize();

export interface PjskRetarget {
  /** Copy the source's current pose onto the target (call after the source's motion and look-at). */
  update(): void;
  /** target scale that makes its rest hip height equal the source's */
  hipRatio: number;
  /** Hasu bones with no PJSK counterpart found */
  missing: string[];
}

export function createPjskRetarget(source: THREE.Object3D, target: THREE.Object3D): PjskRetarget | null {
  const hips = (() => {
    let h: THREE.Object3D | null = null;
    source.traverse((n) => {
      if (!h && (n as THREE.Bone).isBone && /DeA_Hips$/.test(n.name)) h = n;
    });
    return h as THREE.Object3D | null;
  })();
  if (!hips) return null;
  const prefix = hips.name.slice(0, -"Hips".length);
  const sourceByName = new Map<string, THREE.Object3D>();
  source.traverse((n) => {
    if (n.name.startsWith(prefix)) sourceByName.set(n.name.slice(prefix.length), n);
  });
  const targetByName = new Map<string, THREE.Object3D>();
  target.traverse((n) => {
    if ((n as THREE.Bone).isBone || n.children.length) targetByName.set(n.name, n);
  });
  const toSource = Object.fromEntries(Object.entries(BONE_MAP).map(([h, p]) => [p, h]));

  const sourceRest = (suffix: string) => {
    const bone = sourceByName.get(suffix);
    return bone ? bindSpace(source, bone) ?? rootSpace(source, bone) : null;
  };
  const pairs: Pair[] = [];
  const missing: string[] = [];
  for (const [suffix, targetName] of Object.entries(BONE_MAP)) {
    const s = sourceByName.get(suffix);
    const t = targetByName.get(targetName);
    const sRest = sourceRest(suffix);
    if (!s || !t || !sRest) {
      if (s) missing.push(suffix);
      continue;
    }
    const tRest = rootSpace(target, t);
    const align = new THREE.Quaternion();
    const nextName = NEXT[targetName];
    const sChildRest = nextName ? sourceRest(toSource[nextName]) : null;
    const tChild = nextName ? targetByName.get(nextName) : undefined;
    if (sChildRest && tChild) {
      const sDir = pos(sChildRest).sub(pos(sRest)).normalize();
      const tDir = pos(rootSpace(target, tChild)).sub(pos(tRest)).normalize();
      align.setFromUnitVectors(tDir, sDir);
    }
    const correction = rot(sRest).invert().multiply(align).multiply(rot(tRest)).normalize();
    pairs.push({ source: s, target: t, correction, rootQ: new THREE.Quaternion() });
  }

  const targetHip = targetByName.get("Hip");
  const sourceHipRest = sourceRest("Hips");
  if (!targetHip || !sourceHipRest) return null;
  const hipRatio = pos(sourceHipRest).y / pos(rootSpace(target, targetHip)).y;
  const hipParentInv = rootSpace(target, targetHip.parent!).invert();

  const byTarget = new Map(pairs.map((p) => [p.target, p]));
  const order: THREE.Object3D[] = [];
  target.traverse((n) => {
    if (n !== target) order.push(n);
  });
  const rootQ = new Map<THREE.Object3D, THREE.Quaternion>(order.map((n) => [n, new THREE.Quaternion()]));
  rootQ.set(target, new THREE.Quaternion());
  const sourceRootInv = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  const parentInv = new THREE.Quaternion();
  const hipPos = new THREE.Vector3();

  function update() {
    source.updateMatrixWorld(true);
    sourceRootInv.copy(source.matrixWorld).invert();
    for (const p of pairs) {
      m.multiplyMatrices(sourceRootInv, p.source.matrixWorld);
      p.rootQ.setFromRotationMatrix(m).normalize().multiply(p.correction);
    }
    // Parents before children: a mapped bone's local rotation is its target rotation seen from
    // its parent's (already updated) frame; unmapped nodes keep their local rotation.
    for (const node of order) {
      const parentQ = rootQ.get(node.parent!)!;
      const pair = byTarget.get(node);
      if (pair) {
        node.quaternion.copy(parentInv.copy(parentQ).invert()).multiply(pair.rootQ).normalize();
        rootQ.get(node)!.copy(pair.rootQ);
      } else {
        rootQ.get(node)!.copy(parentQ).multiply(node.quaternion);
      }
    }
    m.multiplyMatrices(sourceRootInv, hips!.matrixWorld);
    hipPos.setFromMatrixPosition(m).divideScalar(hipRatio).applyMatrix4(hipParentInv);
    targetHip!.position.copy(hipPos);
  }

  return { update, hipRatio, missing };
}
