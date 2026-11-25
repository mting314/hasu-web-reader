import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  createUberToonMaterial,
  ExpressionController,
  ExpressionPreset,
  retargetMotionClips,
  ToonMaterialParams,
} from "../engine/UberToonMaterial";
import { AudioMixer } from "../engine/AudioMixer";
import {
  CharacterState,
  DialogueTurn,
  PropState,
  StageSnapshot,
} from "../types/scenario";

interface StageCanvasProps {
  turn: DialogueTurn;
  cameraMode: "adv" | "orbit";
  enable3D: boolean;
  audioMixer: AudioMixer;
  onAdvance: () => void;
}

interface LoadedCharacter {
  name: string;
  costumeId: string;
  rootGroup: THREE.Group;
  modelScene: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  expressionCtrl: ExpressionController;
  expressions: Map<string, ExpressionPreset>;
  currentMotionId: string | null;
  currentEmotion: string | null;
  activeAction: THREE.AnimationAction | null;
}

interface LoadedProp {
  alias: string;
  id: string;
  group: THREE.Group;
}

const gltfCache = new Map<string, Promise<any>>();
const textureCache = new Map<string, THREE.Texture>();
const expressionJsonCache = new Map<string, Promise<ExpressionPreset[]>>();
const toonParamsCache = new Map<string, Promise<Record<string, ToonMaterialParams>>>();

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
    gltfCache.set(url, p);
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
    tex = loader.load(url);
    tex.flipY = flipY;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    textureCache.set(key, tex);
  }
  return tex;
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

export const StageCanvas: React.FC<StageCanvasProps> = ({
  turn,
  cameraMode,
  enable3D,
  audioMixer,
  onAdvance,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [loadingCount, setLoadingCount] = useState(0);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const bgMeshRef = useRef<THREE.Mesh | null>(null);
  const bgMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const currentBgUrlRef = useRef<string | null>(null);

  const charactersRef = useRef<Map<string, LoadedCharacter>>(new Map());
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
        char.mixer.update(dt);
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
    };
  }, [audioMixer]);

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

  // Helper to apply a motion GLB to a loaded character
  const applyCharacterMotion = async (char: LoadedCharacter, motionId: string, motionUrl: string | null) => {
    if (!motionUrl || char.currentMotionId === motionId) return;
    char.currentMotionId = motionId;
    try {
      const gltf = await loadGltfCached(gltfLoaderRef.current, motionUrl);
      const clips = retargetMotionClips(gltf.scene, gltf.animations || [], char.modelScene);
      const targetClip = clips.find((c) => c.name.endsWith("@l")) || clips[0];
      if (targetClip) {
        const nextAction = char.mixer.clipAction(targetClip);
        nextAction.reset();
        nextAction.setLoop(THREE.LoopRepeat, Infinity);
        nextAction.play();
        if (char.activeAction && char.activeAction !== nextAction) {
          char.activeAction.crossFadeTo(nextAction, 0.28, false);
        }
        char.activeAction = nextAction;
      }
    } catch (e) {
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
  const syncCharacter = async (cState: CharacterState) => {
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
          currentMotionId: null,
          currentEmotion: null,
          activeAction: null,
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
    await applyCharacterMotion(loaded, cState.motionId, cState.motionUrl);
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
    for (const cState of Object.values(snap.characters)) {
      void syncCharacter(cState);
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
            void applyCharacterMotion(c, ev.motionId, ev.motionUrl);
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
      onClick={() => {
        if (cameraMode === "adv") {
          onAdvance();
        }
      }}
    >
      <div ref={mountRef} className="w-full h-full" />
      {loadingCount > 0 && (
        <div className="absolute top-12 right-4 z-20 flex items-center gap-2 rounded-full bg-slate-900/80 border border-slate-700/70 px-3 py-1 text-xs text-amber-300 backdrop-blur-md">
          <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping" />
          Loading 3D assets…
        </div>
      )}
    </div>
  );
};
