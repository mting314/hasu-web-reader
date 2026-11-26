import * as THREE from "three";
import {
  FORWARD_FRAG,
  FORWARD_VERT,
  OUTLINE_FRAG,
  OUTLINE_VERT,
  UBER_DEFAULTS,
  UBER_UNIFORMS,
} from "./shaders/uberToonGame";

/**
 * The game's MELPOT/Toon/UberToonShader, run with its own compiled code (converted from the
 * Metal source in the bundle by scripts/msl_to_glsl.py) and each material's stored values
 * (`material.extras.unity`, written by scripts/export_costume.py).
 *
 * Unity draws two passes per renderer: "ForwardLit" (the lit surface) and "Outline" (the same
 * mesh pushed out along its normals, back faces only, tinted). Here each pass is a material; the
 * outline is a second mesh sharing the first one's geometry, skeleton and blendshape weights.
 * Every render state (cull, depth, blend, stencil, draw order) comes from the material's values
 * through the bindings in the shader's passes, e.g. the brows write stencil 201 and the hair
 * skips pixels holding 201, so brows show through the fringe.
 *
 * The game renders in gamma space: textures are sampled raw and colours used as stored.
 */

/** A material as Unity stores it (see scripts/export_costume.py). */
export interface UnityMaterial {
  shader: string | null;
  keywords: string[];
  renderQueue: number;
  floats: Record<string, number>;
  colors: Record<string, [number, number, number, number]>;
  textures: Record<string, { index: number; scale: [number, number]; offset: [number, number] }>;
}

export const UBER_TOON_SHADER = "MELPOT/Toon/UberToonShader";

/** The shader's SubShader queue tag ("Geometry"), used when a material keeps the default (-1). */
const SHADER_QUEUE = 2000;
/**
 * Characters are on layer 21, which the story renderer's ("ForwardRenderer", in the app's
 * globalgamemanagers.assets) normal opaque pass leaves out. Its CustomRenderObjects feature draws
 * that layer after opaques, opaque queues only, with the light modes [UniversalForward, Outline,
 * SRPDefaultUnlit] in one draw, so each renderer's outline follows its own lit pass. Here the
 * outline sorts after every lit pass of the same queue, which only differs in how same-queue
 * renderers interleave.
 */
const OUTLINE_ORDER_OFFSET = 0.5;
/**
 * URP sets _AlphaToMaskAvailable to 1 when the camera renders with MSAA; the app's pipeline asset
 * (UniversalRP-HighQuality) has MSAA 2x. Assumes the story camera doesn't turn MSAA off.
 */
const ALPHA_TO_MASK_AVAILABLE = 1;

// Unity enums -> three.js
const CULL = [THREE.DoubleSide, THREE.BackSide, THREE.FrontSide]; // CullMode Off, Front, Back
const DEPTH_FUNC = [
  THREE.AlwaysDepth, // Disabled
  THREE.NeverDepth,
  THREE.LessDepth,
  THREE.EqualDepth,
  THREE.LessEqualDepth,
  THREE.GreaterDepth,
  THREE.NotEqualDepth,
  THREE.GreaterEqualDepth,
  THREE.AlwaysDepth,
];
const STENCIL_FUNC = [
  THREE.AlwaysStencilFunc, // Disabled
  THREE.NeverStencilFunc,
  THREE.LessStencilFunc,
  THREE.EqualStencilFunc,
  THREE.LessEqualStencilFunc,
  THREE.GreaterStencilFunc,
  THREE.NotEqualStencilFunc,
  THREE.GreaterEqualStencilFunc,
  THREE.AlwaysStencilFunc,
];
const STENCIL_OP = [
  THREE.KeepStencilOp,
  THREE.ZeroStencilOp,
  THREE.ReplaceStencilOp,
  THREE.IncrementStencilOp,
  THREE.DecrementStencilOp,
  THREE.InvertStencilOp,
  THREE.IncrementWrapStencilOp,
  THREE.DecrementWrapStencilOp,
];
const BLEND_FACTOR = [
  THREE.ZeroFactor,
  THREE.OneFactor,
  THREE.DstColorFactor,
  THREE.SrcColorFactor,
  THREE.OneMinusDstColorFactor,
  THREE.SrcAlphaFactor,
  THREE.OneMinusSrcColorFactor,
  THREE.DstAlphaFactor,
  THREE.OneMinusDstAlphaFactor,
  THREE.SrcAlphaSaturateFactor,
  THREE.OneMinusSrcAlphaFactor,
];

