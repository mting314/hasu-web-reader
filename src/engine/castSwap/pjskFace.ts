import * as THREE from "three";
import { bindSpace, rootSpace } from "./pjskRetarget";

/**
 * Cast swap only: drive a PJSK face from the Hasu character's blendshape weights.
 *
 * The Hasu character's StoryEmotion keeps running on its hidden face (expressions, blinking, the
 * A/B lip flap), and every frame its weights are mapped onto PJSK's `BS_*` shapes through the table
 * below, the same way Cleista's uma.cleista.cc maps PJSK shapes onto Uma faces (`uma-face.js`
 * FACE_MAP): each source shape feeds one or more target shapes with a gain, several sources
 * feeding one target take the maximum, and the mouth shapes are normalized to sum to at most 1.
 *
 * PJSK's neutral face isn't all zeros: its `normal` facial preset
 * (`virtual_live/performer/facial/01_normal_01`) is mouth_happy 50, eyeblow_happy 70,
 * eyeblow_sad 30, eyeblow_smile 40, so Hasu's Mouth_Normal / Eyebrow_Normal map onto those.
 */
const FACE_MAP: Record<string, Array<[string, number]>> = {
  // mouth
  "Face_.Mouth_Normal": [["BS_mouth.mouth_happy", 0.5]],
  "Face_.Mouth_Smile": [["BS_mouth.mouth_happy", 1]],
  "Face_.Mouth_Smile_I": [["BS_mouth.mouth_niko", 1]],
  "Face_.Mouth_Laugh": [["BS_mouth.mouth_a2", 1]],
  "Face_.Mouth_Sad": [["BS_mouth.mouth_sad", 1]],
  "Face_.Mouth_Angry": [["BS_mouth.mouth_fukigen", 1]],
  "Face_.Mouth_Shout": [["BS_mouth.mouth_shout", 1]],
  "Face_.Mouth_ShoutB": [["BS_mouth.mouth_shout", 1]],
  "Face_.Mouth_A": [["BS_mouth.mouth_a", 1]],
  "Face_.Mouth_I": [["BS_mouth.mouth_i", 1]],
  "Face_.Mouth_U": [["BS_mouth.mouth_u", 1]],
  "Face_.Mouth_E": [["BS_mouth.mouth_e", 1]],
  "Face_.Mouth_O": [["BS_mouth.mouth_o", 1]],
  "Face_.Mouth_Laugh_A": [["BS_mouth.mouth_a2", 1]],
  "Face_.Mouth_Laugh_I": [["BS_mouth.mouth_i2", 1]],
  "Face_.Mouth_Laugh_U": [["BS_mouth.mouth_u2", 1]],
  "Face_.Mouth_Laugh_E": [["BS_mouth.mouth_e2", 1]],
  "Face_.Mouth_Laugh_O": [["BS_mouth.mouth_o2", 1]],
  "Face_.Mouth_pout": [["BS_mouth.mouth_mu", 1]],
  "Face_.Mouth_Sulk_Close": [["BS_mouth.mouth_mu", 1]],
  "Face_.Mouth_Odoroki": [["BS_mouth.mouth_odoroki", 1]],
  "Face_.Mouth_Doubt": [["BS_mouth.mouth_akire", 1]],
  "Face_.Mouth_BitterSmile_I": [["BS_mouth.mouth_grin", 1]],
  // eyelids (Face_ and EyeShadow_ carry the same keys; Face_ is enough)
  "Face_.Eyelids_Close_L": [["BS_eye.eye_close_L", 1]],
  "Face_.Eyelids_Close_R": [["BS_eye.eye_close_R", 1]],
  "Face_.Eyelids_Smile": [["BS_eye.eye_wink_L", 1], ["BS_eye.eye_wink_R", 1]],
  "Face_.Eyelids_SmileB_L": [["BS_eye.eye_wink_L", 1]],
  "Face_.Eyelids_SmileB_R": [["BS_eye.eye_wink_R", 1]],
  "Face_.Eyelids_Sad": [["BS_eye.eye_sad", 1]],
  "Face_.Eyelids_Angry": [["BS_eye.eye_kiritsu", 1]],
  "Face_.Eyelids_Open": [["BS_eye.eye_bikkuri", 0.6]],
  "Face_.Eyelids_Odoroki": [["BS_eye.eye_bikkuri", 1]],
  "Face_.Eyelids_Doubt": [["BS_eye.eye_jitome", 1]],
  "Face_.Eyelids_Sulk": [["BS_eye.eye_jitome", 0.7]],
  "Face_.Eyelids_Drowse": [["BS_eye.eye_jitome", 1]],
  "Face_.Eyelids_Iyasare": [["BS_eye.eye_nagomi", 1]],
  // brows
  "Brow_.Eyebrow_Normal": [
    ["BS_eyeblow.eyeblow_happy", 0.7],
    ["BS_eyeblow.eyeblow_sad", 0.3],
    ["BS_eyeblow.eyeblow_smile", 0.4],
  ],
  "Brow_.Eyebrow_Angry": [["BS_eyeblow.eyeblow_ikari", 1]],
  "Brow_.Eyebrow_Smile_L": [["BS_eyeblow.eyeblow_smile", 1]],
  "Brow_.Eyebrow_Smile_R": [["BS_eyeblow.eyeblow_smile", 1]],
  "Brow_.Eyebrow_Sad": [["BS_eyeblow.eyeblow_sad", 1]],
  "Brow_.Eyebrow_Up_L": [["BS_eyeblow.eyeblow_up", 1]],
  "Brow_.Eyebrow_Up_R": [["BS_eyeblow.eyeblow_up", 1]],
  "Brow_.Eyebrow_Down_L": [["BS_eyeblow.eyeblow_dw", 1]],
  "Brow_.Eyebrow_Down_R": [["BS_eyeblow.eyeblow_dw", 1]],
  "Brow_.Eyebrow_Sulk": [["BS_eyeblow.eyeblow_komari", 1]],
  "Brow_.Eyebrow_Doubt": [["BS_eyeblow.eyeblow_komari", 1]],
  "Brow_.Eyebrow_Odoroki": [["BS_eyeblow.eyeblow_up", 1]],
};

