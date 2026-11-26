import * as THREE from "three";
import { STENCIL_FUNC, STENCIL_OP, toonGlobals } from "../gameToonMaterial";
import {
  EYE_FRAG,
  EYE_UNIFORMS,
  EYE_VERT,
  HIGHLIGHT_FRAG,
  HIGHLIGHT_UNIFORMS,
  HIGHLIGHT_VERT,
  TOON_FRAG,
  TOON_UNIFORMS,
  TOON_VERT,
} from "../shaders/pjskToonGame";

/**
 * Cast swap: PJSK's own character shaders on the exported models. The programs are the game's
 * (scripts/pjsk_shader_to_glsl.py); this file feeds them each material's values from the GLB
 * (`material.extras.unity`) and the stage-wide `_Sekai*` globals.
 *
 * Every Toon-v3 material uses the Base pass's _LAMBERT variant for now: the face's _UseFaceSDF and
 * the hair's _HAIR_SHADOW variants read `_HeadDotDirectionalLightValues`, which the game computes
 * on the CPU in code not traced yet. The outline isn't drawn (the game draws it from extra render
 * targets in a later pass, also not traced).
 */

interface Program {
  vert: string;
  frag: string;
  uniforms: Record<string, [string, number | null]>;
}
const PROGRAMS: Record<string, Program> = {
  "Sekai/Live/Character/Toon-v3": { vert: TOON_VERT, frag: TOON_FRAG, uniforms: TOON_UNIFORMS },
  "Sekai/Live/Character/Eye-Base": { vert: EYE_VERT, frag: EYE_FRAG, uniforms: EYE_UNIFORMS },
  "Sekai/Live/Character/Eye-Highlight": { vert: HIGHLIGHT_VERT, frag: HIGHLIGHT_FRAG, uniforms: HIGHLIGHT_UNIFORMS },
};

const CHARACTER_SLOTS = 12; // the _SekaiCharacter*Array globals, indexed by the material's _CharacterId
const fill = <T>(make: () => T) => Array.from({ length: CHARACTER_SLOTS }, make);

/**
 * The game's renderer sets these per stage (light direction, shadow colour, per-character ambient,
 * rim and specular). Story mode has no PJSK stage, so they're neutral: the light is the story's own
 * directional light (shared with the Hasu toon shader), ambient 0.5 grey (the shaders blend ambient
 * as an overlay, so 0.5 leaves colours as they are), white shadow tint, no rim, no fog or spot light.
 * The shadow threshold (0.40625) and specular colour follow Cleista's PJSK stage defaults until the
 * game's own character light data is found.
 */
const sekaiGlobals: Record<string, THREE.IUniform> = {
  _SekaiDirectionalLight: toonGlobals._MainLightPosition,
  _SekaiShadowColor: { value: new THREE.Vector4(1, 1, 1, 1) },
  _SekaiShadowThreshold: { value: 0.40625 },
  _SekaiAllLightIntensity: { value: 1 },
  _SekaiCharacterAmbientLightIntensityArray: { value: fill(() => 1) },
  _SekaiCharacterAmbientLightColorArray: { value: fill(() => new THREE.Vector4(0.5, 0.5, 0.5, 1)) },
  _SekaiCharacterSpecularColorArray: { value: fill(() => new THREE.Vector4(1, 1, 1, 1)) },
  _SekaiRimLightArray: { value: fill(() => new THREE.Vector4(0, 0, 1, 0)) },
  _SekaiRimLightColorArray: { value: fill(() => new THREE.Vector4(1, 1, 1, 0)) },
  _SekaiShadowRimLightColorArray: { value: fill(() => new THREE.Vector4(0, 0, 0, 0)) },
  _SekaiRimLightFactor: { value: fill(() => new THREE.Vector4(9, 0, 1, 0)) },
  _SekaiRimLightShadowSharpnessArray: { value: fill(() => 0.5) },
  _SekaiGlobalSpotLightEnabled: { value: 0 },
  _SekaiGlobalSpotLightPos: { value: new THREE.Vector3() },
  _SekaiGlobalSpotLightColor: { value: new THREE.Vector4() },
  _SekaiGlobalSpotLightRadiusNear: { value: 0 },
  _SekaiGlobalSpotLightRadiusFar: { value: 1 },
  _SekaiFogColor: { value: new THREE.Vector4(0, 0, 0, 0) },
  _SekaiFogFactor: { value: new THREE.Vector2(1, 0) },
  _SekaiGlobalEyeTime: { value: 0 },
  _GlobalMipBias: { value: new THREE.Vector2(0, 0) },
  _CoCParams: { value: new THREE.Vector4(0, 0, 0, 0) },
  unity_OrthoParams: { value: new THREE.Vector4(0, 0, 0, 0) },
};

/** Set the eye-distortion clock (`_SekaiGlobalEyeTime`, seconds). */
export function setPjskShaderTime(seconds: number) {
  sekaiGlobals._SekaiGlobalEyeTime.value = seconds;
}

interface UnityTexture {
  index: number;
  scale: [number, number];
  offset: [number, number];
}
interface UnityMaterial {
  shader: string;
  renderQueue: number;
  floats: Record<string, number>;
  colors: Record<string, [number, number, number, number]>;
  textures: Record<string, UnityTexture>;
}

