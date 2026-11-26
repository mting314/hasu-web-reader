import * as THREE from "three";

/**
 * Story motions, played the way the game plays them (CLAUDE.md, "Story motions", read from the
 * game's code: Tecotec.CharaMotionCommand, Tecotec.MotionHandler).
 *
 * Every motion bundle (`mot_00_NNNNN`) carries its own controller, and all 144 that episode 1 uses
 * have the same base layer:
 *   in (@i) -> action (@a) -> loop (@l, repeats) -> out (@o, on an "out" trigger)
 * Each transition is 0 s long and fires when its clip ends (exit time 1). The clips are authored
 * to join frame to frame, so one clip plays at a time and the next picks up the leftover time.
 *
 * `[キャラモーション再生 <char> <mot> <playType> [breathing]]`:
 *  - playType picks the state the motion starts in: 0 in, 1 loop, 2 action. Scripts nearly always
 *    pass 2, so story motions start at @a.
 *  - The game crossfades into the new motion over 0.5 s. We blend from the pose on screen, frozen
 *    at the switch (the game keeps the old motion playing during those 0.5 s; for the mostly
 *    still held poses the difference is small, and freezing keeps interruptions safe). Only one
 *    clip plays on the base layer, so there are no competing weights to keep in balance.
 *  - With playType 0 the old motion first plays its @o until 0.5 s before its end, then the new
 *    one blends in. That's the only time @o plays.
 *  - The 4th argument is the weight of the additive breathing layer (`m_breathing@l`); 0.2 when
 *    it's omitted.
 * `[キャラモーション即時再生 <char> <mot> <playType> <t>]`: jump to normalized time t within the
 * start state, with no blend.
 *
 * Not reproduced: the hand-grip layers (weight 0 in every controller).
 */

/** The game's crossfade between story motions (ModelHandler.Play transitionDuration). */
export const MOTION_SWITCH_BLEND_SEC = 0.5;
/** Breathing-layer weight when the command doesn't give one (CharaMotionCommand). */
export const DEFAULT_BREATHING_WEIGHT = 0.2;

export type MotionStartState = "in" | "action" | "loop";

/** MotionHandler.MotionPlayType -> the state the motion starts in. */
export const playTypeToState = (playType?: number | null): MotionStartState =>
  playType === 0 ? "in" : playType === 1 ? "loop" : "action";

export interface StoryMotionStart {
  state: MotionStartState;
  /** blend in from the pose on screen; false = cut straight in (即時再生, a character appearing) */
  blend: boolean;
  /** 即時再生: normalized time within the start state to jump to */
  normalizedTime?: number;
  /** weight of the additive breathing layer */
  breathing?: number;
}

interface FrozenPose {
  nodes: THREE.Object3D[];
  quaternions: (THREE.Quaternion | null)[];
  positions: (THREE.Vector3 | null)[];
  /** What the mixer last applied, before we blended over it (null until the first blended frame) */
  liveQuaternions: (THREE.Quaternion | null)[] | null;
  livePositions: (THREE.Vector3 | null)[] | null;
  start: number;
  duration: number;
}

interface PendingMotion {
  clips: THREE.AnimationClip[];
  motionId: string;
  start: StoryMotionStart;
  /** start it once the @o step reaches this time */
  atStepTime: number;
}

interface PlaybackState {
  /** in/action/loop actions of the current motion (only the current one is playing) */
  steps: THREE.AnimationAction[];
  index: number;
  /** Time into the current step. Kept here because a finished LoopOnce action clamps its own
   * time at the clip's end, losing the leftover that the next step must start from. */
  stepTime: number;
  clock: number;
  blend: FrozenPose | null;
  /** the current motion's @o clip, for a following playType 0 command */
  outClip: THREE.AnimationClip | null;
  /** a playType 0 motion waiting for the current @o to play out */
  pending: PendingMotion | null;
  breathing: THREE.AnimationAction | null;
}

export interface MotionHost {
  mixer: THREE.AnimationMixer;
  storyMotion?: PlaybackState;
}

export interface StoryMotionClips {
  in: THREE.AnimationClip | null;
  action: THREE.AnimationClip | null;
  loop: THREE.AnimationClip | null;
  out: THREE.AnimationClip | null;
  breathing: THREE.AnimationClip | null;
}

const LAYER_CLIP = /^m_(breathing|left_gripsize_\d|right_gripsize_\d)@/;

export function pickStoryMotionClips(clips: THREE.AnimationClip[], motionId: string): StoryMotionClips {
  const base = motionId.replace(/^mot_/, "m_");
  const byName = (name: string) => clips.find((c) => c.name === name) ?? null;
  const loop =
    byName(base + "@l") ??
    clips.find((c) => c.name.endsWith("@l") && !LAYER_CLIP.test(c.name)) ??
    clips[0] ??
    null;
  // The other clips share the loop's stem, which can carry a variant (`m_00_00040@r@l` -> `@r@i`).
  const stem = loop?.name.endsWith("@l") ? loop.name.slice(0, -2) : null;
  return {
    in: stem ? byName(stem + "@i") : null,
    action: stem ? byName(stem + "@a") : null,
    loop,
    out: stem ? byName(stem + "@o") : null,
    breathing: byName("m_breathing@l"),
  };
}

