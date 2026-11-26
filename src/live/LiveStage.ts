/**
 * Three.js scene for the Fes×LIVE choreo viewer: one rig per member, posed every frame from the
 * decoded live motion (motion.ts) through the humanoid solver (humanoid.ts).
 *
 * Costume models come from public/assets/live/costume/<id>/<id>.glb (scripts/export_live_costume.py)
 * and their avatars from <id>_avatar.json (scripts/export_live_avatar.py). A member whose model
 * isn't available is drawn as a skeleton; the skeleton overlay can also be shown on top of models.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { HumanoidSolver, toGltfQ, toGltfT, type AvatarJson, type Pose, type Vec3 } from "./humanoid";
import { ChunkStore, MUSCLE_COUNT, type LiveIndex } from "./motion";
import { FaceRig, LipStore, blinkAt, expressionAt, type ExpressionTrack, type FaceJson } from "./face";
import { SubBoneStore } from "./subbones";

export const MEMBER_COLORS: Record<number, string> = {
  1021: "#68be8d", 1022: "#ba2636", 1023: "#e5a1c3",
  1031: "#f8b500", 1032: "#5383c3", 1033: "#e7609e",
  1041: "#a2d7dd", 1042: "#fad764", 1043: "#9d8de2",
  1051: "#1ebecd", 1052: "#f08a5d",
};

export type CameraPreset = "front" | "back" | "left" | "right" | "top";

interface Rig {
  costume: string;
  solver: HumanoidSolver;
  model: THREE.Object3D | null;
  nodes: (THREE.Object3D | null)[];
  /**
   * The face model has its own spine/neck/head bones under the body's upper chest; in the game
   * RotationConstraints make them copy the body's bones. Pairs of (face bone, body bone, rest
   * offset = inverse(body rest world) * face rest world), parents first.
   */
  faceFollow: { face: THREE.Object3D; body: THREE.Object3D; offset: THREE.Quaternion }[];
  /** Expression/lip/blink driver, when the costume has a face rig export. */
  face: FaceRig | null;
  /** Helper bones driven by the packet's sub-bone transforms (packet order). */
  sub: { move: (THREE.Object3D | null)[]; rotate: (THREE.Object3D | null)[] };
  /** The helper bones' rest transforms, restored while no sub-bone sample is available. */
  subRest: { move: (THREE.Vector3 | null)[]; rotate: (THREE.Quaternion | null)[] };
  /** Both material sets of every mesh (costume / plain colour), switched by setLook. */
  looks: LookMesh[];
  lookKey: string;
}

interface LookMesh {
  mesh: THREE.Mesh;
  array: boolean;
  costume: THREE.Material[];
  plain: THREE.Material[];
  /** Per material slot, as exported: restored when the member stops being ghosted. */
  base: { transparent: boolean; opacity: number }[];
  /** Depth-only twin drawn just before the mesh while the member is ghosted (see depthTwin). */
  depth: THREE.Mesh | null;
}

const FACE_BONES = ["Spine_03", "Neck", "Head"];

/**
 * In the prefab the face model's root (`3d_face_*`) hangs under the body's upper chest. Some exported
 * GLBs put it under a mesh node instead, which leaves the face at the stage origin; re-attach it to
 * `<prefix>Spine_03`, keeping its rest-pose world transform. Call before posing.
 */
function reattachFace(model: THREE.Object3D, bodyHipsName: string) {
  const chest = model.getObjectByName(`${bodyHipsName.replace(/Hips$/, "")}Spine_03`);
  if (!chest) return;
  model.updateMatrixWorld(true);
  const faces: THREE.Object3D[] = [];
  model.traverse((o) => {
    if (o.name.startsWith("3d_face") && o.parent !== chest) faces.push(o);
  });
  for (const f of faces) chest.attach(f);
}