interface Slot {
  influences: number[];
  index: number;
}

function slotsByName(root: THREE.Object3D): Map<string, Slot[]> {
  const out = new Map<string, Slot[]>();
  root.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
      const list = out.get(name) ?? [];
      list.push({ influences: mesh.morphTargetInfluences, index });
      out.set(name, list);
    }
  });
  return out;
}

/**
 * PJSK eyes have no bones: they look through `BS_look.look_{up,down,left,right}`. The Hasu eyes are
 * humanoid bones (posed by motions and by StoryLookAt), so their angle from rest, relative to the
 * head, is read back as a Unity eye muscle value: the Hasu Avatar's eye limits
 * (`SCSch011KahDeAAvatar`) are In-Out ±20° and Down-Up −10°…+15°, and a full look shape is taken
 * as a muscle value of 1.
 */
const EYE_LIMIT_DEG = { side: 20, up: 15, down: 10 };

function createEyeLook(source: THREE.Object3D, to: Map<string, Slot[]>): (() => void) | null {
  const find = (suffix: string) => {
    let hit: THREE.Object3D | null = null;
    source.traverse((n) => {
      if (!hit && (n as THREE.Bone).isBone && n.name.endsWith(`DeA_${suffix}`)) hit = n;
    });
    return hit as THREE.Object3D | null;
  };
  const head = find("Head");
  const eyes = [find("LEye"), find("REye")].filter((e): e is THREE.Object3D => !!e);
  const shapes = ["up", "down", "left", "right"].map((d) => to.get(`BS_look.look_${d}`));
  if (!head || !eyes.length || shapes.some((s) => !s)) return null;
  const rest = (b: THREE.Object3D) => bindSpace(source, b) ?? rootSpace(source, b);
  const headRest = new THREE.Quaternion().setFromRotationMatrix(rest(head));
  // per eye: its rest rotation relative to the head, and the head-frame forward (model +Z)
  const eyeRest = eyes.map((e) =>
    headRest.clone().invert().multiply(new THREE.Quaternion().setFromRotationMatrix(rest(e)))
  );
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(headRest.clone().invert());
  const qh = new THREE.Quaternion();
  const qe = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const gaze = new THREE.Vector3();
  const [up, down, left, right] = shapes as Slot[][];
  const set = (slots: Slot[], w: number) => {
    for (const s of slots) s.influences[s.index] = Math.min(1, Math.max(0, w));
  };

  return () => {
    head.getWorldQuaternion(qh).invert();
    gaze.set(0, 0, 0);
    eyes.forEach((eye, i) => {
      // eye relative to head now, compared with its rest; applied to the head-frame forward
      eye.getWorldQuaternion(qe).premultiply(qh).multiply(eyeRest[i].clone().invert());
      gaze.add(v.copy(forward).applyQuaternion(qe));
    });
    gaze.applyQuaternion(headRest).normalize(); // into the model's rest frame (+Z forward, +X her left)
    const yaw = THREE.MathUtils.radToDeg(Math.atan2(gaze.x, gaze.z));
    const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(gaze.y, -1, 1)));
    set(left, yaw / EYE_LIMIT_DEG.side);
    set(right, -yaw / EYE_LIMIT_DEG.side);
    set(up, pitch / EYE_LIMIT_DEG.up);
    set(down, -pitch / EYE_LIMIT_DEG.down);
  };
}

export function createPjskFace(source: THREE.Object3D, target: THREE.Object3D): (() => void) | null {
  const from = slotsByName(source);
  const to = slotsByName(target);
  const eyeLook = createEyeLook(source, to);
  const links: Array<{ src: Slot; dst: string; gain: number }> = [];
  for (const [srcName, outs] of Object.entries(FACE_MAP)) {
    const src = from.get(srcName)?.[0];
    if (!src) continue;
    for (const [dst, gain] of outs) if (to.has(dst)) links.push({ src, dst, gain });
  }
  if (!links.length) return null;
  const targets = [...new Set(links.map((l) => l.dst))];
  const mouth = targets.filter((t) => t.startsWith("BS_mouth."));
  const value = new Map<string, number>();

  return () => {
    for (const t of targets) value.set(t, 0);
    for (const { src, dst, gain } of links) {
      const w = Math.min(1, Math.max(0, src.influences[src.index] ?? 0)) * gain;
      if (w > value.get(dst)!) value.set(dst, w);
    }
    const sum = mouth.reduce((a, t) => a + value.get(t)!, 0);
    if (sum > 1) for (const t of mouth) value.set(t, value.get(t)! / sum);
    for (const t of targets) for (const slot of to.get(t)!) slot.influences[slot.index] = value.get(t)!;
    eyeLook?.();
  };
}