/**
 * URP's per-frame globals, shared by every toon material. The reader has one directional light
 * and no additional lights or shadow maps: _AdditionalLightsCount = 0 (the per-light loop runs
 * zero times), _MainLightShadowParams.x = 0 (shadow strength 0 = fully lit, which is also what
 * the stubbed shadow lookup returns), unity_LightData.z = 1 (the main light reaches the object).
 */
export const toonGlobals: Record<string, THREE.IUniform> = {
  _MainLightPosition: { value: new THREE.Vector4(0, 1, 0, 0) },
  _MainLightColor: { value: new THREE.Vector4(1, 1, 1, 1) },
  unity_SHAr: { value: new THREE.Vector4() },
  unity_SHAg: { value: new THREE.Vector4() },
  unity_SHAb: { value: new THREE.Vector4() },
  _AlphaToMaskAvailable: { value: ALPHA_TO_MASK_AVAILABLE },
  _AdditionalLightsCount: { value: new THREE.Vector4(0, 0, 0, 0) },
  _AdditionalLightsPosition: { value: [new THREE.Vector4()] },
  _AdditionalLightsColor: { value: [new THREE.Vector4()] },
  _AdditionalLightsAttenuation: { value: [new THREE.Vector4()] },
  _AdditionalLightsSpotDir: { value: [new THREE.Vector4()] },
  _AdditionalShadowParams: { value: [new THREE.Vector4()] },
  _AdditionalShadowFadeParams: { value: new THREE.Vector4() },
  _MainLightShadowParams: { value: new THREE.Vector4(0, 0, 0, 0) },
  unity_LightData: { value: new THREE.Vector4(0, 0, 1, 0) },
  unity_LightIndices: { value: [new THREE.Vector4(), new THREE.Vector4()] },
  unity_OrthoParams: { value: new THREE.Vector4(0, 0, 0, 0) },
  unity_WorldTransformParams: { value: new THREE.Vector4(0, 0, 0, 1) },
};

/** Unity world-space vector -> the reader's world (z flipped, like every story coordinate). */
export function unityWorldToThree(v: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[1], -v[2]);
}

/**
 * Set the scene lighting the toon shader reads.
 * @param lightEulerUnity the directional light's rotation in Unity degrees (it shines along its +z)
 * @param color the light's colour × intensity, gamma values as Unity passes them
 * @param ambientSH the ambient probe's constant term per channel (unity_SHAr/g/b.w, linear)
 */
export function setToonLighting(opts: {
  lightEulerUnity: [number, number, number];
  color: [number, number, number];
  ambientSH: [number, number, number];
}) {
  const [x, y, z] = opts.lightEulerUnity.map(THREE.MathUtils.degToRad);
  // Unity applies Euler angles Z, then X, then Y
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "YXZ"));
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const toLight = unityWorldToThree([-forward.x, -forward.y, -forward.z]).normalize();
  (toonGlobals._MainLightPosition.value as THREE.Vector4).set(toLight.x, toLight.y, toLight.z, 0);
  (toonGlobals._MainLightColor.value as THREE.Vector4).set(...opts.color, 1);
  (toonGlobals.unity_SHAr.value as THREE.Vector4).set(0, 0, 0, opts.ambientSH[0]);
  (toonGlobals.unity_SHAg.value as THREE.Vector4).set(0, 0, 0, opts.ambientSH[1]);
  (toonGlobals.unity_SHAb.value as THREE.Vector4).set(0, 0, 0, opts.ambientSH[2]);
}