// Unity's default texture per property (the shaders' Properties blocks)
const DEFAULT_TEXTURE: Record<string, [number, number, number, number]> = {
  _ValueTex: [0, 0, 0, 0],
  _DistortionTex: [128, 128, 128, 128],
};
const defaults = new Map<string, THREE.DataTexture>();
function defaultTexture(slot: string) {
  const rgba = DEFAULT_TEXTURE[slot] ?? [255, 255, 255, 255];
  const key = rgba.join(",");
  let t = defaults.get(key);
  if (!t) {
    t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
    t.needsUpdate = true;
    defaults.set(key, t);
  }
  return t;
}

/** Per model: its face direction (`_FaceFront`, for the eyelash fade), updated each frame. */
export interface PjskShaderState {
  faceFront: THREE.Vector3;
}

async function createMaterial(
  unity: UnityMaterial,
  program: Program,
  geometry: THREE.BufferGeometry,
  loadTexture: (index: number) => Promise<THREE.Texture>,
  state: PjskShaderState
): Promise<THREE.ShaderMaterial> {
  const uniforms: Record<string, THREE.IUniform> = {};
  for (const [name, [type]] of Object.entries(program.uniforms)) {
    if (name in sekaiGlobals) {
      uniforms[name] = sekaiGlobals[name];
    } else if (type === "sampler2D") {
      const t = unity.textures[name];
      let tex: THREE.Texture = defaultTexture(name);
      if (t) {
        tex = await loadTexture(t.index);
        tex.colorSpace = THREE.NoColorSpace; // gamma-space rendering: sample the stored values
        tex.needsUpdate = true;
      }
      uniforms[name] = { value: tex };
    } else if (name.endsWith("_ST")) {
      const t = unity.textures[name.slice(0, -3)];
      uniforms[name] = { value: new THREE.Vector4(...(t?.scale ?? [1, 1]), ...(t?.offset ?? [0, 0])) };
    } else if (name === "_FaceFront") {
      uniforms[name] = { value: state.faceFront };
    } else if (name === "_ProjectionParams") {
      uniforms[name] = { value: new THREE.Vector4(1, 0.1, 100, 0.01) };
    } else if (type.startsWith("vec")) {
      const c = unity.colors[name] ?? [0, 0, 0, 0];
      uniforms[name] =
        type === "vec4"
          ? { value: new THREE.Vector4(...c) }
          : type === "vec3"
            ? { value: new THREE.Vector3(c[0], c[1], c[2]) }
            : { value: new THREE.Vector2(c[0], c[1]) };
    } else {
      uniforms[name] = { value: unity.floats[name] ?? 0 };
    }
  }
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: program.vert,
    fragmentShader: program.frag,
    uniforms,
    vertexColors: !!geometry.getAttribute("color"),
  });
  if (geometry.getAttribute("uv1")) m.defines = { USE_UV1: "" };
  // Stencil [_Stencil] ReadMask [_ReadMask] WriteMask [_WriteMask] Comp [_StencilComp] Pass [_StencilOp] …
  const f = unity.floats;
  m.stencilWrite = true; // three.js only runs the stencil test with this set
  m.stencilRef = f._Stencil ?? 0;
  m.stencilFuncMask = f._ReadMask ?? 255;
  m.stencilWriteMask = f._WriteMask ?? 255;
  m.stencilFunc = STENCIL_FUNC[f._StencilComp ?? 8] ?? THREE.AlwaysStencilFunc;
  m.stencilZPass = STENCIL_OP[f._StencilOp ?? 0] ?? THREE.KeepStencilOp;
  m.stencilFail = STENCIL_OP[f._StencilFail ?? 0] ?? THREE.KeepStencilOp;
  m.stencilZFail = STENCIL_OP[f._StencilZFail ?? 0] ?? THREE.KeepStencilOp;
  return m;
}

const _proj = new THREE.Vector4();

/**
 * Replace a PJSK model's materials with the game's shaders. Returns false (leaving the model
 * alone) when a material isn't one of the converted shaders.
 */
export async function preparePjskShaders(
  scene: THREE.Object3D,
  loadTexture: (index: number) => Promise<THREE.Texture>,
  state: PjskShaderState
): Promise<void> {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((n) => {
    if ((n as THREE.Mesh).isMesh) meshes.push(n as THREE.Mesh);
  });
  await Promise.all(
    meshes.map(async (mesh) => {
      mesh.frustumCulled = false;
      const unity = (mesh.material as THREE.Material).userData?.unity as UnityMaterial | undefined;
      const program = unity && PROGRAMS[unity.shader];
      if (!unity || !program) return;
      mesh.material = await createMaterial(unity, program, mesh.geometry, loadTexture, state);
      mesh.renderOrder = unity.renderQueue >= 0 ? unity.renderQueue : 2000;
      mesh.onBeforeRender = (_r, _s, camera, _g, material) => {
        const u = (material as THREE.ShaderMaterial).uniforms._ProjectionParams;
        const cam = camera as THREE.PerspectiveCamera;
        if (u) (u.value as THREE.Vector4).copy(_proj.set(1, cam.near, cam.far, 1 / cam.far));
      };
    })
  );
}
