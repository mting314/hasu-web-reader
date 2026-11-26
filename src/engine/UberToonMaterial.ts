import * as THREE from "three";

const UBER_TOON_VERTEX = /* glsl */ `
#include <common>
#include <uv_pars_vertex>
#include <skinning_pars_vertex>
#include <morphtarget_pars_vertex>

varying vec3 vNormalWS;
varying vec3 vPositionWS;
varying vec3 vViewDirWS;
varying vec2 vUv;
varying vec3 vNormalVS;

void main() {
  vUv = uv;

  #include <skinbase_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>

  vNormalWS = normalize(transformedNormal);

  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>

  vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
  vPositionWS = worldPos.xyz;
  vViewDirWS = cameraPosition - worldPos.xyz;
  vNormalVS = normalize((viewMatrix * vec4(vNormalWS, 0.0)).xyz);
}
`;

const UBER_TOON_FRAGMENT = /* glsl */ `
#include <common>

uniform sampler2D uMainTex;
uniform sampler2D uShadowTex;
uniform sampler2D uShadow2ndTex;
uniform float u1stShadowStep;
uniform float u1stShadowFather;
uniform float u2ndShadowStep;
uniform float u2ndShadowFather;
uniform vec3 u1stShadowColor;
uniform vec3 u2ndShadowColor;
uniform vec3 uShadowBorderColor;
uniform float uShadowBorderRange;
uniform vec3 uRimColor;
uniform float uRimPower;
uniform float uRimSmoothness;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;
uniform float uAmbientMode;

varying vec3 vNormalWS;
varying vec3 vPositionWS;
varying vec3 vViewDirWS;
varying vec2 vUv;
varying vec3 vNormalVS;

float smoothstepFeather(float edge0, float edge1, float x) {
  float t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  vec3 normal = normalize(vNormalWS);
  vec3 viewDir = normalize(vViewDirWS);
  vec3 lightDir = normalize(uLightDir);

  vec4 mainCol = texture2D(uMainTex, vUv);
  vec3 shadow1Col = texture2D(uShadowTex, vUv).rgb * u1stShadowColor;
  vec3 shadow2Col = texture2D(uShadow2ndTex, vUv).rgb * u2ndShadowColor;

  float NdotL = dot(lightDir, normal);

  float thresh2 = (u2ndShadowStep + 1.0) * (u1stShadowStep + 1.0) * 0.5 - 1.0;
  float s2 = smoothstepFeather(thresh2 - u2ndShadowFather, thresh2 + u2ndShadowFather, NdotL);

  float thresh1Lo = u1stShadowStep - u1stShadowFather;
  float thresh1Hi = u1stShadowStep + u1stShadowFather;
  float s1 = smoothstepFeather(thresh1Lo, thresh1Hi, NdotL);

  float borderThreshLo = u1stShadowStep - u1stShadowFather - uShadowBorderRange;
  float borderThreshHi = u1stShadowStep + u1stShadowFather;
  float borderShadow = smoothstepFeather(borderThreshLo, borderThreshHi, NdotL);
  float borderFactor = min(abs(s1 - borderShadow), 1.0);

  vec3 mainColor = mainCol.rgb;
  vec3 shadowBlend = mix(shadow2Col, shadow1Col, s2);
  shadowBlend += borderFactor * uShadowBorderColor * (mainColor - shadowBlend);
  vec3 shadedColor = mix(shadowBlend, mainColor, s1);

  float NdotV = clamp(dot(viewDir, normal), 0.0, 1.0);
  float rim = pow(1.0 - NdotV, uRimPower);
  float rimLo = uRimSmoothness * -0.499 + 0.499;
  float rimHi = uRimSmoothness *  0.499 + 0.501;
  rim = smoothstepFeather(rimLo, rimHi, rim);
  vec3 rimResult = rim * uRimColor * s1;

  vec3 litColor = shadedColor * uLightColor;
  vec3 finalColor = (uAmbientMode > 0.5 ? (litColor + uAmbientColor) : (litColor * uAmbientColor)) + rimResult;
  finalColor = max(finalColor, vec3(0.00001));

  // The game renders in gamma space (its URP shaders convert the ambient SH term to sRGB, which
  // URP only compiles in for Gamma projects): textures are sampled raw, the shading math runs on
  // gamma values and the result is written as is. So no output encoding here.
  gl_FragColor = vec4(finalColor, mainCol.a);
}
`;

/** Per-material values exported from the game's UberToonShader materials
 * (`<costume>_materials.json`, written by scripts/export_toon_materials.py).
 * Keys are this shader's uniform names; colors are sRGB [r, g, b] as stored in Unity. */