/** The clips a story motion can use, e.g. to retarget only those. */
export function storyMotionClipList(clips: THREE.AnimationClip[], motionId: string): THREE.AnimationClip[] {
  const c = pickStoryMotionClips(clips, motionId);
  return [c.in, c.action, c.loop, c.out, c.breathing].filter((x): x is THREE.AnimationClip => x !== null);
}

/** Nodes by name under a model root, built once per root. */
const nodesByRoot = new WeakMap<THREE.Object3D, Map<string, THREE.Object3D>>();
function nodeNamed(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  let byName = nodesByRoot.get(root);
  if (!byName) {
    const map = new Map<string, THREE.Object3D>();
    root.traverse((o) => {
      if (o.name && !map.has(o.name)) map.set(o.name, o);
    });
    nodesByRoot.set(root, (byName = map));
  }
  return byName.get(name);
}

/** Capture the current local pose of every node the clips animate. */
function freezePose(root: THREE.Object3D, clips: THREE.AnimationClip[], start: number, duration: number): FrozenPose {
  const props = new Map<THREE.Object3D, { q: boolean; p: boolean }>();
  const seen = new Set<string>();
  for (const clip of clips) {
    for (const track of clip.tracks) {
      if (seen.has(track.name)) continue;
      seen.add(track.name);
      const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
      const node = nodeName ? nodeNamed(root, nodeName) : undefined;
      if (!node) continue;
      const entry = props.get(node) ?? { q: false, p: false };
      if (propertyName === "quaternion") entry.q = true;
      else if (propertyName === "position") entry.p = true;
      props.set(node, entry);
    }
  }
  const pose: FrozenPose = {
    nodes: [], quaternions: [], positions: [], liveQuaternions: null, livePositions: null, start, duration,
  };
  for (const [node, { q, p }] of props) {
    pose.nodes.push(node);
    pose.quaternions.push(q ? node.quaternion.clone() : null);
    pose.positions.push(p ? node.position.clone() : null);
  }
  return pose;
}

/**
 * Put back what the mixer last applied. The mixer only writes a property when its animated value
 * changes (a held pose stops being written after one frame), so the scene must hold the mixer's
 * own output before each update, or a blended value would stick.
 */
function unblend(pose: FrozenPose): void {
  if (!pose.liveQuaternions || !pose.livePositions) return;
  for (let i = 0; i < pose.nodes.length; i++) {
    const q = pose.liveQuaternions[i];
    const p = pose.livePositions[i];
    if (q) pose.nodes[i].quaternion.copy(q);
    if (p) pose.nodes[i].position.copy(p);
  }
}

function startStep(action: THREE.AnimationAction, isLoop: boolean, time = 0): void {
  action.reset();
  action.setLoop(isLoop ? THREE.LoopRepeat : THREE.LoopOnce, isLoop ? Infinity : 1);
  action.clampWhenFinished = !isLoop;
  action.setEffectiveWeight(1);
  action.play();
  action.time = time;
}

/** Additive copies of breathing clips (relative to their first frame, as Unity's additive layers). */
const additiveClips = new WeakMap<THREE.AnimationClip, THREE.AnimationClip>();
function additive(clip: THREE.AnimationClip): THREE.AnimationClip {
  let a = additiveClips.get(clip);
  if (!a) {
    a = THREE.AnimationUtils.makeClipAdditive(clip.clone());
    additiveClips.set(clip, a);
  }
  return a;
}

function setBreathing(host: MotionHost, state: PlaybackState, clip: THREE.AnimationClip | null, weight: number) {
  const prev = state.breathing;
  if (!clip || weight <= 0) {
    prev?.stop();
    state.breathing = null;
    return;
  }
  const action = host.mixer.clipAction(additive(clip));
  if (action !== prev) {
    action.reset();
    action.blendMode = THREE.AdditiveAnimationBlendMode;
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    // keep the breathing phase across motions (every motion carries the same breathing clip)
    if (prev) action.time = prev.time % action.getClip().duration;
    prev?.stop();
    state.breathing = action;
  }
  action.setEffectiveWeight(weight);
}

/**
 * Start a story motion on a character. Pass the same clip objects for the same motion each time,
 * so the mixer reuses its actions.
 */
