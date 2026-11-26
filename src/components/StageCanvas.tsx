import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  createUberToonMaterial,
  ExpressionController,
  ExpressionPreset,
  restHipsHeight,
  retargetMotionClips,
  ToonMaterialParams,
} from "../engine/UberToonMaterial";
import { AudioMixer } from "../engine/AudioMixer";
import { MotionHost, pickStoryMotionClips, playStoryMotion, updateStoryMotion } from "../engine/storyMotion";
import {
  AssetManifest,
  CharacterState,
  DialogueTurn,
  ManifestCharacterAsset,
  ManifestPropAsset,
  PrefetchMode,
  PropState,
  ScenarioData,
  StageResolution,
  StageSnapshot,
} from "../types/scenario";

interface StageCanvasProps {
  turn: DialogueTurn;
  cameraMode: "adv" | "orbit";
  enable3D: boolean;
  resolution?: StageResolution;
  audioMixer: AudioMixer;
  onAdvance: () => void;
}

interface LoadedCharacter extends MotionHost {
  name: string;
  costumeId: string;
  rootGroup: THREE.Group;
  modelScene: THREE.Object3D;
  expressionCtrl: ExpressionController;
  expressions: Map<string, ExpressionPreset>;
  /** Start key (`motionCmd`) of the motion last requested, and of the one actually playing */
  requestedMotion: string | null;
  appliedMotion: string | null;
  currentEmotion: string | null;
  /** Motion clips retargeted to this character, per motion id (reused so actions are too). */
  motionClips: Map<string, Promise<THREE.AnimationClip[]>>;
}

interface LoadedProp {
  alias: string;
  id: string;
  group: THREE.Group;
}

const gltfCache = new Map<string, Promise<any>>();
const textureCache = new Map<string, THREE.Texture>();
const texturePromiseCache = new Map<string, Promise<THREE.Texture>>();
const expressionJsonCache = new Map<string, Promise<ExpressionPreset[]>>();
const toonParamsCache = new Map<string, Promise<Record<string, ToonMaterialParams>>>();
const audioWarmCache = new Map<string, Promise<void>>();
const warmedAssetKeys = new Set<string>();

const sharedGltfLoader = new GLTFLoader();
const sharedTexLoader = new THREE.TextureLoader();

/** Game material values for a costume GLB (`<name>_materials.json` beside it); empty if absent. */
function loadToonParamsCached(glbUrl: string): Promise<Record<string, ToonMaterialParams>> {
  const url = glbUrl.replace(/\.glb$/, "_materials.json");
  let p = toonParamsCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.json() : { materials: {} }))
      .then((d) => d.materials || {})
      .catch(() => ({}));
    toonParamsCache.set(url, p);
  }
  return p;
}

function loadGltfCached(loader: GLTFLoader, url: string): Promise<any> {
  let p = gltfCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });
    // Avoid caching permanent rejections if a transient network glitch occurs
    p.catch(() => {
      gltfCache.delete(url);
    });
    gltfCache.set(url, p);
    // Forget failed loads so a later request can retry (callers still see the rejection).
    p.catch(() => gltfCache.delete(url));
  }
  return p;
}

function loadTextureCached(
  loader: THREE.TextureLoader,
  url: string,
  flipY = false
): THREE.Texture {
  const key = `${url}::${flipY}`;
  let tex = textureCache.get(key);
  if (!tex) {
    let resolvePromise!: (t: THREE.Texture) => void;
    const p = new Promise<THREE.Texture>((resolve) => {
      resolvePromise = resolve;
    });
    tex = loader.load(
      url,
      (loaded) => resolvePromise(loaded),
      undefined,
      () => resolvePromise(tex!)
    );
    tex.flipY = flipY;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    textureCache.set(key, tex);
    texturePromiseCache.set(key, p);
  }
  return tex;
}

function prewarmTextureAsync(url: string, flipY = false): Promise<THREE.Texture> {
  const key = `${url}::${flipY}`;
  loadTextureCached(sharedTexLoader, url, flipY);
  return texturePromiseCache.get(key) ?? Promise.resolve(textureCache.get(key)!);
}

function loadExpressionsCached(url: string): Promise<ExpressionPreset[]> {
  let p = expressionJsonCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.json() : { expressions: [] }))
      .then((d) => d.expressions || [])
      .catch(() => []);
    expressionJsonCache.set(url, p);
  }
  return p;
}

function prewarmAudioAsync(url: string): Promise<void> {
  let p = audioWarmCache.get(url);
  if (!p) {
    p = fetch(url, { cache: "force-cache" })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then(() => {})
      .catch(() => {
        audioWarmCache.delete(url);
      });
    audioWarmCache.set(url, p);
  }
  return p;
}

