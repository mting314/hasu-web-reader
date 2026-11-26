import * as THREE from "three";
import { CharacterState } from "../types/scenario";

/**
 * Humanoid Look-At controller ported from the game's `Tecotec.ModelHandler` and
 * `Tecotec.CharaLookCommand` (`libil2cpp.so`) plus the `SightWeightSettings` component on the
 * story player's `ModelHolder` prefab (`data-inspect/apk/data.unity3d` -> `resources.assets`,
 * `GameObject` "ModelHolder" path_id=35845, `MonoBehaviour` path_id=125774).
 *
 * Game values & methods:
 * - `SightWeightSettings` (`ModelHolder` prefab):
 *     weight = 0.5, bodyWeight = 0.1, headWeight = 0.25, eyesWeight = 0.25, clampWeight = 0.5
 * - `ModelHandler..cctor` (`0x497ADEC`):
 *     LookAtMaxAngle = 90.0f
 * - `ModelHandler.OnCostumeLoaded` (`0x497B62C`):
 *     this.eye = bodyAnimator.GetBoneTransform(HumanBodyBones.LeftEye) (`<Chr>DeA_LEye`)
 * - `ModelHandler.DistanceToEye` (`0x497B1F0`):
 *     this.eye ? (this.eye.position.y - this.transform.position.y) : 0f
 * - `ModelHandler.CalculateLookAtPostionByAngle(float degree)` (`0x497BF48`):
 *     this.transform.position
 *       + Quaternion.AngleAxis(degree, Vector3.up) * this.transform.forward
 *       + new Vector3(0f, this.DistanceToEye, 0f)
 * - `ModelHandler.SetLookAtTarget(Transform target, bool useTransition = true, float duration = 0)` (`0x497D5B0`)
 * - `ModelHandler.SetLookAtAngle(float degree, bool useTransition = true)` (`0x497D780`)
 * - `ModelHandler.Update` (`0x497E500`):
 *     if (lookAtTargetDuration > 0f) {
 *       elapsedTimeFromStartLook += Time.deltaTime;
 *       lookAtRatioForTarget = Mathf.Clamp01(elapsedTimeFromStartLook / lookAtTargetDuration);
 *     }
 * - `ModelHandler.OnIKPass` (`0x497E97C`):
 *   - When `LookAtTarget == null` (angle / direction mode):
 *       animator.SetLookAtWeight(weight=0.5f, bodyWeight=0f, headWeight=0f, eyesWeight=0.25f, clampWeight=0.5f);
 *       animator.SetLookAtPosition(LookAtPositionByAngle);
 *   - When `LookAtTarget != null` (character or world-position target mode):
 *       animator.SetLookAtWeight(weight=0.5f, bodyWeight=0.1f, headWeight=0.25f, eyesWeight=0.25f, clampWeight=0.5f);
 *       animator.SetLookAtPosition(Vector3.Lerp(lastLookAtPosition, setLookAtPosition, Mathf.Clamp01(lookAtRatioForTarget)));
 * - `CharaLookCommand.DoExecute` (`0x4132B3C`):
 *   - "キャラ指定": target = targetModel.EyeBoneTransform, SetLookAtTarget(target, !skip, duration)
 *   - "座標指定":   charaLookTargetObj.localPosition = pos, SetLookAtTarget(charaLookTargetObj, !skip, duration)
 *   - "角度指定":   SetLookAtAngle(degree, !skip)
 *   - "向き指定":   SetLookAtAngle(ratio * 90.0f, !skip)
 *   - otherwise:  SetLookAtTarget(null, !skip, duration)
 */

export const SIGHT_WEIGHT_SETTINGS = {
  weight: 0.5,
  bodyWeight: 0.1,
  headWeight: 0.25,
  eyesWeight: 0.25,
  clampWeight: 0.5,
} as const;

export const LOOK_AT_MAX_ANGLE_DEG = 90.0;

