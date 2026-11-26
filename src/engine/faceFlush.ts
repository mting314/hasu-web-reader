import * as THREE from "three";

/**
 * Cheek blush, ported from the game's `SchoolTears.FlushingController` (added at runtime by
 * `Tecotec.EmotionHandler`; RVAs 0x451B498–0x451BA98) as `[顔紅潮操作 <char> [level] [fadeSec]]`
 * (`Tecotec.FaceFlushingCommand`) drives it.
 *
 * It animates the alpha of `_SecondaryColor` on the face material (the face renderer material with
 * `_EnableSecondaryTex` > 0; its `_SecondaryTex` is the `face_cheek_cry` blush texture), linearly,
 * from the alpha on screen to the level over the fade time (clamped to 0.1–10 s), always with RGB
 * white. The value is kept in the materials' `userData.secondaryColorAlpha` and, where a material
 * has a `_SecondaryColor` uniform, there too.
 *
 * Note: the game's shipped UberToonShader programs (iOS bundle) never read `_SecondaryTex` or
 * `_SecondaryColor`, so the game animates a value its own compiled shader ignores; the converted
 * programs here behave the same (no uniform, nothing drawn).
 */
export class FaceFlush {
  private materials: THREE.Material[] = [];
  // constructor defaults of FlushingController
  private maxAlpha = 1;
  private fadeTime = 1;
  private startAlpha = 0;
  private lerpValue = 0;
  private flushing = false;
  /** `_SecondaryColor.a` on the face material */
  alpha = 0;

  constructor(root: THREE.Object3D) {
    // FindFaceMaterial: the face renderers' material with _EnableSecondaryTex > 0
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const unity = mesh.material?.userData?.unity;
      if (unity && (unity.floats?._EnableSecondaryTex ?? 0) > 0) {
        this.materials.push(mesh.material);
        this.alpha = unity.colors?._SecondaryColor?.[3] ?? 0;
      }
    });
  }

  private write(a: number) {
    this.alpha = a;
    for (const m of this.materials) {
      m.userData.secondaryColorAlpha = a;
      const u = (m as THREE.ShaderMaterial).uniforms?._SecondaryColor;
      if (u) (u.value as THREE.Vector4).set(1, 1, 1, a);
    }
  }

  /** EmotionHandler.SetFlushPlay(level, fade) -> FlushingController.StartFlushing */
  play(level: number, fadeSec: number) {
    const on = level !== 0 || fadeSec !== 0;
    this.maxAlpha = on ? level : 0;
    this.fadeTime = on && fadeSec >= 0.1 ? Math.min(fadeSec, 10) : 0.1;
    this.startAlpha = this.alpha; // fades start from what is on screen
    this.flushing = true; // lerpValue is not reset (the game's own behaviour)
  }

  /** A line's snapshot (jumping to it): the level as it stands, no fade. */
  set(level: number) {
    this.flushing = false;
    this.lerpValue = 0;
    this.write(level);
  }

  /** Tick, every frame while fading */
  update(dt: number) {
    if (!this.flushing) return;
    this.lerpValue += dt / this.fadeTime;
    const r = Math.min(Math.max(this.lerpValue, 0), 1);
    this.write(this.startAlpha + (this.maxAlpha - this.startAlpha) * r);
    if (this.lerpValue >= 1) {
      this.flushing = false;
      this.lerpValue = 0;
    }
  }
}