export async function prewarmCharacterAsset(c: ManifestCharacterAsset): Promise<void> {
  await Promise.all([
    loadGltfCached(sharedGltfLoader, c.glbUrl).catch(() => null),
    c.expressionsUrl ? loadExpressionsCached(c.expressionsUrl) : Promise.resolve(),
    loadToonParamsCached(c.glbUrl),
    c.eyeHighlightUrl ? prewarmTextureAsync(c.eyeHighlightUrl, false) : Promise.resolve(),
  ]);
}

export async function prewarmPropAsset(p: ManifestPropAsset): Promise<void> {
  await Promise.all([
    ...p.glbUrls.map((u) => loadGltfCached(sharedGltfLoader, u).catch(() => null)),
    ...p.textureUrls.map((u) => prewarmTextureAsync(u, false)),
  ]);
}

export function prewarmEpisodeCast(
  characters?: ManifestCharacterAsset[],
  initialBackgroundUrl?: string | null
): void {
  if (initialBackgroundUrl) {
    void prewarmTextureAsync(initialBackgroundUrl, true);
  }
  for (const c of characters ?? []) {
    void prewarmCharacterAsset(c);
  }
}

export interface PreloadProgress {
  loaded: number;
  total: number;
  tier: "idle" | "backbone" | "lookahead" | "episode" | "done";
}

interface PreloadTask {
  key: string;
  tier: "backbone" | "lookahead" | "episode";
  yieldMs?: number;
  run: () => Promise<void>;
}

/**
 * Order manifest entries relative to `anchorTurnIndex` without scanning `turns[]`:
 * upcoming items (`firstTurnIndex >= anchorTurnIndex`) in ascending order first,
 * followed by earlier items (`firstTurnIndex < anchorTurnIndex`) for backward scrubbing.
 */
function orderFromTurn<T extends { firstTurnIndex: number }>(
  items: T[],
  anchorTurnIndex: number
): T[] {
  const ahead: T[] = [];
  const behind: T[] = [];
  for (const item of items) {
    if (item.firstTurnIndex >= anchorTurnIndex) {
      ahead.push(item);
    } else {
      behind.push(item);
    }
  }
  ahead.sort((a, b) => a.firstTurnIndex - b.firstTurnIndex);
  behind.sort((a, b) => b.firstTurnIndex - a.firstTurnIndex);
  return [...ahead, ...behind];
}

/**
 * Build & run a tiered priority preloader from compile-time `scenario.assetManifest`.
 * Returns a cancellation function that aborts queued tasks when the user jumps lines or switches episodes.
 */
