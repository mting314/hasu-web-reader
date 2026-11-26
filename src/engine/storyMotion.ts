import * as THREE from "three";

/**
 * Story motions, played the way the game's AnimatorController plays them.
 *
 * Every motion bundle (`mot_00_NNNNN`) carries its own controller, and all 144 that episode 1 uses
 * have the same base layer:
 *   in (@i) -> action (@a) -> loop (@l, repeats) -> out (@o, on an "out" trigger)
 * Each transition is 0 s long and fires when its clip ends (exit time 1). The clips are authored
 * to join frame to frame, so one clip plays at a time and the next picks up the leftover time.
 * Many @l clips are only the held end pose, so playing @l alone would skip the gesture itself.
 *
 * Switching to another motion isn't in the data (each motion has its own controller; the game's
 * code swaps them). We do what a Unity transition does when it starts mid-animation: freeze the
 * pose on screen and blend from it into the new motion's first clip. The mixer only ever plays
 * one clip per character, so there are no competing weights to keep in balance.
 *
 * Not reproduced: the controller's other layers (an additive `m_breathing@l` at weight 0.5 and
 * hand-grip poses at weight 0) and the `out` state (no story command fires it).
 */

/** How long a new motion blends in from the frozen pose. Not in the data; the original reader's value. */
export const MOTION_SWITCH_BLEND_SEC = 0.28;

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

interface PlaybackState {
  /** in/action/loop actions of the current motion (only the current one is playing) */
  steps: THREE.AnimationAction[];
  index: number;
  /** Time into the current step. Kept here because a finished LoopOnce action clamps its own
   * time at the clip's end, losing the leftover that the next step must start from. */
  stepTime: number;
  clock: number;
  blend: FrozenPose | null;
}

export interface MotionHost {
  mixer: THREE.AnimationMixer;
  storyMotion?: PlaybackState;
}

export interface StoryMotionClips {
  /** @i and @a, whichever exist, in playback order */
  intro: THREE.AnimationClip[];
  loop: THREE.AnimationClip | null;
}

const LAYER_CLIP = /^m_(breathing|left_gripsize_\d|right_gripsize_\d)@/;

export function pickStoryMotionClips(clips: THREE.AnimationClip[], motionId: string): StoryMotionClips {
  const base = motionId.replace(/^mot_/, "m_");
  const byName = (name: string) => clips.find((c) => c.name === name);
  const loop =
    byName(base + "@l") ??
    clips.find((c) => c.name.endsWith("@l") && !LAYER_CLIP.test(c.name)) ??
    clips[0] ??
    null;
  // Intro clips share the loop's stem, which can carry a variant (`m_00_00040@r@l` -> `@r@i`).
  const stem = loop?.name.endsWith("@l") ? loop.name.slice(0, -2) : null;
  const intro = stem
    ? [byName(stem + "@i"), byName(stem + "@a")].filter((c): c is THREE.AnimationClip => c !== undefined)
    : [];
  return { intro, loop };
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

/**
 * Start a story motion on a character.
 * `playIntro`: play @i and @a before looping @l. Pass false when resuming a motion that started
 * on an earlier line (jumps, scene restores) or for `キャラモーション即時再生`.
 * Pass the same clip objects for the same motion each time, so the mixer reuses its actions.
 */
export function playStoryMotion(
  host: MotionHost,
  clips: THREE.AnimationClip[],
  motionId: string,
  playIntro: boolean
): void {
  const { intro, loop } = pickStoryMotionClips(clips, motionId);
  if (!loop) return;
  const state = (host.storyMotion ??= { steps: [], index: 0, stepTime: 0, clock: 0, blend: null });
  const toPlay = playIntro ? [...intro, loop] : [loop];
  const root = host.mixer.getRoot() as THREE.Object3D;
  // Blend from whatever is on screen, unless nothing was playing yet (a character just appeared).
  // Freeze first (it's the pose on screen), then hand the scene back to the mixer's own output.
  const frozen = state.steps.length ? freezePose(root, toPlay, state.clock, MOTION_SWITCH_BLEND_SEC) : null;
  if (state.blend) unblend(state.blend);
  state.blend = frozen;

  const previous = state.steps;
  state.steps = toPlay.map((clip) => host.mixer.clipAction(clip));
  state.index = 0;
  state.stepTime = 0;
  // Start the new clip before stopping the old ones: they share bindings, and a binding nobody
  // uses snaps back to the rest pose, which a second switch in the same frame would then freeze.
  startStep(state.steps[0], state.steps.length === 1);
  for (const action of previous) if (action !== state.steps[0]) action.stop();
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

  // 0 s transitions at the end of each clip, carrying the leftover time into the next one.
  if (state.steps.length) {
    state.stepTime += dt;
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
