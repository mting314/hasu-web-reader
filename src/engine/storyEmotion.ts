import * as THREE from "three";

/**
 * The story mode's face controller, ported from the game's `Tecotec.EmotionHandler` (+
 * `EmotionDataHandler`), driven by the character's `Tecotec.EmotionData`
 * (`3d/emotions/emotion_<name>.json`, scripts/export_emotions.py).
 *
 * Three layers write the same blendshape slots directly (last write wins; values 0–100):
 *  - expression: `play()` lerps every key of the emotion linearly from the weights on screen
 *    (truncated to int, as the game reads them) over `transitionSec`, or EmotionData.TransitionTime.
 *  - blink: every BlinkInterval seconds (the timer only runs while the expression allows blinking
 *    and nothing else is transitioning) the blink keys close linearly over CloseTime, stay shut for
 *    CloseStayTime, then snap back on the first frame of the open phase (the game's own behaviour).
 *    Expressions with OverrideBlink never blink.
 *  - lip: while a voice is audible the game's lip-sync callback calls PlayABLip, which every
 *    LipInterval sets the AB mouth shape (Face_.Mouth_A) to a random entry of LipWeights
 *    ([0, 40, 70]), never the same index twice in a row, on top of the expression's mouth. 0.2 s
 *    after the last pulse (ModelConstants.SecondsToEndLipSync) the vowel keys snap back.
 *    `[キャラ口パク開始 <char> <sec>]` runs the same flap for `sec` seconds without a voice.
 * Method names follow the game's (RVAs in brackets) so the port can be checked against it.
 */

export interface BlendShapeData {
  Name: string;
  BlendShapeKeyIndex: number;
  BlendShapeValue: number;
}

export interface EmotionEntry {
  Name: string;
  OverrideBlink: number;
  OverrideLipSync: number;
  LipSyncDataName: string;
  LipABDataName: string;
  UnuseTransition: number;
  Keys: BlendShapeData[];
}

export interface EmotionData {
  AvatarName: string;
  TransitionTime: number;
  BlinkData: {
    BlinkInterval: number;
    CloseTime: number;
    CloseStayTime: number;
    OpenFadeTime: number;
    Keys: BlendShapeData[];
  } | null;
  LipSyncData: Array<{
    Name: string;
    LipVowelA: BlendShapeData;
    LipVowelI: BlendShapeData;
    LipVowelU: BlendShapeData;
    LipVowelE: BlendShapeData;
    LipVowelO: BlendShapeData;
  }>;
  LipABData: Array<{ Name: string; LipVowel: BlendShapeData; LipWeights: number[]; LipInterval: number }>;
  Emotions: EmotionEntry[];
}

/** ModelConstants.SecondsToEndLipSync */
const SECONDS_TO_END_LIP_SYNC = 0.2;

// EmotionHandler state flags
const PLAYING = 1;
const BLINK_INTERRUPTION = 2;
const LIP_SYNC_INTERRUPTION = 4;

type BlinkState = "none" | "close" | "stay" | "open";

export class StoryEmotion {
  /** blendshape name -> every (mesh, slot) carrying it (a mesh's outline twin shares its array) */
  private slots = new Map<string, Array<{ mesh: THREE.Mesh; index: number }>>();
  /** what the "renderer" holds, 0–100 (the game reads it back truncated to int) */
  private weights = new Map<string, number>();
  private emotions = new Map<string, EmotionEntry>();

  private target: EmotionEntry | null;
  private targetLipVowels: BlendShapeData[] = [];
  private state = 0;

  private baseEmotion = new Map<string, number>();
  private transitionElapsed = 0;
  private transitionOverride = -1;

  private blinkState: BlinkState = "none";
  private blinkElapsed = 0;
  private sinceLastBlink = 0;
  private baseBlink = new Map<string, number>();

  private lipPlaying = false;
  private sinceLastLip = 0;
  private sinceForceABLip = 0;
  private forceABLipDuration = 0;
  private overrideABLipInterval = 0;
  private elapsedABLip = 0.125;
  private lastABLipIndex = 0;
  private baseLip = new Map<string, number>();