type LookTarget =
  | { kind: "object"; object: THREE.Object3D }
  | { kind: "point"; point: THREE.Vector3 };

interface LookBone {
  bone: THREE.Object3D;
  /** Rest forward direction (+Z in model space) expressed in this bone's local space */
  localForward: THREE.Vector3;
  /** Share of its group's weight (spine shares sum to 1, head shares sum to 1, each eye is 1) */
  share: number;
  /** Saved post-AnimationMixer rotation so look-at is layered cleanly each frame without accumulating */
  savedQuat: THREE.Quaternion;
  hasSaved: boolean;
}

const _tmpVecA = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();
const _tmpVecC = new THREE.Vector3();
const _tmpQuatA = new THREE.Quaternion();
const _tmpQuatB = new THREE.Quaternion();

/** Find a bone on the animated body rig (preferring `<Chr>DeA_<suffix>` over the face rig). */
function findBodyBone(root: THREE.Object3D, suffix: string): THREE.Object3D | null {
  let fallback: THREE.Object3D | null = null;
  let found: THREE.Object3D | null = null;
  root.traverse((node) => {
    if (found) return;
    if (node.name.endsWith(`DeA_${suffix}`)) {
      found = node;
    } else if (!fallback && node.name.endsWith(`_${suffix}`)) {
      fallback = node;
    }
  });
  return found ?? fallback;
}

export class StoryLookAt {
  private readonly rootGroup: THREE.Object3D;
  private readonly eyeBone: THREE.Object3D | null;
  private readonly restEyeHeight: number;
  private readonly spineBones: LookBone[] = [];
  private readonly headBones: LookBone[] = [];
  private readonly eyeBones: LookBone[] = [];

  private target: LookTarget | null = null;
  private angleDeg = 0;
  private readonly lookAtPositionByAngle = new THREE.Vector3();
  private readonly lastLookAtPosition = new THREE.Vector3();
  private readonly setLookAtPosition = new THREE.Vector3();
  private elapsedTimeFromStartLook = 0;
  private lookAtRatioForTarget = 1;
  private lookAtTargetDuration = 0;
  private lastCmdKey: string | null = null;

  constructor(rootGroup: THREE.Object3D, modelScene: THREE.Object3D) {
    this.rootGroup = rootGroup;
    modelScene.updateMatrixWorld(true);

    const modelWorldPos = modelScene.getWorldPosition(new THREE.Vector3());
    const modelWorldQuat = modelScene.getWorldQuaternion(new THREE.Quaternion());
    // In the GLB bind pose, the character faces +Z in modelScene space.
    const modelForwardWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(modelWorldQuat).normalize();

    const makeLookBone = (suffix: string, share: number): LookBone | null => {
      const bone = findBodyBone(modelScene, suffix);
      if (!bone) return null;
      const boneWorldQuat = bone.getWorldQuaternion(new THREE.Quaternion());
      const localForward = modelForwardWorld
        .clone()
        .applyQuaternion(boneWorldQuat.invert())
        .normalize();
      return {
        bone,
        localForward,
        share,
        savedQuat: bone.quaternion.clone(),
        hasSaved: false,
      };
    };

    // Humanoid Spine -> Chest -> UpperChest chain (shares sum to 1.0 of bodyWeight)
    const spineSpecs: Array<[string, number]> = [
      ["Spine_01", 0.25],
      ["Spine_02", 0.35],
      ["Spine_03", 0.4],
    ];
    for (const [suffix, share] of spineSpecs) {
      const lb = makeLookBone(suffix, share);
      if (lb) this.spineBones.push(lb);
    }

    // Humanoid Neck -> Head chain (shares sum to 1.0 of headWeight)
    const headSpecs: Array<[string, number]> = [
      ["Neck", 0.35],
      ["Head", 0.65],
    ];
    for (const [suffix, share] of headSpecs) {
      const lb = makeLookBone(suffix, share);
      if (lb) this.headBones.push(lb);
    }

    // Humanoid LeftEye & RightEye (each gets 1.0 of eyesWeight)
    for (const suffix of ["LEye", "REye"]) {
      const lb = makeLookBone(suffix, 1.0);
      if (lb) this.eyeBones.push(lb);
    }

    // ModelHandler.OnCostumeLoaded: this.eye = bodyAnimator.GetBoneTransform(HumanBodyBones.LeftEye)
    this.eyeBone = findBodyBone(modelScene, "LEye");
    if (this.eyeBone) {
      const eyeWorldPos = this.eyeBone.getWorldPosition(new THREE.Vector3());
      this.restEyeHeight = eyeWorldPos.y - modelWorldPos.y;
    } else {
      this.restEyeHeight = 1.38;
    }

    this.calculateLookAtPositionByAngle(0, this.lookAtPositionByAngle);
    this.lastLookAtPosition.copy(this.lookAtPositionByAngle);
  }