export function playStoryMotion(
  host: MotionHost,
  clips: THREE.AnimationClip[],
  motionId: string,
  start: StoryMotionStart
): void {
  const c = pickStoryMotionClips(clips, motionId);
  if (!c.loop) return;
  const state = (host.storyMotion ??= {
    steps: [], index: 0, stepTime: 0, clock: 0, blend: null, outClip: null, pending: null, breathing: null,
  });
  const root = host.mixer.getRoot() as THREE.Object3D;
  state.pending = null;

  // playType 0 after a motion with an @o: play that out first (MotionHandler.Blend).
  if (start.state === "in" && start.blend && state.outClip && state.steps.length) {
    const outClip = state.outClip;
    const outAction = host.mixer.clipAction(outClip);
    const previous = state.steps;
    state.steps = [outAction];
    state.index = 0;
    state.stepTime = 0;
    startStep(outAction, false);
    for (const action of previous) if (action !== outAction) action.stop();
    state.outClip = null;
    state.pending = {
      clips,
      motionId,
      start,
      atStepTime: Math.max(0, outClip.duration - MOTION_SWITCH_BLEND_SEC),
    };
    return;
  }

  const chain =
    start.state === "in" ? [c.in, c.action, c.loop] : start.state === "action" ? [c.action, c.loop] : [c.loop];
  const toPlay = chain.filter((x): x is THREE.AnimationClip => x !== null);
  const firstLength = toPlay[0].duration;
  const startTime = start.normalizedTime !== undefined ? Math.min(1, Math.max(0, start.normalizedTime)) * firstLength : 0;

  // Blend from whatever is on screen, unless nothing was playing yet (the game cuts straight in
  // then) or the command cuts in (即時再生). Freeze first (it's the pose on screen), then hand the
  // scene back to the mixer's own output.
  const frozen =
    start.blend && state.steps.length ? freezePose(root, toPlay, state.clock, MOTION_SWITCH_BLEND_SEC) : null;
  if (state.blend) unblend(state.blend);
  state.blend = frozen;

  const previous = state.steps;
  state.steps = toPlay.map((clip) => host.mixer.clipAction(clip));
  state.index = 0;
  state.stepTime = startTime;
  // Start the new clip before stopping the old ones: they share bindings, and a binding nobody
  // uses snaps back to the rest pose, which a second switch in the same frame would then freeze.
  startStep(state.steps[0], state.steps.length === 1, startTime);
  for (const action of previous) if (action !== state.steps[0]) action.stop();
  state.outClip = c.out;
  setBreathing(host, state, c.breathing, start.breathing ?? DEFAULT_BREATHING_WEIGHT);
}

/**
 * Advance a character's animation by `dt` seconds; call it every frame instead of
 * `mixer.update(dt)`. Steps through in -> action -> loop and applies the switch blend.
 */
export function updateStoryMotion(host: MotionHost, dt: number): void {
  const state = host.storyMotion;
  if (state?.blend) unblend(state.blend);
  host.mixer.update(dt);
  if (!state) return;
  state.clock += dt;

  if (state.steps.length) {
    state.stepTime += dt;
    // A playType 0 motion waiting for @o: start it 0.5 s before @o ends.
    const pending = state.pending;
    if (pending && state.stepTime >= pending.atStepTime) {
      state.pending = null;
      playStoryMotion(host, pending.clips, pending.motionId, { ...pending.start, state: "in" });
      // playStoryMotion skips the @o path now (outClip was cleared); pose this frame from it
      host.mixer.update(0);
    } else {
      // 0 s transitions at the end of each clip, carrying the leftover time into the next one.
      let switched = false;
      while (state.index < state.steps.length - 1) {
        const current = state.steps[state.index];
        const duration = current.getClip().duration;
        if (state.stepTime < duration) break;
        state.stepTime -= duration;
        state.index += 1;
        const next = state.steps[state.index];
        startStep(next, state.index === state.steps.length - 1, state.stepTime);
        current.stop();
        switched = true;
      }
      if (switched) host.mixer.update(0); // pose this frame from the clip we switched to
    }
  }

  // Blend from the frozen pose into what the mixer just applied (kept, to undo next frame).
  const blend = state.blend;
  if (blend) {
    const t = blend.duration > 0 ? (state.clock - blend.start) / blend.duration : 1;
    if (t >= 1) {
      state.blend = null; // the scene already holds the mixer's output
    } else {
      blend.liveQuaternions ??= blend.quaternions.map((q) => (q ? new THREE.Quaternion() : null));
      blend.livePositions ??= blend.positions.map((p) => (p ? new THREE.Vector3() : null));
      for (let i = 0; i < blend.nodes.length; i++) {
        const node = blend.nodes[i];
        const q = blend.quaternions[i];
        const p = blend.positions[i];
        const liveQ = blend.liveQuaternions[i];
        const liveP = blend.livePositions[i];
        if (q && liveQ) node.quaternion.slerpQuaternions(q, liveQ.copy(node.quaternion), t);
        if (p && liveP) node.position.lerpVectors(p, liveP.copy(node.position), t);
      }
    }
  }
}