  constructor(root: THREE.Object3D, private data: EmotionData) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      if (mesh.userData.toonOutlineOf) return; // shares its influences with the lit mesh
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
        const list = this.slots.get(name) ?? [];
        list.push({ mesh, index });
        this.slots.set(name, list);
        this.weights.set(name, (mesh.morphTargetInfluences[index] ?? 0) * 100);
      }
    });
    for (const e of data.Emotions) this.emotions.set(e.Name, e);
    // SetData: the first emotion is the target, no weights applied
    this.target = data.Emotions[0] ?? null;
  }

  /** EmotionDataHandler.SetBlendShapeWeight: by name, no clamping */
  private set(key: BlendShapeData, w: number) {
    this.weights.set(key.Name, w);
    for (const { mesh, index } of this.slots.get(key.Name) ?? []) mesh.morphTargetInfluences![index] = w / 100;
  }

  /** GetCurrentBlendShapeWeights: (int)GetBlendShapeWeight */
  private current(key: BlendShapeData) {
    return Math.trunc(this.weights.get(key.Name) ?? 0);
  }

  /** IsKeysValid: every key exists on a mesh */
  private valid(keys: BlendShapeData[]) {
    return keys.length > 0 && keys.every((k) => this.slots.has(k.Name));
  }

  /**
   * PlayEmotion [0x4978F48], as `[キャラ表情変更 <char> <name> [sec]]` calls it: `useTransition` is
   * false when the line is skipped/jumped to, `transitionSec` = the command's seconds (-1 = default).
   */
  play(name: string, useTransition = true, transitionSec = -1) {
    // SetEmotion [0x4977E28]
    const emotion = this.emotions.get(name);
    if (!emotion || !this.valid(emotion.Keys)) return;
    this.target = emotion;
    const lip = this.data.LipSyncData.find((l) => l.Name === emotion.LipSyncDataName);
    if (!lip) return;
    this.targetLipVowels = [lip.LipVowelA, lip.LipVowelI, lip.LipVowelU, lip.LipVowelE, lip.LipVowelO];

    this.baseEmotion.clear();
    for (const k of emotion.Keys) this.baseEmotion.set(k.Name, this.current(k));
    this.transitionOverride = transitionSec;
    this.state = (this.state & ~(PLAYING | BLINK_INTERRUPTION)) | PLAYING;
    if (transitionSec === 0 || !useTransition || emotion.UnuseTransition) {
      this.transitionOverride = -1;
      this.transitionElapsed = Infinity; // ratio 1: the target applies at once
      this.transitionEmotions(0);
    }
  }

  /** TransitionEmotions [0x49790C4]: linear, per key, from the captured weights */
  private transitionEmotions(dt: number) {
    const target = this.target;
    if (!target) return;
    const dur = this.transitionOverride >= 0 ? this.transitionOverride : this.data.TransitionTime;
    this.transitionElapsed += dt;
    const ratio = dur > 0 ? this.transitionElapsed / dur : 1;
    const r = Math.min(Math.max(ratio, 0), 1);
    for (const k of target.Keys) {
      const from = this.baseEmotion.get(k.Name) ?? 0;
      this.set(k, from + (k.BlendShapeValue - from) * r);
    }
    if (ratio >= 1) {
      // TerminateEmotionsTransition [0x49799D0]
      this.transitionElapsed = 0;
      this.state &= ~PLAYING;
      this.transitionOverride = -1;
      this.baseEmotion.clear();
    }
  }

  private blinkPlayable() {
    return !!this.data.BlinkData && !!this.target && !this.target.OverrideBlink;
  }

  /** TerminateBlinkTransition [0x4979C30]: the eyelids are not restored */
  private terminateBlink() {
    this.blinkState = "none";
    this.blinkElapsed = 0;
    this.state &= ~BLINK_INTERRUPTION;
    this.baseBlink.clear();
  }

  /** TransitionBlink [0x4979A38] */
  private transitionBlink(dt: number) {
    const bd = this.data.BlinkData;
    if (!bd || this.blinkState === "none") {
      this.terminateBlink();
      return;
    }
    const dur = this.blinkState === "close" ? bd.CloseTime : this.blinkState === "stay" ? bd.CloseStayTime : bd.OpenFadeTime;
    this.blinkElapsed += dt;
    const ratio = dur > 0 ? this.blinkElapsed / dur : 1;
    if (this.blinkState !== "stay") {
      const r = Math.min(Math.max(ratio, 0), 1);
      for (const k of bd.Keys) {
        const from = this.baseBlink.get(k.Name) ?? 0;
        // open: from == to, so the first open frame snaps back to the pre-blink value
        const to = this.blinkState === "close" ? k.BlendShapeValue : from;
        this.set(k, from + (to - from) * r);
      }
    }
    if (ratio >= 1) {
      if (this.blinkState === "open") this.terminateBlink();
      else {
        this.blinkState = this.blinkState === "close" ? "stay" : "open";
        this.blinkElapsed = 0;
      }
    }
  }

  private lipPlayable() {
    return !!this.target && !this.target.OverrideLipSync && this.data.LipSyncData.length > 0 && this.targetLipVowels.length > 0;
  }

  /**
   * PlayABLip(0, …) [0x4979638] as the voice lip-sync callback calls it, every update while the
   * analysed voice is non-silent (the vowel ratios only gate it).
   */
  voiceActive() {
    this.playABLip(0, 0);
  }

  /**
   * PlayABLip [0x4979638]. `[キャラ口パク開始 <char> <sec>]` (CharaLipCommand) calls it with
   * force = sec and interval = 0.125 (its DEFAULT_LIP_INTERVAL): the mouth flaps for `sec` seconds
   * without a voice. With force 0 (the voice path) the interval isn't stored.
   */
  playABLip(force: number, interval: number) {
    if (!this.lipPlayable()) return;
    if (force > 0) {
      this.sinceForceABLip = 0;
      this.forceABLipDuration = force;
      this.overrideABLipInterval = interval;
    }
    this.doPlayABLip();
  }

  /** CloseABLip [0x4979870]: stop a forced flap now (the command skipped past its end) */
  closeABLip() {
    this.sinceLastLip = 0;
    this.forceABLipDuration = 0;
    this.overrideABLipInterval = 0;
    this.sinceForceABLip = 0;
    this.terminateLip();
  }

  /** DoPlayABLip [0x4979690] */
  private doPlayABLip() {
    const target = this.target!;
    const ab = this.data.LipABData.find((l) => l.Name === target.LipABDataName);
    if (!ab || ab.LipWeights.length === 0) return;
    const interval = this.overrideABLipInterval > 0 ? this.overrideABLipInterval : ab.LipInterval;
    if (this.elapsedABLip < interval) return;
    this.elapsedABLip = 0;
    if (!this.valid(this.targetLipVowels)) return;
    if (!(this.state & LIP_SYNC_INTERRUPTION)) {
      for (const k of this.targetLipVowels) this.baseLip.set(k.Name, this.current(k));
    }
    let idx = this.lastABLipIndex;
    if (ab.LipWeights.length > 1) {
      while (idx === this.lastABLipIndex) idx = Math.floor(Math.random() * ab.LipWeights.length);
    }
    this.lastABLipIndex = idx;
    this.set(ab.LipVowel, ab.LipWeights[idx]);
    this.lipPlaying = true;
    this.sinceLastLip = 0;
    this.state |= LIP_SYNC_INTERRUPTION;
  }

  /** TerminateLipSyncTransition [0x4979880]: the vowel keys snap back to what was captured */
  private terminateLip() {
    for (const k of this.targetLipVowels) {
      const w = this.baseLip.get(k.Name);
      if (w !== undefined) this.set(k, w);
    }
    this.baseLip.clear();
    this.lipPlaying = false;
    this.state &= ~LIP_SYNC_INTERRUPTION;
  }

  /** ManagedUpdate [0x4979D88], once per frame after the motion update */
  update(dt: number) {
    this.elapsedABLip += dt;
    if (this.state & PLAYING) {
      if (this.target) this.transitionEmotions(dt);
      this.terminateBlink();
    } else if (!this.blinkPlayable()) {
      this.terminateBlink();
    } else {
      const bd = this.data.BlinkData!;
      if (!(this.state & BLINK_INTERRUPTION)) this.sinceLastBlink += dt;
      if (this.sinceLastBlink >= bd.BlinkInterval) {
        this.sinceLastBlink = 0;
        this.state |= BLINK_INTERRUPTION;
        this.blinkState = "close";
        this.baseBlink.clear();
        for (const k of bd.Keys) this.baseBlink.set(k.Name, this.current(k));
        this.transitionBlink(dt);
      } else if (this.state & BLINK_INTERRUPTION) {
        this.transitionBlink(dt);
      }
    }
    if (this.lipPlaying) {
      this.sinceLastLip += dt;
      this.sinceForceABLip += dt;
    }
    if (this.sinceForceABLip < this.forceABLipDuration) this.doPlayABLip();
    if (this.sinceLastLip >= SECONDS_TO_END_LIP_SYNC) {
      this.sinceLastLip = 0;
      this.forceABLipDuration = 0;
      this.overrideABLipInterval = 0;
      this.sinceForceABLip = 0;
      this.terminateLip();
    }
  }
}