  /** `ModelHandler.EyeBoneTransform` (`<Chr>DeA_LEye`), used when another character targets this one. */
  getEyeBoneTransform(): THREE.Object3D | null {
    return this.eyeBone;
  }

  /** `ModelHandler.DistanceToEye` (`0x497B1F0`): `this.eye.position.y - this.transform.position.y`. */
  private distanceToEye(): number {
    if (!this.eyeBone) return 0;
    this.eyeBone.updateWorldMatrix(true, false);
    const dy = this.eyeBone.getWorldPosition(_tmpVecA).y - this.rootGroup.position.y;
    return Number.isFinite(dy) && dy > 0.1 ? dy : this.restEyeHeight;
  }

  /**
   * `ModelHandler.CalculateLookAtPostionByAngle(float degree)` (`0x497BF48`) in Three.js world space.
   *
   * In Unity:
   *   `transform.position + Quaternion.AngleAxis(degree, Vector3.up) * transform.forward + (0, DistanceToEye, 0)`
   * With Three.js coordinates `(x, y, -z)` and `rootGroup.rotation.y = π - ry_unity`, a clockwise
   * Unity yaw of `+degree` around `+Y` corresponds to `yaw_three = rootGroup.rotation.y - degToRad(degree)`.
   */
  private calculateLookAtPositionByAngle(degree: number, out: THREE.Vector3): THREE.Vector3 {
    const yaw = this.rootGroup.rotation.y - THREE.MathUtils.degToRad(degree);
    return out.set(
      this.rootGroup.position.x + Math.sin(yaw),
      this.rootGroup.position.y + this.distanceToEye(),
      this.rootGroup.position.z + Math.cos(yaw)
    );
  }

  private sampleTargetWorldPosition(target: LookTarget, out: THREE.Vector3): THREE.Vector3 {
    if (target.kind === "point") {
      return out.copy(target.point);
    }
    target.object.updateWorldMatrix(true, false);
    return target.object.getWorldPosition(out);
  }

  /** `ModelHandler.SetLookAtTarget(Transform target, bool useTransition = true, float duration = 0)` (`0x497D5B0`). */
  setLookAtTarget(target: LookTarget | null, useTransition = true, duration = 0): void {
    if (target === null && this.target !== null) {
      this.angleDeg = 0;
      this.calculateLookAtPositionByAngle(0, this.lookAtPositionByAngle);
      this.lastLookAtPosition.copy(this.setLookAtPosition);
    } else if (target !== null && this.target === null) {
      this.calculateLookAtPositionByAngle(0, this.lastLookAtPosition);
    } else {
      this.lastLookAtPosition.copy(this.setLookAtPosition);
    }

    this.target = target;
    this.elapsedTimeFromStartLook = 0;
    this.lookAtRatioForTarget = 0;
    this.lookAtTargetDuration = duration;

    if (target !== null) {
      this.sampleTargetWorldPosition(target, this.setLookAtPosition);
    } else {
      this.setLookAtPosition.set(0, 0, 0);
    }

    if (duration <= 0 || !useTransition) {
      this.lookAtRatioForTarget = 1;
      if (!useTransition) {
        this.elapsedTimeFromStartLook = duration;
      }
    }
  }