export function startTieredEpisodePreloader(
  scenario: ScenarioData,
  anchorTurnIndex: number,
  mode: PrefetchMode,
  enable3D: boolean,
  onProgress?: (progress: PreloadProgress) => void
): () => void {
  const manifest: AssetManifest | undefined = scenario.assetManifest;
  if (!manifest || mode === "off") {
    onProgress?.({ loaded: 0, total: 0, tier: "idle" });
    return () => {};
  }

  let cancelled = false;
  const tasks: PreloadTask[] = [];
  const seenKeys = new Set<string>();

  const enqueue = (
    key: string,
    tier: "backbone" | "lookahead" | "episode",
    run: () => Promise<void>,
    yieldMs = 0
  ) => {
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    tasks.push({ key, tier, yieldMs, run });
  };

  // --- Tier 1: Episode Cast & Scene Backbone (from compile-time assetManifest) ---
  if (enable3D) {
    for (const c of orderFromTurn(manifest.characters, anchorTurnIndex)) {
      enqueue(`char:${c.costumeId}`, "backbone", () => prewarmCharacterAsset(c));
    }
  }
  const bgOrdered = orderFromTurn(manifest.backgrounds, anchorTurnIndex);
  const bgLimit = mode === "next1" ? 2 : bgOrdered.length;
  for (const bg of bgOrdered.slice(0, bgLimit)) {
    enqueue(`bg:${bg.url}`, "backbone", async () => {
      await prewarmTextureAsync(bg.url, true);
    });
  }
  if (enable3D) {
    const propsOrdered = orderFromTurn(manifest.props, anchorTurnIndex);
    const propLimit = mode === "next1" ? 1 : propsOrdered.length;
    for (const p of propsOrdered.slice(0, propLimit)) {
      enqueue(`prop:${p.id}`, "backbone", () => prewarmPropAsset(p));
    }
  }

  // --- Tier 2: Immediate Sliding Lookahead Window (N .. N + lookaheadCount) ---
  const lookaheadTurns = mode === "next1" ? 1 : mode === "next5" ? 8 : 12;
  const maxLookaheadIdx = anchorTurnIndex + lookaheadTurns;

  for (const v of manifest.audio.voices) {
    if (v.firstTurnIndex >= anchorTurnIndex && v.firstTurnIndex <= maxLookaheadIdx) {
      enqueue(`voice:${v.url}`, "lookahead", () => prewarmAudioAsync(v.url));
    }
  }
  if (enable3D) {
    for (const m of manifest.motions) {
      if (m.firstTurnIndex >= anchorTurnIndex && m.firstTurnIndex <= maxLookaheadIdx) {
        enqueue(`mot:${m.url}`, "lookahead", async () => {
          await loadGltfCached(sharedGltfLoader, m.url).catch(() => null);
        });
      }
    }
  }
  for (const b of manifest.audio.bgm) {
    if (b.firstTurnIndex >= anchorTurnIndex && b.firstTurnIndex <= maxLookaheadIdx) {
      enqueue(`bgm:${b.url}`, "lookahead", () => prewarmAudioAsync(b.url));
    }
  }
  for (const s of manifest.audio.se) {
    if (s.firstTurnIndex >= anchorTurnIndex && s.firstTurnIndex <= maxLookaheadIdx) {
      enqueue(`se:${s.url}`, "lookahead", () => prewarmAudioAsync(s.url));
    }
  }

  // Also ensure any reused motion/voice referenced directly by turns[anchorTurnIndex + 1 .. maxLookaheadIdx]
  // (whose firstTurnIndex was earlier in the episode) is in Tier 2 lookahead:
  const sliceEnd = Math.min(scenario.turns.length, maxLookaheadIdx + 1);
  for (let i = anchorTurnIndex; i < sliceEnd; i++) {
    const t = scenario.turns[i];
    if (!t) continue;
    if (t.voiceUrl) {
      enqueue(`voice:${t.voiceUrl}`, "lookahead", () => prewarmAudioAsync(t.voiceUrl!));
    }
    if (enable3D) {
      for (const c of Object.values(t.stateBefore.characters)) {
        if (c.motionUrl) {
          enqueue(`mot:${c.motionUrl}`, "lookahead", async () => {
            await loadGltfCached(sharedGltfLoader, c.motionUrl).catch(() => null);
          });
        }
      }
      for (const ev of [...t.preEvents, ...t.intraEvents]) {
        if (ev.motionUrl) {
          const mUrl = String(ev.motionUrl);
          enqueue(`mot:${mUrl}`, "lookahead", async () => {
            await loadGltfCached(sharedGltfLoader, mUrl).catch(() => null);
          });
        }
        if (ev.seUrl) {
          const sUrl = String(ev.seUrl);
          enqueue(`se:${sUrl}`, "lookahead", () => prewarmAudioAsync(sUrl));
        }
      }
    }
  }

  // --- Tier 3: Idle Full-Episode Drain (enabled for both "next5" and "all") ---
  if (mode === "next5" || mode === "all") {
    const yieldMs = mode === "all" ? 5 : 35;
    for (const b of orderFromTurn(manifest.audio.bgm, anchorTurnIndex)) {
      enqueue(`bgm:${b.url}`, "episode", () => prewarmAudioAsync(b.url), yieldMs);
    }
    for (const s of orderFromTurn(manifest.audio.se, anchorTurnIndex)) {
      enqueue(`se:${s.url}`, "episode", () => prewarmAudioAsync(s.url), yieldMs);
    }
    for (const v of orderFromTurn(manifest.audio.voices, anchorTurnIndex)) {
      enqueue(`voice:${v.url}`, "episode", () => prewarmAudioAsync(v.url), yieldMs);
    }
    if (enable3D) {
      for (const m of orderFromTurn(manifest.motions, anchorTurnIndex)) {
        enqueue(
          `mot:${m.url}`,
          "episode",
          async () => {
            await loadGltfCached(sharedGltfLoader, m.url).catch(() => null);
          },
          yieldMs
        );
      }
    }
  }

  const total = tasks.length;
  let loaded = 0;

  // Fast-forward tasks that have already completed in previous runs
  const pendingTasks: PreloadTask[] = [];
  for (const t of tasks) {
    if (warmedAssetKeys.has(t.key)) {
      loaded++;
    } else {
      pendingTasks.push(t);
    }
  }

  const report = (tier: PreloadProgress["tier"]) => {
    if (!cancelled) {
      onProgress?.({ loaded, total, tier: loaded >= total ? "done" : tier });
    }
  };

  if (pendingTasks.length === 0) {
    report("done");
    return () => {
      cancelled = true;
    };
  }

  report(pendingTasks[0].tier);

  let cursor = 0;
  const maxConcurrency = mode === "all" ? 6 : mode === "next5" ? 3 : 2;

  const worker = async () => {
    while (!cancelled) {
      const idx = cursor++;
      if (idx >= pendingTasks.length) break;
      const task = pendingTasks[idx];
      report(task.tier);
      try {
        await task.run();
        warmedAssetKeys.add(task.key);
      } catch {
        // ignore individual asset prewarm errors
      }
      loaded++;
      report(task.tier);
      if (!cancelled && task.yieldMs && task.yieldMs > 0) {
        await new Promise((r) => window.setTimeout(r, task.yieldMs));
      }
    }
  };

  // Delay background workers slightly (120ms) so Tier 0 active turn claims first connections
  const startTimer = window.setTimeout(() => {
    if (cancelled) return;
    const workers = Array.from(
      { length: Math.min(maxConcurrency, pendingTasks.length) },
      () => worker()
    );
    void Promise.all(workers).then(() => {
      report("done");
    });
  }, 120);

  return () => {
    cancelled = true;
    window.clearTimeout(startTimer);
  };
}