export interface ToonMaterialParams {
  uniforms: Record<string, number | [number, number, number]>;
  mainTex?: string | null;
  shadow1Tex?: string | null;
  shadow2Tex?: string | null;
}

/**
 * The game's eye highlight (`Character/ToonShader_CharacterHighlight`): the texture colour times
 * the material colour and light, drawn opaque where its luminance reaches the clip threshold
 * (alpha-to-coverage softens the edge), not blended on top.
 */
const EYE_HIGHLIGHT_FRAGMENT = /* glsl */ `
uniform sampler2D uMainTex;
uniform vec3 uMainColor;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;
uniform float uAmbientMode;
uniform float uClip;
varying vec2 vUv;

void main() {
  vec3 col = texture2D(uMainTex, vUv).rgb * uMainColor;
  float lum = dot(col, vec3(0.212672904, 0.715152204, 0.0721750036));
  float w = max(fwidth(lum), 0.0001);
  float coverage = clamp((lum - uClip) / w + 0.5, 0.0, 1.0);
  if (coverage <= 0.0) discard;
  vec3 lit = col * uLightColor;
  gl_FragColor = vec4(uAmbientMode > 0.5 ? lit + uAmbientColor : lit * uAmbientColor, coverage);
}
`;

/** Gamma-space rendering: sample a texture's stored values without sRGB decoding. */
function useRaw(tex: THREE.Texture | null | undefined) {
  if (tex && tex.colorSpace !== THREE.NoColorSpace) {
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
  }
}

export function createEyeHighlightMaterial(tex: THREE.Texture, opts?: { color?: [number, number, number]; clip?: number }) {
  useRaw(tex);
  const color = opts?.color ?? [1, 1, 1];
  return new THREE.ShaderMaterial({
    vertexShader: UBER_TOON_VERTEX,
    fragmentShader: EYE_HIGHLIGHT_FRAGMENT,
    uniforms: {
      uMainTex: { value: tex },
      uMainColor: { value: new THREE.Color().setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace) },
      uLightColor: { value: new THREE.Color(1, 1, 1) },
      uAmbientColor: { value: new THREE.Color(1, 1, 1) },
      uAmbientMode: { value: 0 },
      uClip: { value: opts?.clip ?? 0.5 },
    },
    alphaToCoverage: true,
  });
}

export function createUberToonMaterial(opts: {
  mainTex: THREE.Texture;
  shadowTex?: THREE.Texture | null;
  shadow2ndTex?: THREE.Texture | null;
  params?: ToonMaterialParams | null;
}): THREE.ShaderMaterial {
  const mainTex = opts.mainTex;
  const shadowTex = opts.shadowTex || mainTex;
  const shadow2ndTex = opts.shadow2ndTex || shadowTex || mainTex;
  [mainTex, shadowTex, shadow2ndTex].forEach(useRaw);

  const material = new THREE.ShaderMaterial({
    vertexShader: UBER_TOON_VERTEX,
    fragmentShader: UBER_TOON_FRAGMENT,
    uniforms: {
      uMainTex: { value: mainTex },
      uShadowTex: { value: shadowTex },
      uShadow2ndTex: { value: shadow2ndTex },
      u1stShadowStep: { value: 0.0 },
      u1stShadowFather: { value: 0.3 },
      u2ndShadowStep: { value: -0.5 },
      u2ndShadowFather: { value: 0.1 },
      u1stShadowColor: { value: new THREE.Color(1, 1, 1) },
      u2ndShadowColor: { value: new THREE.Color(0.82, 0.82, 0.85) },
      uShadowBorderColor: { value: new THREE.Color(1, 0.95, 0.9) },
      uShadowBorderRange: { value: 0.05 },
      uRimColor: { value: new THREE.Color(0.08, 0.08, 0.1) },
      uRimPower: { value: 10.0 },
      uRimSmoothness: { value: 1.0 },
      uLightDir: { value: new THREE.Vector3(0.3, 1.0, 0.5).normalize() },
      uLightColor: { value: new THREE.Color(1, 1, 1) },
      uAmbientColor: { value: new THREE.Color(1, 1, 1) },
      uAmbientMode: { value: 0.0 },
    },
    side: THREE.FrontSide,
    transparent: false,
  });

  for (const [name, value] of Object.entries(opts.params?.uniforms ?? {})) {
    const uniform = material.uniforms[name];
    if (!uniform) continue;
    if (Array.isArray(value)) {
      // Gamma-space rendering, like the game: use the stored colour values as they are.
      (uniform.value as THREE.Color).setRGB(value[0], value[1], value[2], THREE.LinearSRGBColorSpace);
    } else {
      uniform.value = value;
    }
  }
  return material;
}