function faceFollowPairs(model: THREE.Object3D, bodyHipsName: string): Rig["faceFollow"] {
  const bodyPrefix = bodyHipsName.replace(/Hips$/, ""); // e.g. "SayLzA_"
  const chr = bodyPrefix.slice(0, 3); // e.g. "Say"
  model.updateMatrixWorld(true);
  const out: Rig["faceFollow"] = [];
  for (const bone of FACE_BONES) {
    const face = model.getObjectByName(`${chr}_${bone}`);
    const body = model.getObjectByName(`${bodyPrefix}${bone}`);
    if (!face || !body || face === body) continue;
    const bq = body.getWorldQuaternion(new THREE.Quaternion());
    const fq = face.getWorldQuaternion(new THREE.Quaternion());
    out.push({ face, body, offset: bq.invert().multiply(fq) });
  }
  return out;
}

interface Member {
  cid: number;
  name: string;
  costumes: { from: number; costume: string }[];
  offsets: { from: number; dx: number; dz: number }[];
  visibility: { t: number; visible: boolean }[];
  /** On stage at the last update (from the recording's VisibleCommunicator). */
  onStage: boolean;
  rigs: Map<string, Promise<Rig | null>>;
  ready: Map<string, Rig>;
  active: Rig | null;
  skeleton: THREE.LineSegments;
  hips: THREE.Vector3;
  /** Horizontal unit vector the body faces (three.js space). */
  facing: THREE.Vector3;
  visible: boolean;
  present: boolean;
  /** Opacity the model was drawn at in the last update (0 = not drawn). */
  drawnAlpha: number;
}

const UNLIT = /^(Face|Eye|Brow|EyeHi|EyeShadow|EyeLens)/i;
const HIDDEN_MESHES = /^(EyeLens|EyeShadow)$/;