// Unity's built-in default textures for a slot a material leaves empty
const defaultTextures = new Map<string, THREE.DataTexture>();
function unityDefaultTexture(name: string): THREE.DataTexture {
  let tex = defaultTextures.get(name);
  if (!tex) {
    const rgba: Record<string, [number, number, number, number]> = {
      white: [255, 255, 255, 255],
      black: [0, 0, 0, 0],
      gray: [128, 128, 128, 128],
      bump: [128, 128, 255, 128],
    };
    tex = new THREE.DataTexture(new Uint8Array(rgba[name] ?? rgba.white), 1, 1);
    tex.needsUpdate = true;
    defaultTextures.set(name, tex);
  }
  return tex;
}

function uniformsFor(
  names: string[],
  unity: UnityMaterial,
  textures: Map<string, THREE.Texture>
): Record<string, THREE.IUniform> {
  const out: Record<string, THREE.IUniform> = {
    uObjectToWorld: { value: new THREE.Matrix4() },
    uWorldToObject: { value: new THREE.Matrix4() },
  };
  for (const name of names) {
    if (name in toonGlobals) {
      out[name] = toonGlobals[name];
      continue;
    }
    const [type] = UBER_UNIFORMS[name];
    const fallback = UBER_DEFAULTS[name];
    if (type === "sampler2D") {
      out[name] = { value: textures.get(name) ?? unityDefaultTexture(typeof fallback === "string" ? fallback : "white") };
    } else if (name.endsWith("_ST")) {
      const slot = unity.textures[name.slice(0, -3)];
      out[name] = {
        value: slot
          ? new THREE.Vector4(slot.scale[0], slot.scale[1], slot.offset[0], slot.offset[1])
          : new THREE.Vector4(1, 1, 0, 0),
      };
    } else if (type === "float") {
      out[name] = { value: unity.floats[name] ?? (typeof fallback === "number" ? fallback : 0) };
    } else {
      const c = unity.colors[name] ?? (Array.isArray(fallback) ? fallback : [0, 0, 0, 0]);
      if (name === "_MainLightOffset") {
        out[name] = { value: unityWorldToThree([c[0], c[1], c[2]]) }; // added to the world light direction
      } else if (name === "_SphericalNormalCorrectOrigin") {
        out[name] = { value: new THREE.Vector3(-c[0], c[1], c[2]) }; // object space, mirrored like the mesh
      } else if (type === "vec3") {
        out[name] = { value: new THREE.Vector3(c[0], c[1], c[2]) };
      } else if (type === "vec2") {
        out[name] = { value: new THREE.Vector2(c[0], c[1]) };
      } else {
        out[name] = { value: new THREE.Vector4(c[0], c[1], c[2], c[3]) };
      }
    }
  }
  return out;
}

function namesOf(src: string): string[] {
  return Object.keys(UBER_UNIFORMS).filter((n) => new RegExp(`\\b${n}\\b`).test(src));
}
// the uniforms each pass reads, worked out once (the program sources are constants)
const FORWARD_UNIFORMS = [...new Set([...namesOf(FORWARD_VERT), ...namesOf(FORWARD_FRAG)])];
const OUTLINE_UNIFORMS = [...new Set([...namesOf(OUTLINE_VERT), ...namesOf(OUTLINE_FRAG)])];

function applyStencil(m: THREE.Material, f: Record<string, number>) {
  const v = (k: string, d: number) => f[k] ?? (UBER_DEFAULTS[k] as number | undefined) ?? d;
  m.stencilWrite = true; // three.js only enables the stencil test with this set
  m.stencilRef = v("_StencilReference", 255);
  m.stencilFuncMask = v("_StencilReadMask", 255);
  m.stencilWriteMask = v("_StencilWriteMask", 255);
  m.stencilFunc = STENCIL_FUNC[v("_StencilComparison", 8)] ?? THREE.AlwaysStencilFunc;
  m.stencilZPass = STENCIL_OP[v("_StencilPassFront", 0)] ?? THREE.KeepStencilOp;
  m.stencilFail = STENCIL_OP[v("_StencilFailFront", 0)] ?? THREE.KeepStencilOp;
  m.stencilZFail = STENCIL_OP[v("_StencilZFailFront", 0)] ?? THREE.KeepStencilOp;
}

