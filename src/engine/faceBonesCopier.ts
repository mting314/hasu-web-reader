import * as THREE from "three";

/**
 * The game's `Inspix.FaceBonesCopier`. The face rig (`3d_face_<id>`) is a sibling of the body,
 * not its child; every frame after animation (LateUpdate, RVA 0x4F4A440) the game copies the body
 * onto it: the face's spine03 takes the body UpperChest's world position and rotation, and its
 * neck, head and eyes take the local rotations of the body's Neck, Head and eyes.
 *
 * scripts/export_costume.py records the pairs as node extras `faceBonesCopier`
 * ({field: [face bone, body bone]}). Returns the per-frame copy, or null if the costume has none.
 */
export function createFaceBonesCopier(root: THREE.Object3D): (() => void) | null {
  let pairs: Record<string, [string, string]> | null = null;
  root.traverse((node) => {
    if (node.userData.faceBonesCopier) pairs = node.userData.faceBonesCopier;
  });
  if (!pairs) return null;
  const find = ([face, body]: [string, string]) => {
    const f = root.getObjectByName(face);
    const b = root.getObjectByName(body);
    return f && b ? { face: f, body: b } : null;
  };
  const p = pairs as Record<string, [string, string]>;
  const spine = p.spine03 ? find(p.spine03) : null;
  const locals = ["neck", "head", "leftEye", "rightEye"]
    .map((k) => (p[k] ? find(p[k]) : null))
    .filter((x): x is { face: THREE.Object3D; body: THREE.Object3D } => x !== null);

  const world = new THREE.Matrix4();
  const parentInv = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  return () => {
    if (spine?.face.parent) {
      spine.body.updateWorldMatrix(true, false);
      spine.face.parent.updateWorldMatrix(true, false);
      // spine03.position / .rotation = UpperChest's (world space); its own scale stays
      spine.body.matrixWorld.decompose(pos, quat, scale);
      world.compose(pos, quat, spine.face.scale);
      parentInv.copy(spine.face.parent.matrixWorld).invert();
      world.premultiply(parentInv).decompose(spine.face.position, spine.face.quaternion, scale);
    }
    for (const { face, body } of locals) face.quaternion.copy(body.quaternion);
  };
}