export const StageCanvas: React.FC<StageCanvasProps> = ({
  turn,
  cameraMode,
  enable3D,
  resolution = "auto",
  audioMixer,
  onAdvance,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const [loadingCount, setLoadingCount] = useState(0);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const bgMeshRef = useRef<THREE.Mesh | null>(null);
  const bgMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const currentBgUrlRef = useRef<string | null>(null);

  const charactersRef = useRef<Map<string, LoadedCharacter>>(new Map());
  // Index of the turn shown before this one, to tell reading in order from a jump.
  const prevTurnIndexRef = useRef<number | null>(null);
  const propsRef = useRef<Map<string, LoadedProp>>(new Map());
  const gltfLoaderRef = useRef(new GLTFLoader());
  const texLoaderRef = useRef(new THREE.TextureLoader());

  // Smooth camera & background interpolation state
  const camFromPosRef = useRef(new THREE.Vector3(0, 0, 10));
  const camToPosRef = useRef(new THREE.Vector3(0, 0, 10));
  const camFromQuatRef = useRef(new THREE.Quaternion());
  const camToQuatRef = useRef(new THREE.Quaternion());
  const camAnimStartRef = useRef(0);
  const camAnimDurRef = useRef(0);

  const bgFromPosRef = useRef(new THREE.Vector3(0, 0, -50));
  const bgToPosRef = useRef(new THREE.Vector3(0, 0, -50));
  const bgAnimStartRef = useRef(0);
  const bgAnimDurRef = useRef(0);

  const activeSpeakerJpRef = useRef<string>("");
  const cameraModeRef = useRef<"adv" | "orbit">(cameraMode);
  cameraModeRef.current = cameraMode;
  activeSpeakerJpRef.current = turn.speakerJp;

  // Initialize Three.js WebGL scene
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e14);
    sceneRef.current = scene;
    currentBgUrlRef.current = null;
    charactersRef.current.clear();
    propsRef.current.clear();

    const camera = new THREE.PerspectiveCamera(
      10.5,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.1,
      200
    );
    camera.position.set(0, 0.1, 7.2);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    rendererRef.current = renderer;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.1, -2);
    controls.enabled = cameraModeRef.current === "orbit";
    controlsRef.current = controls;

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 1.15);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xfffaf0, 1.1);
    dirLight.position.set(2, 5, 4);
    scene.add(dirLight);

    // 2D-in-3D Background Quad (Unity 1920x1080 @ 100 PPU = 19.2m x 10.8m)
    const bgGeo = new THREE.PlaneGeometry(19.2, 10.8);
    const bgMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: true,
      depthTest: true,
    });
    const bgMesh = new THREE.Mesh(bgGeo, bgMat);
    bgMesh.position.set(0, 0, -50);
    bgMesh.renderOrder = 0;
    scene.add(bgMesh);
    bgMeshRef.current = bgMesh;
    bgMatRef.current = bgMat;

    const clock = new THREE.Clock();
    let frameId = 0;

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.1);
      const now = performance.now() / 1000;

      // Update camera interpolation in ADV mode
      if (cameraModeRef.current === "adv") {
        const dur = camAnimDurRef.current;
        if (dur <= 0.001) {
          camera.position.copy(camToPosRef.current);
          camera.quaternion.copy(camToQuatRef.current);
        } else {
          const t = Math.min(1, (now - camAnimStartRef.current) / dur);
          const eased = t * t * (3 - 2 * t);
          camera.position.lerpVectors(camFromPosRef.current, camToPosRef.current, eased);
          camera.quaternion.slerpQuaternions(camFromQuatRef.current, camToQuatRef.current, eased);
        }
      } else if (controlsRef.current) {
        controlsRef.current.update();
      }

      // Update background plane position interpolation
      if (bgMeshRef.current) {
        const bDur = bgAnimDurRef.current;
        if (bDur <= 0.001) {
          bgMeshRef.current.position.copy(bgToPosRef.current);
        } else {
          const t = Math.min(1, (now - bgAnimStartRef.current) / bDur);
          const eased = t * t * (3 - 2 * t);
          bgMeshRef.current.position.lerpVectors(bgFromPosRef.current, bgToPosRef.current, eased);
        }
      }

      // Update character skeletal animations, facial morphs, and voice lip-sync
      const lip = audioMixer.getLipSync();
      const speaker = activeSpeakerJpRef.current;
      for (const char of charactersRef.current.values()) {
        updateStoryMotion(char, dt);
        char.expressionCtrl.setLipSync(char.name === speaker ? lip.level : 0, lip.vowel);
        char.expressionCtrl.update(dt);
      }

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container || !cameraRef.current) return;
      const w = container.clientWidth;
      const h = Math.max(1, container.clientHeight);
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    const resizeObs = new ResizeObserver(handleResize);
    resizeObs.observe(container);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObs.disconnect();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [audioMixer]);

  // Apply 3D resolution pixel ratio changes
  useEffect(() => {
    const renderer = rendererRef.current;
    const container = mountRef.current;
    if (!renderer || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const ratioMap: Record<StageResolution, number> = {
      auto: Math.min(dpr, 2),
      low: 0.75,
      medium: 1.0,
      high: 1.5,
      ultra: Math.min(dpr * 1.5, 2.5),
    };
    renderer.setPixelRatio(ratioMap[resolution] ?? Math.min(dpr, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
  }, [resolution]);

  // Toggle OrbitControls when cameraMode changes
  useEffect(() => {
    if (!controlsRef.current || !cameraRef.current) return;
    controlsRef.current.enabled = cameraMode === "orbit";
    if (cameraMode === "orbit") {
      controlsRef.current.target.set(
        camToPosRef.current.x,
        camToPosRef.current.y,
        2.0
      );
      controlsRef.current.update();
    }
  }, [cameraMode]);

  // Apply a motion to a loaded character. `startKey` names the script command that started it
  // (`motionCmd`), so the same motion started again is told apart from one still running. With
  // `playIntro` the in/action clips play before the loop (the motion starts on screen); without
  // it, the motion resumes in its loop.
  const applyCharacterMotion = async (
    char: LoadedCharacter,
    motionId: string,
    motionUrl: string | null,
    startKey: string,
    playIntro: boolean
  ) => {
    if (!motionUrl || char.requestedMotion === startKey) return;
    char.requestedMotion = startKey;
    try {
      let clipsPromise = char.motionClips.get(motionId);
      if (!clipsPromise) {
        clipsPromise = loadGltfCached(gltfLoaderRef.current, motionUrl).then((gltf) => {
          const { intro, loop } = pickStoryMotionClips(gltf.animations || [], motionId);
          return retargetMotionClips(gltf.scene, loop ? [...intro, loop] : intro, char.modelScene);
        });
        char.motionClips.set(motionId, clipsPromise);
      }
      const clips = await clipsPromise;
      if (char.requestedMotion !== startKey) return; // a newer motion was requested meanwhile
      playStoryMotion(char, clips, motionId, playIntro);
      char.appliedMotion = startKey;
    } catch (e) {
      // Fall back to what's actually playing, so a later request retries this motion.
      char.motionClips.delete(motionId);
      if (char.requestedMotion === startKey) char.requestedMotion = char.appliedMotion;
      console.warn(`[StageCanvas] Motion load failed for ${motionId}:`, e);
    }
  };

  // Helper to apply an expression preset to a loaded character
  const applyCharacterEmotion = (char: LoadedCharacter, emotionId: string) => {
    if (char.currentEmotion === emotionId) return;
    char.currentEmotion = emotionId;
    const preset =
      char.expressions.get(emotionId) ||
      char.expressions.get(emotionId.replace(/-Close$/i, "")) ||
      char.expressions.get("NORMAL_TUUJO");
    char.expressionCtrl.applyPreset(preset);
  };

  // Helper to update camera transform target
  const setCameraTarget = (
    pos: [number, number, number],
    rot: [number, number, number],
    durationSec: number
  ) => {
    if (!cameraRef.current) return;
    const now = performance.now() / 1000;
    camFromPosRef.current.copy(cameraRef.current.position);
    camFromQuatRef.current.copy(cameraRef.current.quaternion);

    // Convert Unity (x, y, z) -> Three.js (x, y, -z)
    camToPosRef.current.set(pos[0], pos[1], -pos[2]);
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(-rot[0]),
      THREE.MathUtils.degToRad(-rot[1]),
      THREE.MathUtils.degToRad(rot[2]),
      "YXZ"
    );
    camToQuatRef.current.setFromEuler(euler);
    camAnimStartRef.current = now;
    camAnimDurRef.current = durationSec;
  };

  // Helper to update background quad state
  const applyBackgroundState = (
    bgUrl: string | null,
    pos: [number, number, number],
    scale: [number, number],
    rot: [number, number, number],
    durationSec = 0
  ) => {
    if (!bgMeshRef.current || !bgMatRef.current) return;
    if (bgUrl !== currentBgUrlRef.current || (bgUrl && !bgMatRef.current.map)) {
      currentBgUrlRef.current = bgUrl;
      if (bgUrl) {
        const tex = loadTextureCached(texLoaderRef.current, bgUrl, true);
        bgMatRef.current.map = tex;
        bgMatRef.current.color.setHex(0xffffff);
        bgMatRef.current.needsUpdate = true;
        bgMeshRef.current.visible = true;
      } else {
        bgMatRef.current.map = null;
        bgMeshRef.current.visible = false;
      }
    }
    const now = performance.now() / 1000;
    bgFromPosRef.current.copy(bgMeshRef.current.position);
    bgToPosRef.current.set(pos[0], pos[1], -pos[2]);
    bgAnimStartRef.current = now;
    bgAnimDurRef.current = durationSec;
    bgMeshRef.current.scale.set(scale[0] || 1, scale[1] || 1, 1);
    bgMeshRef.current.rotation.set(
      THREE.MathUtils.degToRad(rot[0]),
      THREE.MathUtils.degToRad(-rot[1]),
      THREE.MathUtils.degToRad(rot[2])
    );
  };

  // Ensure a character costume is loaded and updated
  const syncCharacter = async (cState: CharacterState, turnIndex: number, arrivedInOrder: boolean) => {
    if (!sceneRef.current) return;
    let loaded = charactersRef.current.get(cState.name);

    if (!loaded || loaded.costumeId !== cState.costumeId) {
      if (loaded) {
        sceneRef.current.remove(loaded.rootGroup);
        charactersRef.current.delete(cState.name);
      }
      setLoadingCount((c) => c + 1);
      try {
        const [gltf, exprList, toonParams] = await Promise.all([
          loadGltfCached(gltfLoaderRef.current, cState.glbUrl),
          loadExpressionsCached(cState.expressionsUrl),
          loadToonParamsCached(cState.glbUrl),
        ]);

        // Process materials on the GLTF scene once
        const modelScene = gltf.scene as THREE.Object3D;
        if (!modelScene.userData.__toonProcessed) {
          modelScene.userData.__toonProcessed = true;
          // Record the hips' rest height before any motion moves them (retargeting scales by it).
          restHipsHeight(modelScene);
          const eyeHiTex = cState.eyeHighlightUrl
            ? loadTextureCached(texLoaderRef.current, cState.eyeHighlightUrl, false)
            : null;

          // Every texture embedded in the GLB, by image name. A game material can reference a
          // texture that its own GLB material doesn't carry (e.g. Brow's 2nd shadow is Face_col1).
          const texByName = new Map<string, THREE.Texture>();
          modelScene.traverse((node) => {
            if (!(node instanceof THREE.Mesh)) return;
            for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
              for (const t of [m?.map, m?.aoMap] as Array<THREE.Texture | null | undefined>) {
                if (t?.name && !texByName.has(t.name)) texByName.set(t.name, t);
              }
            }
          });
          // Shadow-colour textures ride in the glTF occlusion slot, which GLTFLoader marks as
          // non-colour data. They are colour textures like the main map, so decode them as sRGB.
          const asColorTex = (t: THREE.Texture | null | undefined) => {
            if (t && t.colorSpace !== THREE.SRGBColorSpace) {
              t.colorSpace = THREE.SRGBColorSpace;
              t.needsUpdate = true;
            }
            return t ?? null;
          };

          modelScene.traverse((node) => {
            if (!(node instanceof THREE.Mesh)) return;
            if (node.name.includes("_outline")) {
              node.visible = false;
              return;
            }
            if (node.name === "IndoorShoes") {
              node.visible = false;
              return;
            }
            const mat = Array.isArray(node.material) ? node.material[0] : node.material;
            const matName = mat?.name || "";
            const mainTex = mat?.map as THREE.Texture | null;
            const shadowTex = mat?.aoMap as THREE.Texture | null;

            if (matName.includes("EyeHi") || matName.includes("Highlight")) {
              node.material = new THREE.MeshBasicMaterial({
                map: mainTex || eyeHiTex,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
              });
              node.renderOrder = 2;
              return;
            }
            if (node.name === "Eye" || node.name.startsWith("Eye_")) {
              if (mainTex) {
                node.material = new THREE.MeshBasicMaterial({ map: mainTex });
                node.renderOrder = 1;
              }
              return;
            }
            if (node.name.includes("EyeShadow")) {
              node.material = new THREE.MeshBasicMaterial({
                color: 0x000000,
                transparent: true,
                opacity: 0.15,
                depthWrite: false,
              });
              node.renderOrder = 5;
              return;
            }
            if (mainTex && shadowTex) {
              const params = toonParams[matName] ?? null;
              const byName = (n?: string | null) => (n ? texByName.get(n) : undefined);
              node.material = createUberToonMaterial({
                mainTex,
                shadowTex: asColorTex(byName(params?.shadow1Tex) ?? shadowTex),
                shadow2ndTex: asColorTex(byName(params?.shadow2Tex) ?? shadowTex),
                params,
              });
            } else if (mainTex) {
              node.material = new THREE.MeshBasicMaterial({ map: mainTex });
            }
          });
        }

        const rootGroup = new THREE.Group();
        rootGroup.name = `char_${cState.name}`;
        rootGroup.add(modelScene);
        sceneRef.current.add(rootGroup);

        const exprMap = new Map<string, ExpressionPreset>();
        for (const e of exprList) {
          exprMap.set(e.name, e);
        }

        loaded = {
          name: cState.name,
          costumeId: cState.costumeId,
          rootGroup,
          modelScene,
          mixer: new THREE.AnimationMixer(modelScene),
          expressionCtrl: new ExpressionController(modelScene),
          expressions: exprMap,
          requestedMotion: null,
          appliedMotion: null,
          currentEmotion: null,
          motionClips: new Map(),
        };
        charactersRef.current.set(cState.name, loaded);
      } catch (err) {
        console.warn(`[StageCanvas] Character load failed for ${cState.name}:`, err);
        return;
      } finally {
        setLoadingCount((c) => Math.max(0, c - 1));
      }
    }

    loaded.rootGroup.visible = enable3D && cState.visible;
    // Convert Unity (x, y, z) -> Three.js (x, y, -z)
    loaded.rootGroup.position.set(
      cState.position[0],
      cState.position[1],
      -cState.position[2]
    );
    // Unity Y=180 faces camera at -Z; in Three.js camera is at +Z so 180 - ry faces camera
    loaded.rootGroup.rotation.set(
      THREE.MathUtils.degToRad(cState.rotation[0]),
      THREE.MathUtils.degToRad(180 - cState.rotation[1]),
      THREE.MathUtils.degToRad(cState.rotation[2])
    );

    applyCharacterEmotion(loaded, cState.emotion);
    // The motion starts on screen if its command belongs to this line, or to the previous line
    // when reading in order (a mid-line command the reader clicked past before it ran; the game
    // runs the rest of a line's commands at the click). Otherwise it was already running.
    const start = cState.motionStartTurn;
    const startsHere =
      start !== undefined && (start === turnIndex || (arrivedInOrder && start === turnIndex - 1));
    await applyCharacterMotion(
      loaded,
      cState.motionId,
      cState.motionUrl,
      cState.motionCmd ?? cState.motionId,
      startsHere && !cState.motionImmediate
    );
  };

  // Ensure 3D story props (bus window, desk, chair, etc.) are loaded and positioned
  const syncProps = async (propsRecord: Record<string, PropState>) => {
    if (!sceneRef.current) return;
    const activeAliases = new Set(Object.keys(propsRecord));
    for (const [alias, loadedProp] of propsRef.current.entries()) {
      if (!activeAliases.has(alias)) {
        sceneRef.current.remove(loadedProp.group);
        propsRef.current.delete(alias);
      }
    }

    for (const [alias, pState] of Object.entries(propsRecord)) {
      let loadedProp = propsRef.current.get(alias);
      if (!loadedProp || loadedProp.id !== pState.id) {
        if (loadedProp) {
          sceneRef.current.remove(loadedProp.group);
          propsRef.current.delete(alias);
        }
        try {
          const urls = [pState.glbUrl, ...(pState.extraGlbUrls || [])];
          const gltfs = await Promise.all(
            urls.map((u) => loadGltfCached(gltfLoaderRef.current, u).catch(() => null))
          );
          const group = new THREE.Group();
          group.name = `prop_${alias}`;
          for (const g of gltfs) {
            if (!g?.scene) continue;
            const clone = g.scene.clone(true);
            clone.traverse((node: any) => {
              if (
                node.name &&
                (node.name.endsWith("(Clone)") ||
                  node.name.endsWith("Clone") ||
                  node.position.length() > 10)
              ) {
                node.position.set(0, 0, 0);
                if (
                  Math.round(node.scale.x) === 200 &&
                  Math.round(node.scale.y) === 100 &&
                  Math.round(node.scale.z) === 100
                ) {
                  node.scale.set(100, 100, 100);
                }
              }
              if (!(node instanceof THREE.Mesh)) return;
              // Apply external textureMap if available
              const mat = Array.isArray(node.material) ? node.material[0] : node.material;
              const matName = mat?.name || "";
              const tmapEntry =
                pState.textureMap?.[matName] ||
                pState.textureMap?.[node.name] ||
                Object.values(pState.textureMap || {})[0];
              if (tmapEntry) {
                const texFile =
                  tmapEntry._BaseMap || tmapEntry._MainTex || Object.values(tmapEntry)[0];
                if (texFile) {
                  const tex = loadTextureCached(
                    texLoaderRef.current,
                    `${pState.textureDir}${texFile}`,
                    false
                  );
                  node.material = new THREE.MeshBasicMaterial({
                    map: tex,
                    transparent: true,
                    alphaTest: 0.05,
                    side: THREE.DoubleSide,
                  });
                }
              } else if (mat?.map) {
                node.material = new THREE.MeshBasicMaterial({
                  map: mat.map,
                  side: THREE.DoubleSide,
                });
              }
            });
            group.add(clone);
          }
          sceneRef.current.add(group);
          loadedProp = { alias, id: pState.id, group };
          propsRef.current.set(alias, loadedProp);
        } catch (e) {
          console.warn(`[StageCanvas] Prop load failed for ${alias}:`, e);
          continue;
        }
      }

      loadedProp.group.visible = enable3D && pState.visible;
      loadedProp.group.position.set(
        pState.position[0],
        pState.position[1],
        -pState.position[2]
      );
      loadedProp.group.scale.set(pState.scale[0], pState.scale[1], pState.scale[2]);
      loadedProp.group.rotation.set(
        THREE.MathUtils.degToRad(pState.rotation[0]),
        THREE.MathUtils.degToRad(180 - pState.rotation[1]),
        THREE.MathUtils.degToRad(pState.rotation[2])
      );
    }
  };

  // Apply turn snapshot and schedule intra-turn choreography events
  useEffect(() => {
    const snap: StageSnapshot = turn.stateBefore;

    // 1. Background
    applyBackgroundState(
      snap.background.url,
      snap.background.position,
      snap.background.scale,
      snap.background.rotation,
      0
    );

    // 2. Camera (use instant cut when seeking/starting turn unless preEvent specifies pan)
    let initialCamDur = 0;
    for (const ev of turn.preEvents) {
      if (ev.type === "camera_move" && ev.duration > 0) {
        initialCamDur = Math.min(ev.duration, 2.5);
      }
    }
    setCameraTarget(snap.camera.position, snap.camera.rotation, initialCamDur);

    // 3. Characters & Props
    const arrivedInOrder = prevTurnIndexRef.current === turn.index - 1;
    prevTurnIndexRef.current = turn.index;
    for (const cState of Object.values(snap.characters)) {
      void syncCharacter(cState, turn.index, arrivedInOrder);
    }
    // Hide characters not present in snapshot
    for (const [name, loaded] of charactersRef.current.entries()) {
      if (!snap.characters[name]) {
        loaded.rootGroup.visible = false;
      }
    }
    void syncProps(snap.props);

    // 4. Schedule intra-turn choreography events (motions, emotions, camera cuts, waits)
    const timers: number[] = [];
    let delaySec = 0;
    for (const ev of turn.intraEvents) {
      if (ev.type === "wait") {
        delaySec += Number(ev.seconds || 0);
        continue;
      }
      const fireAtMs = Math.max(0, delaySec * 1000);
      const timerId = window.setTimeout(() => {
        if (ev.type === "char_motion") {
          const c = charactersRef.current.get(ev.character);
          if (c && ev.motionUrl) {
            void applyCharacterMotion(c, ev.motionId, ev.motionUrl, ev.motionCmd ?? ev.motionId, !ev.immediate);
          }
        } else if (ev.type === "char_emotion") {
          const c = charactersRef.current.get(ev.character);
          if (c) {
            applyCharacterEmotion(c, ev.emotion);
          }
        } else if (ev.type === "char_visibility") {
          const c = charactersRef.current.get(ev.character);
          if (c) {
            c.rootGroup.visible = enable3D && Boolean(ev.visible);
          }
        } else if (ev.type === "char_rotate") {
          const c = charactersRef.current.get(ev.character);
          if (c && Array.isArray(ev.rotation)) {
            c.rootGroup.rotation.set(
              THREE.MathUtils.degToRad(ev.rotation[0]),
              THREE.MathUtils.degToRad(180 - ev.rotation[1]),
              THREE.MathUtils.degToRad(ev.rotation[2])
            );
          }
        } else if (ev.type === "se_play" && ev.seUrl) {
          if (ev.loop) {
            audioMixer.startAmbience(
              { id: ev.seId, url: ev.seUrl, volume: ev.volume ?? 1.0 },
              ev.fadeSec ?? 0
            );
          } else {
            audioMixer.playOneShotSe(ev.seId, ev.seUrl, ev.volume ?? 1.0, ev.fadeSec ?? 0);
          }
        } else if (ev.type === "se_stop") {
          audioMixer.stopAmbience(ev.seId, ev.fadeSec ?? 0);
        }
      }, fireAtMs);
      timers.push(timerId);
    }

    return () => {
      for (const t of timers) {
        window.clearTimeout(t);
      }
    };
  }, [turn, enable3D]);

  return (
    <div
      className="relative w-full h-full select-none cursor-pointer overflow-hidden"
      onClick={(e) => {
        if (cameraMode === "adv") {
          const rect = e.currentTarget.getBoundingClientRect();
          const id = Date.now() + Math.random();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          setRipples((prev) => [...prev.slice(-4), { id, x, y }]);
          window.setTimeout(() => {
            setRipples((prev) => prev.filter((r) => r.id !== id));
          }, 550);
          onAdvance();
        }
      }}
    >
      <div ref={mountRef} className="w-full h-full" />
      {ripples.map((r) => (
        <span
          key={r.id}
          aria-hidden="true"
          className="cleista-tap-ripple pointer-events-none"
          style={{ left: r.x, top: r.y }}
        />
      ))}
      {loadingCount > 0 && (
        <div className="absolute top-14 right-4 z-20 flex items-center gap-2 rounded-full bg-slate-900/80 border border-slate-700/70 px-3 py-1 text-xs text-amber-300 backdrop-blur-md">
          <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping" />
          Loading 3D assets…
        </div>
      )}
    </div>
  );
};