export interface GameToonPasses {
  forward: THREE.ShaderMaterial;
  outline: THREE.ShaderMaterial;
  /** Unity render queue (draw order) */
  queue: number;
}

/** Build both passes of a UberToonShader material. */
export async function createGameToonPasses(
  name: string,
  unity: UnityMaterial,
  loadTexture: (index: number) => Promise<THREE.Texture>
): Promise<GameToonPasses> {
  const textures = new Map<string, THREE.Texture>();
  await Promise.all(
    Object.entries(unity.textures).map(async ([slot, t]) => {
      const tex = await loadTexture(t.index);
      if (tex.colorSpace !== THREE.NoColorSpace) {
        tex.colorSpace = THREE.NoColorSpace; // gamma-space rendering: sample the stored values
        tex.needsUpdate = true;
      }
      textures.set(slot, tex);
    })
  );
  const f = unity.floats;
  const num = (k: string) => f[k] ?? (UBER_DEFAULTS[k] as number | undefined) ?? 0;

  // ForwardLit: Cull [_CullMode], ZWrite [_ZWriteMode], ZTest [_ZTestMode],
  // Offset [_ZFactor], [_ZUnits], stencil from the material, blend fixed at One Zero.
  const forward = new THREE.ShaderMaterial({
    name: `${name} (ForwardLit)`,
    vertexShader: FORWARD_VERT,
    fragmentShader: FORWARD_FRAG,
    uniforms: uniformsFor(FORWARD_UNIFORMS, unity, textures),
    side: CULL[num("_CullMode")] ?? THREE.FrontSide,
    depthWrite: num("_ZWriteMode") !== 0,
    depthFunc: DEPTH_FUNC[num("_ZTestMode")] ?? THREE.LessEqualDepth,
    blending: THREE.NoBlending,
    polygonOffset: num("_ZFactor") !== 0 || num("_ZUnits") !== 0,
    polygonOffsetFactor: num("_ZFactor"),
    polygonOffsetUnits: num("_ZUnits"),
  });
  applyStencil(forward, f);

  // Outline: Cull [_OutlineCullMode], ZWrite [_ZWriteMode], ZTest [_ZTestMode], stencil and
  // blend from the material.
  const src = BLEND_FACTOR[num("_BlendRGBSrc")] ?? THREE.OneFactor;
  const dst = (BLEND_FACTOR[num("_BlendRGBDst")] ?? THREE.ZeroFactor) as THREE.BlendingDstFactor;
  const srcA = BLEND_FACTOR[num("_BlendAlphaSrc")] ?? THREE.OneFactor;
  const dstA = (BLEND_FACTOR[num("_BlendAlphaDst")] ?? THREE.ZeroFactor) as THREE.BlendingDstFactor;
  const opaque = src === THREE.OneFactor && dst === THREE.ZeroFactor;
  const outline = new THREE.ShaderMaterial({
    name: `${name} (Outline)`,
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    uniforms: uniformsFor(OUTLINE_UNIFORMS, unity, textures),
    side: CULL[num("_OutlineCullMode")] ?? THREE.BackSide,
    depthWrite: num("_ZWriteMode") !== 0,
    depthFunc: DEPTH_FUNC[num("_ZTestMode")] ?? THREE.LessEqualDepth,
    blending: opaque ? THREE.NoBlending : THREE.CustomBlending,
    blendSrc: src,
    blendDst: dst,
    blendSrcAlpha: srcA,
    blendDstAlpha: dstA,
  });
  applyStencil(outline, f);
  forward.userData.unity = unity;
  outline.userData.unity = unity;

  return { forward, outline, queue: unity.renderQueue >= 0 ? unity.renderQueue : SHADER_QUEUE };
}

/** Whether a costume GLB comes from scripts/export_costume.py (its materials carry `extras.unity`). */
export function isGameCostume(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((node) => {
    const mat = (node as THREE.Mesh).isMesh ? (node as THREE.Mesh).material : null;
    if (mat && !Array.isArray(mat) && mat.userData?.unity) found = true;
  });
  return found;
}