export class LiveStage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
  readonly controls: OrbitControls;
  readonly members = new Map<number, Member>();
  showSkeleton = false;
  follow: number | null = null;
  /** In fan cam, members standing between the camera and the target are hidden. */
  fanCamActive = false;
  /** Fan cam swings round to stay in front of the member instead of on the audience side. */
  fanCamFacing = false;
  /** Opacity of everyone except the followed member (1 = no ghosting). */
  othersOpacity = 1;
  /** Draw members in one flat colour each instead of their costume textures. */
  plain = false;
  /** Unit vector (three.js space) from the stage towards the audience: members face +z at MC lineups. */
  audience = new THREE.Vector3(0, 0, 1);
  /** Split view: the main camera on the left, its exact back view (backCamera) on the right. */
  split = false;
  /** Mirror the main view left-right (the back view never is: from behind, left and right already match). */
  mirror = false;
  /** The main camera mirrored through the controls' target, re-placed every frame while split. */
  readonly backCamera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);

  private loader = new GLTFLoader();
  private lips: LipStore;
  private subs: SubBoneStore;
  /** Apply the packet's helper-bone transforms (toggle to compare). */
  subBones = true;
  private expressions: Record<string, ExpressionTrack> = {};
  showFaces = true;
  private muscles = new Float32Array(MUSCLE_COUNT);
  private gradient: THREE.DataTexture;
  private centre: Vec3;
  private disposed = false;
  private lastFrame = performance.now();
  /** Set while rendering a mirrored view: swaps which winding three treats as front-facing. */
  private flipWinding = false;

  constructor(
    private container: HTMLElement,
    private store: ChunkStore,
    private index: LiveIndex,
    private assetBase: string,
    liveBase: string,
  ) {
    this.lips = new LipStore(liveBase, index.chunkSeconds);
    this.subs = new SubBoneStore(liveBase, index.chunkSeconds);
    fetch(`${liveBase}/expressions.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((e) => (this.expressions = e))
      .catch(() => undefined);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Mirroring negates the projection's x (see layout), which reverses the on-screen winding of every
    // triangle. three only flips its front face for negative-determinant object matrices, so flip it
    // here too; culling and gl_FrontFacing (two-sided normals) then stay right in the mirrored view.
    const state = this.renderer.state;
    const setMaterial = state.setMaterial;
    state.setMaterial = (material, frontFaceCW) => setMaterial(material, !!frontFaceCW !== this.flipWinding);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1.0, 0);
    this.centre = [index.stageCentre[0], 0, index.stageCentre[2]];

    this.scene.background = new THREE.Color("#10131b");
    this.scene.add(new THREE.HemisphereLight("#ffffff", "#2a2f3d", 1.4));
    const sun = new THREE.DirectionalLight("#ffffff", 1.6);
    sun.position.set(3, 8, 6);
    this.scene.add(sun);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), new THREE.MeshBasicMaterial({ color: "#1b2030" }));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(28, 28, "#3a4258", "#262c3c");
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    this.scene.add(grid);

    const g = new Uint8Array([90, 90, 90, 255, 255, 255, 255, 255]);
    this.gradient = new THREE.DataTexture(g, 2, 1, THREE.RGBAFormat);
    this.gradient.magFilter = THREE.NearestFilter;
    this.gradient.minFilter = THREE.NearestFilter;
    this.gradient.needsUpdate = true;

    for (const m of index.members) {
      const color = new THREE.Color(MEMBER_COLORS[m.characterId] ?? "#ffffff");
      const skeleton = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }),
      );
      skeleton.renderOrder = 1000; // after the ghosts, whose render order goes up with their count
      this.scene.add(skeleton);
      this.members.set(m.characterId, {
        cid: m.characterId, name: m.name, costumes: m.costumes, offsets: m.offsets ?? [],
        visibility: m.visibility ?? [], onStage: true, rigs: new Map(), ready: new Map(),
        active: null, skeleton, hips: new THREE.Vector3(), facing: new THREE.Vector3(0, 0, 1),
        visible: true, present: false, drawnAlpha: 0,
      });
    }
    this.resize();
    this.setCamera("front");
  }

  dispose() {
    this.disposed = true;
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.layout();
  }

  /**
   * Viewports in CSS pixels: the whole canvas, or with split on the left half for the main camera
   * and the right half for the back camera. Sets each camera's aspect and projection, mirrored for
   * the main camera when `mirror` is on (rebuilt every frame, so toggling needs no extra call).
   */
  private layout(): { cam: THREE.PerspectiveCamera; x: number; w: number; h: number; mirror: boolean }[] {
    const { x: width, y: h } = this.renderer.getSize(new THREE.Vector2());
    const half = this.split ? Math.floor(width / 2) : width;
    const views = [{ cam: this.camera, x: 0, w: half, h, mirror: this.mirror }];
    if (this.split) views.push({ cam: this.backCamera, x: half, w: width - half, h, mirror: false });
    for (const v of views) {
      v.cam.aspect = Math.max(1, v.w) / Math.max(1, h);
      v.cam.updateProjectionMatrix();
      if (v.mirror) {
        const e = v.cam.projectionMatrix.elements; // negate clip-space x: the first row
        e[0] = -e[0]; e[4] = -e[4]; e[8] = -e[8]; e[12] = -e[12];
        v.cam.projectionMatrixInverse.copy(v.cam.projectionMatrix).invert();
      }
    }
    return views;
  }

  /**
   * Render the main view, and with split on the back view beside it: the main camera rotated 180°
   * about the vertical through the target (same height and distance), so orbit, zoom, follow and fan
   * cam all carry over to it.
   */
  private render() {
    if (this.split) {
      const back = this.backCamera;
      const target = this.controls.target;
      const eye = this.camera.position;
      back.fov = this.camera.fov;
      back.near = this.camera.near;
      back.far = this.camera.far;
      back.position.set(2 * target.x - eye.x, eye.y, 2 * target.z - eye.z);
      back.lookAt(target);
    }
    const views = this.layout();
    this.renderer.setScissorTest(this.split);
    for (const v of views) {
      this.renderer.setViewport(v.x, 0, v.w, v.h);
      this.renderer.setScissor(v.x, 0, v.w, v.h);
      this.prepareView(v.cam);
      this.flipWinding = v.mirror;
      this.renderer.render(this.scene, v.cam);
    }
    this.flipWinding = false;
    this.renderer.setScissorTest(false);
  }

  /**
   * Per-view visibility and order: hide whoever blocks this camera's fan-cam shot, and sort the
   * ghosted members back to front, each one's depth twins just before her colour (see depthTwin).
   */
  private prepareView(cam: THREE.Camera) {
    const ghosts: Member[] = [];
    for (const m of this.members.values()) {
      const model = m.active?.model;
      if (!model || m.drawnAlpha <= 0) continue;
      model.visible = !this.occludesFanCam(m, cam.position);
      if (model.visible && m.drawnAlpha < 0.999) ghosts.push(m);
    }
    const d = (m: Member) => m.hips.distanceToSquared(cam.position);
    ghosts.sort((a, b) => d(b) - d(a));
    ghosts.forEach((m, i) => {
      for (const l of m.active!.looks) {
        if (l.depth) l.depth.renderOrder = 1 + 2 * i;
        l.mesh.renderOrder = 2 + 2 * i;
      }
    });
  }

  /**
   * Fan cam: a close, chest-height shot of one member from the audience side that tracks her
   * across the stage (orbit/zoom still work relative to her). null turns it off.
   */
  fanCam(cid: number | null, distance = 3.0) {
    this.follow = cid;
    this.fanCamActive = cid !== null;
    if (cid === null) return;
    const m = this.members.get(cid);
    if (!m) return;
    const target = new THREE.Vector3(m.hips.x, 1.05, m.hips.z);
    const a = (this.fanCamFacing ? m.facing : this.audience).clone().setY(0).normalize();
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(a, distance).add(new THREE.Vector3(0, 0.15, 0));
    this.controls.update();
  }

  setCamera(preset: CameraPreset) {
    const target = new THREE.Vector3(0, 1.0, 0);
    const a = this.audience.clone().setY(0).normalize();
    const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), a);
    const pos = {
      front: a.clone().multiplyScalar(12).add(new THREE.Vector3(0, 1.4, 0)),
      back: a.clone().multiplyScalar(-12).add(new THREE.Vector3(0, 1.8, 0)),
      left: side.clone().multiplyScalar(-11).add(new THREE.Vector3(0, 1.4, 0)),
      right: side.clone().multiplyScalar(11).add(new THREE.Vector3(0, 1.4, 0)),
      top: a.clone().multiplyScalar(0.01).add(new THREE.Vector3(0, 16, 0)),
    }[preset];
    if (this.follow !== null) {
      const m = this.members.get(this.follow);
      if (m) {
        target.set(m.hips.x, 1.0, m.hips.z);
        pos.multiplyScalar(0.45).add(new THREE.Vector3(m.hips.x, 0.3, m.hips.z));
      }
    }
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.controls.update();
  }

  private visibleAt(m: Member, t: number): boolean {
    let v = true;
    for (const e of m.visibility) {
      if (e.t > t) break;
      v = e.visible;
    }
    return v;
  }

  /** Character ids on stage at the last update. */
  onStageMembers(): Set<number> {
    return new Set([...this.members.values()].filter((m) => m.onStage).map((m) => m.cid));
  }

  private offsetAt(m: Member, t: number): { dx: number; dz: number } | null {
    let o: { dx: number; dz: number } | null = null;
    for (const e of m.offsets) if (t >= e.from - 0.5) o = e;
    return o ?? m.offsets[0] ?? null;
  }

  private costumeAt(m: Member, t: number): string | null {
    let c: string | null = null;
    for (const e of m.costumes) if (t >= e.from - 0.5) c = e.costume;
    return c ?? m.costumes[0]?.costume ?? null;
  }

  private loadRig(m: Member, costume: string): Promise<Rig | null> {
    if (!m.rigs.has(costume)) {
      const dir = `${this.assetBase}/costume/${costume}`;
      const p = (async () => {
        const av: AvatarJson = await fetch(`${dir}/${costume}_avatar.json`).then((r) => {
          if (!r.ok) throw new Error(`avatar ${r.status}`);
          return r.json();
        });
        const solver = new HumanoidSolver(av);
        let model: THREE.Object3D | null = null;
        let looks: LookMesh[] = [];
        try {
          const gltf = await this.loader.loadAsync(`${dir}/${costume}.glb`);
          model = gltf.scene;
          looks = this.toonify(model, MEMBER_COLORS[m.cid] ?? "#ffffff");
        } catch {
          model = null; // no exported costume yet: skeleton only
        }
        const nodes = av.nodes.map((n) => model?.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n.name)) ?? null);
        if (model) reattachFace(model, av.nodes[av.hips].name);
        const faceFollow = model ? faceFollowPairs(model, av.nodes[av.hips].name) : [];
        let face: FaceRig | null = null;
        if (model) {
          model.visible = false;
          this.scene.add(model);
          const fj: FaceJson | null = await fetch(`${this.assetBase}/face/${costume}_face.json`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
          if (fj) face = new FaceRig(fj, model);
        }
        const byName = (n: string) => model?.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n)) ?? null;
        const sub = { move: (av.subBones?.move ?? []).map(byName), rotate: (av.subBones?.rotate ?? []).map(byName) };
        const subRest = {
          move: sub.move.map((n) => n?.position.clone() ?? null),
          rotate: sub.rotate.map((n) => n?.quaternion.clone() ?? null),
        };
        const rig: Rig = { costume, solver, model, nodes, faceFollow, face, sub, subRest, looks, lookKey: "costume|1" };
        m.ready.set(costume, rig);
        return rig;
      })().catch((e) => {
        console.warn(`[live] ${m.name} ${costume}:`, e);
        return null;
      });
      m.rigs.set(costume, p);
    }
    return m.rigs.get(costume)!;
  }

  /**
   * Swap the exported PBR materials for toon ones, and build the plain-colour alternative: the
   * member's colour with toon shading, keeping only the texture's alpha so hair cards and lace
   * stay cut out instead of turning into solid quads.
   */
  private toonify(root: THREE.Object3D, memberColor: string): LookMesh[] {
    const plainColor = new THREE.Color(memberColor).lerp(new THREE.Color("#ffffff"), 0.35);
    const looks: LookMesh[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false; // skinned bounds don't follow the animation
      // EyeLens is the game's (nearly invisible) refraction mesh and EyeShadow is drawn by its own
      // shader; neither has a texture here, so as plain materials they'd paint the eyes flat white.
      if (HIDDEN_MESHES.test(mesh.name) || HIDDEN_MESHES.test(mesh.parent?.name ?? "")) {
        mesh.visible = false;
        return;
      }
      const array = Array.isArray(mesh.material);
      const mats = array ? (mesh.material as THREE.Material[]) : [mesh.material as THREE.Material];
      const look: LookMesh = { mesh, array, costume: [], plain: [], base: [], depth: null };
      for (const mat of mats) {
        const src = mat as THREE.MeshStandardMaterial;
        const common = {
          map: src.map ?? null, transparent: src.transparent, opacity: src.opacity, alphaTest: src.alphaTest,
          side: src.side, depthWrite: src.depthWrite,
        };
        const unlit = UNLIT.test(mesh.name) || UNLIT.test(src.name);
        const m = unlit ? new THREE.MeshBasicMaterial(common) : new THREE.MeshToonMaterial({ ...common, gradientMap: this.gradient });
        m.name = src.name;
        const plain = new THREE.MeshToonMaterial({ ...common, color: plainColor, gradientMap: this.gradient });
        plain.name = `${src.name} (plain)`;
        plain.onBeforeCompile = (sh) => {
          sh.fragmentShader = sh.fragmentShader.replace(
            "#include <map_fragment>",
            "#ifdef USE_MAP\n\tdiffuseColor.a *= texture2D( map, vMapUv ).a;\n#endif",
          );
        };
        plain.customProgramCacheKey = () => "live-plain-alpha";
        if (/EyeHi|Highlight|Lens/i.test(src.name)) {
          m.blending = THREE.AdditiveBlending;
          m.depthWrite = false;
          plain.visible = false; // eye sparkles would read as stray white dots on a flat figure
        }
        look.costume.push(m);
        look.plain.push(plain);
        look.base.push({ transparent: m.transparent, opacity: m.opacity });
      }
      mesh.material = array ? look.costume : look.costume[0];
      looks.push(look);
    });
    for (const l of looks) l.depth = this.depthTwin(l); // after the traversal, which would visit them
    return looks;
  }

  /**
   * A depth-only copy of a mesh for ghosting. Drawn just before the ghost's colour, it leaves only
   * her nearest surface able to pass the depth test (colour uses LessEqual), so she reads as one
   * translucent silhouette instead of showing eyes through hair and body through costume. Shares the
   * mesh's geometry, skeleton and morph weights; hidden until the member is ghosted.
   */
  private depthTwin(l: LookMesh): THREE.Mesh {
    const src = l.mesh;
    const mats = l.costume.map((m, i) => {
      const c = m as THREE.MeshBasicMaterial;
      const d = new THREE.MeshBasicMaterial({
        map: c.map, side: c.side, transparent: true, colorWrite: false, depthWrite: true,
        // blended textures (lace, soft hair tips) only hide what's behind where they're mostly opaque
        alphaTest: Math.max(c.alphaTest, l.base[i].transparent ? 0.5 : 0),
        // a hair further back, so the same surface's colour never loses the depth test to it
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      d.name = `${c.name} (depth)`;
      d.visible = c.depthWrite && c.blending === THREE.NormalBlending; // not the additive eye sparkles
      return d;
    });
    const mat = l.array ? mats : mats[0];
    let twin: THREE.Mesh;
    if ((src as THREE.SkinnedMesh).isSkinnedMesh) {
      const s = src as THREE.SkinnedMesh;
      const t = new THREE.SkinnedMesh(src.geometry, mat);
      t.bindMode = s.bindMode;
      t.bind(s.skeleton, s.bindMatrix);
      twin = t;
    } else twin = new THREE.Mesh(src.geometry, mat);
    twin.morphTargetInfluences = src.morphTargetInfluences; // the same array, so expressions carry over
    twin.morphTargetDictionary = undefined; // keeps FaceRig from driving it a second time
    twin.name = `depth:${src.name}`; // not "3d_face…", which reattachFace would move
    twin.frustumCulled = false;
    twin.visible = false;
    src.add(twin); // identity transform: same world matrix as the mesh
    return twin;
  }

  /**
   * Costume or plain materials, at the given opacity. Ghosted members draw in the transparent pass
   * after everyone opaque, so the followed member is never washed out by someone in front.
   */
  private setLook(rig: Rig, plain: boolean, alpha: number) {
    const key = `${plain ? "plain" : "costume"}|${alpha}`;
    if (rig.lookKey === key) return;
    rig.lookKey = key;
    const ghost = alpha < 0.999;
    for (const l of rig.looks) {
      const mats = plain ? l.plain : l.costume;
      mats.forEach((mat, i) => {
        const b = l.base[i];
        if (mat.transparent !== (b.transparent || ghost)) mat.needsUpdate = true;
        mat.transparent = b.transparent || ghost;
        mat.opacity = b.opacity * alpha;
      });
      l.mesh.material = l.array ? mats : mats[0];
      if (l.depth) l.depth.visible = ghost;
      if (!ghost) l.mesh.renderOrder = 0; // ghosts are ordered per view in prepareView
    }
  }

  /** Preload every costume a member wears (cheap: a handful of GLBs). */
  preload() {
    for (const m of this.members.values()) for (const c of m.costumes) this.loadRig(m, c.costume);
  }

  /** Is member m between the camera at `cam` and the fan-cam target (within ~0.45 m of the sight line)? */
  private occludesFanCam(m: Member, cam: THREE.Vector3): boolean {
    if (!this.fanCamActive || this.follow === null || m.cid === this.follow) return false;
    const target = this.members.get(this.follow);
    if (!target?.present) return false;
    const a = new THREE.Vector2(cam.x, cam.z);
    const b = new THREE.Vector2(target.hips.x, target.hips.z);
    const p = new THREE.Vector2(m.hips.x, m.hips.z);
    const ab = b.clone().sub(a);
    const len2 = ab.lengthSq();
    if (len2 < 1e-6) return false;
    const k = p.clone().sub(a).dot(ab) / len2;
    if (k <= 0 || k >= 0.97) return false; // behind the camera or behind the target
    return p.distanceTo(a.add(ab.multiplyScalar(k))) < 0.45;
  }

  setVisible(cid: number, visible: boolean) {
    const m = this.members.get(cid);
    if (m) m.visible = visible;
  }

  loadedModels(): { loaded: number; total: number; missing: number } {
    let loaded = 0, total = 0, missing = 0;
    for (const m of this.members.values()) {
      for (const c of m.costumes) {
        total++;
        const r = m.ready.get(c.costume);
        if (r) r.model ? loaded++ : missing++;
      }
    }
    return { loaded, total, missing };
  }

  private applyPose(rig: Rig, pose: Pose) {
    const { solver, nodes } = rig;
    for (const i of solver.hipsAncestors) {
      const n = nodes[i];
      if (n) {
        n.position.set(0, 0, 0);
        n.quaternion.identity();
      }
    }
    const hips = solver.av.hips;
    pose.localR.forEach((q, i) => {
      const n = nodes[i];
      if (!n || solver.hipsAncestors.has(i)) return;
      const g = toGltfQ(q);
      n.quaternion.set(g[0], g[1], g[2], g[3]);
    });
    const hn = nodes[hips];
    if (hn) {
      const t = toGltfT(pose.hipsT);
      hn.position.set(t[0], t[1], t[2]);
    }
    if (rig.model && rig.faceFollow.length) {
      rig.model.updateMatrixWorld(true);
      const world = new THREE.Quaternion();
      const parent = new THREE.Quaternion();
      for (const { face, body, offset } of rig.faceFollow) {
        body.getWorldQuaternion(world).multiply(offset);
        face.parent!.getWorldQuaternion(parent);
        face.quaternion.copy(parent.invert().multiply(world));
        face.updateMatrixWorld(true);
      }
    }
  }

  private drawSkeleton(m: Member, rig: Rig, pose: Pose, show: boolean) {
    m.skeleton.visible = show;
    if (!show) return;
    const g = rig.solver.globalPositions(pose);
    const av = rig.solver.av;
    const pts: number[] = [];
    av.nodes.forEach((nd, i) => {
      if (nd.parent < 0 || rig.solver.hipsAncestors.has(nd.parent)) return;
      const a = toGltfT(g[nd.parent]);
      const b = toGltfT(g[i]);
      pts.push(...a, ...b);
    });
    const geom = m.skeleton.geometry;
    const attr = geom.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!attr || attr.count * 3 !== pts.length) geom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    else {
      (attr.array as Float32Array).set(pts);
      attr.needsUpdate = true;
    }
    geom.computeBoundingSphere();
  }

  /**
   * Orbit the camera round the target towards the member's front. Heavily smoothed (~0.7 s time
   * constant), so a spin plays out in front of the camera instead of whipping it round.
   */
  private swingToFront(m: Member, dt: number) {
    const off = this.camera.position.clone().sub(this.controls.target);
    const r = Math.hypot(off.x, off.z);
    if (r < 1e-3) return;
    const cur = Math.atan2(off.x, off.z);
    const want = Math.atan2(m.facing.x, m.facing.z);
    let d = want - cur;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const yaw = cur + d * (1 - Math.exp(-dt / 0.7));
    this.camera.position.set(
      this.controls.target.x + Math.sin(yaw) * r,
      this.camera.position.y,
      this.controls.target.z + Math.cos(yaw) * r,
    );
  }

  /** Pose everyone for time t and render. */
  update(t: number) {
    if (this.disposed) return;
    this.store.prefetch(t);
    this.lips.prefetch(t);
    if (this.subBones) this.subs.prefetch(t);
    for (const m of this.members.values()) {
      m.drawnAlpha = 0;
      const costume = this.costumeAt(m, t);
      if (!costume) continue;
      this.loadRig(m, costume);
      const rig = m.ready.get(costume) ?? null;
      for (const r of m.ready.values()) if (r !== rig && r.model) r.model.visible = false;
      m.onStage = this.visibleAt(m, t);
      const s = m.onStage ? this.store.sample(m.cid, t, this.muscles) : null;
      m.present = !!s;
      if (!rig || !s) {
        if (rig?.model) rig.model.visible = false;
        m.skeleton.visible = false;
        continue;
      }
      const off = this.offsetAt(m, t);
      const rootT: Vec3 = off
        ? [s.pos[0] + off.dx, s.pos[1], s.pos[2] + off.dz]
        : [s.pos[0] - this.centre[0], s.pos[1], s.pos[2] - this.centre[2]];
      const pose = rig.solver.solve(s.muscles, rootT, s.rot);
      const hipsWorld = toGltfT(rootT);
      m.hips.set(hipsWorld[0], hipsWorld[1], hipsWorld[2]);
      const rq = toGltfQ(s.rot);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(rq[0], rq[1], rq[2], rq[3])).setY(0);
      if (fwd.lengthSq() > 1e-6) m.facing.copy(fwd.normalize());
      if (rig.model) {
        const alpha = this.follow !== null && m.cid !== this.follow ? this.othersOpacity : 1;
        const shown = m.visible && alpha > 0.01;
        rig.model.visible = shown;
        m.drawnAlpha = shown ? alpha : 0; // fan-cam occluders are hidden per view, in prepareView
        if (shown) {
          this.setLook(rig, this.plain, alpha);
          this.applyPose(rig, pose);
          const sb = this.subBones ? this.subs.sample(m.cid, t) : null;
          if (sb) {
            rig.sub.move.forEach((n, i) => {
              if (n) n.position.set(-sb.pos[i * 3], sb.pos[i * 3 + 1], sb.pos[i * 3 + 2]);
            });
            rig.sub.rotate.forEach((n, i) => {
              if (n) n.quaternion.set(sb.rot[i * 4], -sb.rot[i * 4 + 1], -sb.rot[i * 4 + 2], sb.rot[i * 4 + 3]);
            });
          } else {
            rig.sub.move.forEach((n, i) => n && rig.subRest.move[i] && n.position.copy(rig.subRest.move[i]!));
            rig.sub.rotate.forEach((n, i) => n && rig.subRest.rotate[i] && n.quaternion.copy(rig.subRest.rotate[i]!));
          }
          if (rig.face && this.showFaces) {
            rig.face.apply(expressionAt(this.expressions[String(m.cid)], t), this.lips.sample(m.cid, t), blinkAt(m.cid, t));
          }
        }
      }
      this.drawSkeleton(m, rig, pose, m.visible && (this.showSkeleton || !rig.model));
      m.active = rig;
    }
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.follow !== null) {
      const m = this.members.get(this.follow);
      if (m?.present) {
        const goal = new THREE.Vector3(m.hips.x, this.controls.target.y, m.hips.z);
        const delta = goal.sub(this.controls.target).multiplyScalar(0.15);
        this.controls.target.add(delta);
        this.camera.position.add(delta);
        if (this.fanCamActive && this.fanCamFacing) this.swingToFront(m, dt);
      }
    }
    this.controls.update();
    this.render();
  }
}