  /** `ModelHandler.SetLookAtAngle(float degree, bool useTransition = true)` (`0x497D780`). */
  setLookAtAngle(degree: number, useTransition = true): void {
    this.setLookAtTarget(null, false, 0);
    this.angleDeg = degree;
    if (this.lastLookAtPosition.distanceToSquared(this.lookAtPositionByAngle) >= 1e-10) {
      this.lookAtRatioForTarget = 1;
    }
    this.lastLookAtPosition.copy(this.lookAtPositionByAngle);
    this.calculateLookAtPositionByAngle(degree, this.lookAtPositionByAngle);
    void useTransition;
  }

  /**
   * Execute a `[キャラ視線変更]` command (`CharaLookCommand.DoExecute` `0x4132B3C`) from either a
   * turn snapshot or a mid-line event.
   */
  applyCommand(
    lookAt: CharacterState["lookAt"] | undefined,
    useTransition: boolean,
    resolveCharEye: (charName: string) => THREE.Object3D | null
  ): void {
    if (!lookAt) return;
    const mode = lookAt.mode || "angle";
    const val = lookAt.value;
    const dur = Number(lookAt.duration ?? 0);
    const cmdKey = `${mode}:${JSON.stringify(val)}:${dur}`;
    if (this.lastCmdKey === cmdKey) return;
    this.lastCmdKey = cmdKey;

    if (mode === "向き指定") {
      const ratio = typeof val === "number" ? val : 0;
      this.setLookAtAngle(ratio * LOOK_AT_MAX_ANGLE_DEG, useTransition);
    } else if (mode === "角度指定" || mode === "angle") {
      const deg = typeof val === "number" ? val : 0;
      this.setLookAtAngle(deg, useTransition);
    } else if (mode === "座標指定" && Array.isArray(val) && val.length >= 3) {
      // Convert Unity (x, y, z) -> Three.js (x, y, -z)
      const pt = new THREE.Vector3(Number(val[0]) || 0, Number(val[1]) || 0, -(Number(val[2]) || 0));
      this.setLookAtTarget({ kind: "point", point: pt }, useTransition, dur);
    } else if (mode === "キャラ指定" && typeof val === "string" && val) {
      const targetEye = resolveCharEye(val);
      if (targetEye) {
        this.setLookAtTarget({ kind: "object", object: targetEye }, useTransition, dur);
      } else {
        this.setLookAtTarget(null, useTransition, dur);
      }
    } else {
      this.setLookAtTarget(null, useTransition, dur);
    }
  }

  /**
   * Restore pre-look-at bone rotations before `AnimationMixer.update(dt)` runs so animations do not
   * blend against or accumulate previous frames' look-at offsets.
   */
  restore(): void {
    for (const group of [this.spineBones, this.headBones, this.eyeBones]) {
      for (const lb of group) {
        if (lb.hasSaved) {
          lb.bone.quaternion.copy(lb.savedQuat);
        }
      }
    }
  }