/**
 * Height of the model's `*_Hips` bone above its root in the rest pose. The first call caches it
 * in `root.userData`, so call it on a costume before any animation moves the hips.
 */
export function restHipsHeight(root: THREE.Object3D): number | null {
  const cached = root.userData.restHipsHeight;
  if (typeof cached === "number") return cached;
  const found: THREE.Object3D[] = [];
  root.traverse((obj) => {
    if (obj.name.endsWith("_Hips")) found.push(obj);
  });
  if (!found.length) return null;
  root.updateWorldMatrix(true, true);
  const height = root.worldToLocal(found[0].getWorldPosition(new THREE.Vector3())).y;
  root.userData.restHipsHeight = height;
  return height;
}

/**
 * Retargets skeletal animation tracks from a Link! Like! Love Live! motion GLB
 * onto a loaded character costume GLB hierarchy.
 *
 * Motions are baked on one reference rig (Kaho's). Bone rotations carry over by name; the hips
 * translation is scaled by the ratio of rest hip heights, because the game solves each motion
 * on the character's own Avatar and scales root motion by its body size. Without that, Kozue
 * stands 10.5 cm too low (feet through the floor); with it, every character's hands, feet and
 * head land within about 1 cm of a per-character solve.
 */
export function retargetMotionClips(
  motionScene: THREE.Object3D,
  animations: THREE.AnimationClip[],
  costumeRoot: THREE.Object3D
): THREE.AnimationClip[] {
  let motionPrefix = "";
  motionScene.traverse((obj) => {
    if (obj.name && obj.name.endsWith("_Hips") && !motionPrefix) {
      motionPrefix = obj.name.slice(0, obj.name.indexOf("_Hips"));
    }
  });

  let costumePrefix = "";
  const costumeBones = new Set<string>();
  costumeRoot.traverse((obj) => {
    if ((obj as THREE.Bone).isBone || obj.type === "Bone") {
      costumeBones.add(obj.name);
      if (obj.name.endsWith("_Hips") && !costumePrefix) {
        costumePrefix = obj.name.slice(0, obj.name.indexOf("_Hips"));
      }
    }
  });

  const getShortPrefix = (prefix: string) => {
    for (let i = 1; i < prefix.length; i++) {
      if (prefix[i] >= "A" && prefix[i] <= "Z") {
        return prefix.slice(0, i);
      }
    }
    return prefix;
  };

  const motionShort = getShortPrefix(motionPrefix);
  const costumeShort = getShortPrefix(costumePrefix);

  const motionHips = restHipsHeight(motionScene);
  const costumeHips = restHipsHeight(costumeRoot);
  const hipsScale = motionHips && costumeHips ? costumeHips / motionHips : 1;

  return animations.map((clip) => {
    const mappedTracks: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const [nodeName, ...propParts] = track.name.split(".");
      const propSuffix = "." + propParts.join(".");
      let mappedNode = "";

      if (motionPrefix && nodeName.startsWith(motionPrefix + "_")) {
        const boneSuffix = nodeName.substring(motionPrefix.length + 1);
        if (
          motionPrefix !== costumePrefix &&
          (boneSuffix.startsWith("SP_") || boneSuffix.startsWith("Hair"))
        ) {
          continue;
        }
        mappedNode = costumePrefix + nodeName.substring(motionPrefix.length);
      } else if (
        motionShort &&
        nodeName.startsWith(motionShort + "_") &&
        motionPrefix === costumePrefix
      ) {
        mappedNode = costumeShort + nodeName.substring(motionShort.length);
      }

      const target =
        mappedNode && costumeBones.has(mappedNode) ? mappedNode : costumeBones.has(nodeName) ? nodeName : "";
      if (!target) continue;
      const scaleHips = hipsScale !== 1 && target.endsWith("_Hips") && propSuffix === ".position";
      if (target === nodeName && !scaleHips) {
        mappedTracks.push(track);
        continue;
      }
      const TrackCtor = track.constructor as new (
        name: string,
        times: ArrayLike<number>,
        values: ArrayLike<number>
      ) => THREE.KeyframeTrack;
      const values = scaleHips ? Float32Array.from(track.values, (v) => v * hipsScale) : track.values;
      mappedTracks.push(new TrackCtor(`${target}${propSuffix}`, track.times, values));
    }
    return new THREE.AnimationClip(clip.name, clip.duration, mappedTracks);
  });
}