/**
 * Set up a costume exported by scripts/export_costume.py: hide what the prefab has inactive or
 * disabled (e.g. the Loafers and the eye lens), give every UberToonShader renderer the game's two
 * passes, and order the eye materials by their render queue.
 */
export async function prepareGameCostume(
  root: THREE.Object3D,
  loadTexture: (index: number) => Promise<THREE.Texture>,
  eyeHighlightMaterial: (tex: THREE.Texture, unity: UnityMaterial) => THREE.Material
): Promise<void> {
  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => {
    if (node.userData.active === false || node.userData.rendererEnabled === false) node.visible = false;
    if ((node as THREE.Mesh).isMesh) {
      // three.js computes a skinned mesh's bounds once, from the pose it first sees; the face rig
      // is moved onto the animated body afterwards, so its bounds would go stale and cull it
      node.frustumCulled = false;
      meshes.push(node as THREE.Mesh);
    }
  });
  await Promise.all(
    meshes.map(async (mesh) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const unity = mat?.userData?.unity as UnityMaterial | undefined;
      if (!unity) return;
      // node extras sit on the mesh, or on its group when the node has several sub-meshes
      const rootBoneName = mesh.userData.rootBone ?? mesh.parent?.userData.rootBone;
      const rootBone = rootBoneName ? root.getObjectByName(rootBoneName) ?? null : null;
      const queue = unity.renderQueue >= 0 ? unity.renderQueue : SHADER_QUEUE;
      if (unity.shader === UBER_TOON_SHADER) {
        applyGameToonPasses(mesh, await createGameToonPasses(mat.name, unity, loadTexture), rootBone);
      } else if (unity.shader === "Character/ToonShader_CharacterHighlight" && mat.map) {
        mesh.material = eyeHighlightMaterial(mat.map, unity);
        applyStencil(mesh.material, unity.floats);
        mesh.renderOrder = queue;
      } else if (unity.shader === "Character/ToonShader_CharacterEye" && mat.map) {
        // TODO: port Character/ToonShader_CharacterEye; until then the iris texture unlit
        mesh.material = new THREE.MeshBasicMaterial({ map: mat.map, name: mat.name });
        applyStencil(mesh.material, unity.floats);
        mesh.renderOrder = queue;
      } else {
        mesh.visible = false;
      }
    })
  );
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/**
 * Put the two passes on a mesh: the mesh gets the lit pass, a twin mesh (same geometry, skeleton
 * and blendshape weights) the outline. `rootBone` is the renderer's root bone: Unity draws a
 * skinned mesh in that bone's space (without its scale), and the shader's object-space maths
 * (outline width, the hair's spherical normals) happens there.
 */
export function applyGameToonPasses(mesh: THREE.Mesh, passes: GameToonPasses, rootBone: THREE.Object3D | null) {
  mesh.material = passes.forward;
  mesh.renderOrder = passes.queue;
  const outline = mesh.clone(false) as THREE.Mesh;
  outline.name = `${mesh.name}__outline`;
  outline.material = passes.outline;
  outline.morphTargetInfluences = mesh.morphTargetInfluences;
  outline.renderOrder = OUTLINE_ORDER_OFFSET + passes.queue;
  outline.userData = { ...mesh.userData, toonOutlineOf: mesh.name };
  mesh.parent?.add(outline);

  const space = rootBone ?? mesh;
  const update = (_r: unknown, _s: unknown, _c: unknown, _g: unknown, material: THREE.Material) => {
    const u = (material as THREE.ShaderMaterial).uniforms;
    space.matrixWorld.decompose(_pos, _quat, _scale);
    (u.uObjectToWorld.value as THREE.Matrix4).compose(_pos, _quat, _one);
    (u.uWorldToObject.value as THREE.Matrix4).copy(u.uObjectToWorld.value).invert();
  };
  mesh.onBeforeRender = update as THREE.Object3D["onBeforeRender"];
  outline.onBeforeRender = update as THREE.Object3D["onBeforeRender"];
  return outline;
}