  /**
   * Advance target transition (`ModelHandler.Update` `0x497E500`) and apply humanoid look-at
   * (`ModelHandler.OnIKPass` `0x497E97C`) on top of the current animated pose.
   * Call after `updateStoryMotion(char, dt)` and before `char.copyFaceBones?.()`.
   */
  apply(dt: number): void {
    // Save post-mixer bone rotations so next frame's restore() returns cleanly to the animated pose
    for (const group of [this.spineBones, this.headBones, this.eyeBones]) {
      for (const lb of group) {
        lb.savedQuat.copy(lb.bone.quaternion);
        lb.hasSaved = true;
      }
    }

    // ModelHandler.Update: advance target interpolation timer
    if (this.lookAtTargetDuration > 0 && dt > 0) {
      this.elapsedTimeFromStartLook += dt;
      this.lookAtRatioForTarget = THREE.MathUtils.clamp(
        this.elapsedTimeFromStartLook / this.lookAtTargetDuration,
        0,
        1
      );
    }

    const s = SIGHT_WEIGHT_SETTINGS;
    let bodyWeight = 0;
    let headWeight = 0;
    let eyesWeight = s.eyesWeight;
    const targetWorldPos = _tmpVecC;

    if (this.target === null) {
      // Angle mode (OnIKPass when LookAtTarget == null): only eyes move
      this.calculateLookAtPositionByAngle(this.angleDeg, this.lookAtPositionByAngle);
      targetWorldPos.copy(this.lookAtPositionByAngle);
    } else {
      // Target mode (OnIKPass when LookAtTarget != null): body, head, and eyes move
      bodyWeight = s.bodyWeight;
      headWeight = s.headWeight;
      this.sampleTargetWorldPosition(this.target, this.setLookAtPosition);
      targetWorldPos.lerpVectors(
        this.lastLookAtPosition,
        this.setLookAtPosition,
        THREE.MathUtils.clamp(this.lookAtRatioForTarget, 0, 1)
      );
    }

    // Unity Animator.SetLookAtWeight: clampWeight=0.5 limits total deflection to 180° * (1 - 0.5) = 90°
    const maxAngleRad = Math.PI * (1 - s.clampWeight);

    this.rootGroup.updateMatrixWorld(true);

    if (bodyWeight > 0) {
      for (const lb of this.spineBones) {
        this.rotateBoneToward(lb, targetWorldPos, s.weight * bodyWeight * lb.share, maxAngleRad);
      }
    }
    if (headWeight > 0) {
      for (const lb of this.headBones) {
        this.rotateBoneToward(lb, targetWorldPos, s.weight * headWeight * lb.share, maxAngleRad);
      }
    }
    if (eyesWeight > 0) {
      for (const lb of this.eyeBones) {
        this.rotateBoneToward(lb, targetWorldPos, s.weight * eyesWeight * lb.share, maxAngleRad);
      }
    }
  }

  private rotateBoneToward(
    lb: LookBone,
    targetWorldPos: THREE.Vector3,
    effectiveWeight: number,
    maxAngleRad: number
  ): void {
    if (effectiveWeight <= 1e-5) return;
    lb.bone.updateWorldMatrix(true, false);

    const boneWorldPos = lb.bone.getWorldPosition(_tmpVecA);
    const desiredWorldDir = _tmpVecB.subVectors(targetWorldPos, boneWorldPos);
    const distSq = desiredWorldDir.lengthSq();
    if (distSq < 1e-8) return;
    desiredWorldDir.divideScalar(Math.sqrt(distSq));

    // Transform desired world direction into the bone's current local space
    const boneWorldQuatInv = lb.bone.getWorldQuaternion(_tmpQuatA).invert();
    const desiredLocalDir = desiredWorldDir.applyQuaternion(boneWorldQuatInv).normalize();

    const angle = lb.localForward.angleTo(desiredLocalDir);
    if (angle < 1e-5) return;

    const clampedAngle = Math.min(angle, maxAngleRad);
    const rotAngle = clampedAngle * effectiveWeight;

    const axisLocal = _tmpVecA.crossVectors(lb.localForward, desiredLocalDir);
    const axisLenSq = axisLocal.lengthSq();
    if (axisLenSq < 1e-10) return;
    axisLocal.divideScalar(Math.sqrt(axisLenSq));

    const deltaLocal = _tmpQuatB.setFromAxisAngle(axisLocal, rotAngle);
    lb.bone.quaternion.multiply(deltaLocal);
    lb.bone.updateMatrixWorld(true);
  }
}
