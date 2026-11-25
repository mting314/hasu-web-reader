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

  gl_FragColor = vec4(finalColor, mainCol.a);
  // ShaderMaterial gets no automatic output conversion: encode linear -> renderer.outputColorSpace
  // so toon surfaces match the built-in materials (eyes) drawn next to them.
  #include <colorspace_fragment>
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

export function createUberToonMaterial(opts: {
  mainTex: THREE.Texture;
  shadowTex?: THREE.Texture | null;
  shadow2ndTex?: THREE.Texture | null;
  params?: ToonMaterialParams | null;
}): THREE.ShaderMaterial {
  const mainTex = opts.mainTex;
  const shadowTex = opts.shadowTex || mainTex;
  const shadow2ndTex = opts.shadow2ndTex || shadowTex || mainTex;

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
      // Unity stores material colors in sRGB; the shader works in linear.
      (uniform.value as THREE.Color).setRGB(value[0], value[1], value[2], THREE.SRGBColorSpace);
    } else {
      uniform.value = value;
    }
  }
  return material;
}

export interface ExpressionPreset {
  name: string;
  description?: string;
  shapes: Record<string, number>;
}

export type LipVowel = "A" | "I" | "U" | "E" | "O";
const VOWELS: LipVowel[] = ["A", "I", "U", "E", "O"];
// Mouth families only model some vowels (e.g. Smile has A and I); fall back to the closest.
const VOWEL_FALLBACKS: Record<LipVowel, LipVowel[]> = {
  A: ["A"],
  I: ["I", "E"],
  U: ["U", "O"],
  E: ["E", "I"],
  O: ["O", "A"],
};
const LIP_VOWEL_GAIN = 0.85;

/**
 * Drives the face blendshapes: an expression layer (preset weights, eased) plus a
 * lip-sync layer on top.
 *
 * Every Mouth_* blendshape on these faces is a complete mouth pose authored against the
 * neutral mesh, so adding a vowel on top of the expression's mouth (Smile + A) stacks two
 * poses and pushes the teeth/tongue out. Instead the lip layer crossfades: the expression's
 * mouth shapes are scaled down by the speaking level while the vowel shape *of the same
 * family* (Smile -> Mouth_Smile_A / Mouth_Smile_I, Sulk -> Mouth_Sulk_*, ...) fades in.
 */
export class ExpressionController {
  private targets = new Map<string, Array<{ mesh: THREE.Mesh; index: number }>>();
  private lowerToName = new Map<string, string>();
  private current = new Map<string, number>();
  private target = new Map<string, number>();
  private lerpSpeed = 10;

  /** e.g. "Face_." - the blendshape prefix of the mesh that owns Mouth_A */
  private mouthPrefix = "Face_.";
  /** vowel -> blendshape name without mesh prefix, e.g. "Mouth_Smile_A" */
  private vowelRel: Record<LipVowel, string | null> = { A: null, I: null, U: null, E: null, O: null };
  private lipTarget = 0;
  private lipLevel = 0;
  private lipVowel: LipVowel = "A";
  private vowelMix: Record<LipVowel, number> = { A: 1, I: 0, U: 0, E: 0, O: 0 };
  private relVowelWeight = new Map<string, number>();

  constructor(root: THREE.Object3D) {
    this.scan(root);
    this.configureMouth(null);
  }

  private scan(root: THREE.Object3D) {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.morphTargetDictionary && obj.morphTargetInfluences) {
        for (const [name, index] of Object.entries(obj.morphTargetDictionary)) {
          const list = this.targets.get(name) || [];
          list.push({ mesh: obj, index });
          this.targets.set(name, list);
          this.current.set(name, 0);
          this.target.set(name, 0);
          this.lowerToName.set(name.toLowerCase(), name);
          if (name.endsWith("Mouth_A")) this.mouthPrefix = name.slice(0, -"Mouth_A".length);
        }
      }
    });
  }

  /** Exact (case-insensitive) blendshape lookup. Presets reference shapes some costumes
   * lack; those are skipped rather than guessed, since a wrong guess can bind e.g. a
   * mouth preset to an unrelated morph. */
  private resolve(name: string): string | null {
    if (this.targets.has(name)) return name;
    return this.lowerToName.get(name.toLowerCase()) ?? null;
  }

  public applyPreset(preset: ExpressionPreset | undefined) {
    for (const k of this.target.keys()) this.target.set(k, 0);
    let dominantMouth: string | null = null;
    let dominantWeight = 0;
    for (const [shapeName, rawVal] of Object.entries(preset?.shapes ?? {})) {
      const key = this.resolve(shapeName);
      if (!key) continue;
      const w = rawVal / 100;
      this.target.set(key, w);
      if (key.includes("Mouth_") && w > dominantWeight) {
        dominantMouth = key;
        dominantWeight = w;
      }
    }
    this.configureMouth(dominantMouth);
  }

  /** Pick the vowel blendshapes that belong to the expression's mouth family. */
  private configureMouth(dominantMouth: string | null) {
    let family = "";
    if (dominantMouth) {
      const tail = dominantMouth.slice(dominantMouth.indexOf("Mouth_") + "Mouth_".length);
      family = tail.split("_")[0]; // Sulk_U -> Sulk, Smile_Strong -> Smile
      if (/^[AIUEO]$/.test(family) || family === "Normal") family = "";
    }
    const exists = (rel: string) => this.resolve(this.mouthPrefix + rel) !== null;
    for (const v of VOWELS) {
      let rel: string | null = null;
      if (family) {
        for (const fv of VOWEL_FALLBACKS[v]) {
          if (exists(`Mouth_${family}_${fv}`)) {
            rel = `Mouth_${family}_${fv}`;
            break;
          }
        }
      }
      if (!rel && exists(`Mouth_${v}`)) rel = `Mouth_${v}`;
      this.vowelRel[v] = rel;
    }
  }

  /** level 0..1 (0 = not speaking), vowel = current mouth shape to aim for */
  public setLipSync(level: number, vowel: LipVowel) {
    this.lipTarget = Math.max(0, Math.min(1, level));
    this.lipVowel = vowel;
  }

  public update(dt: number) {
    const t = 1 - Math.exp(-this.lerpSpeed * dt);
    // Lip level: fast attack, slower release, so syllables read as open/close movement
    const lipRate = this.lipTarget > this.lipLevel ? 28 : 14;
    this.lipLevel += (this.lipTarget - this.lipLevel) * (1 - Math.exp(-lipRate * dt));
    const vowelRate = 1 - Math.exp(-18 * dt);
    for (const v of VOWELS) {
      this.vowelMix[v] += ((v === this.lipVowel ? 1 : 0) - this.vowelMix[v]) * vowelRate;
    }
    const lip = this.lipLevel < 0.01 ? 0 : this.lipLevel;
    this.relVowelWeight.clear();
    if (lip > 0) {
      for (const v of VOWELS) {
        const rel = this.vowelRel[v];
        if (rel) this.relVowelWeight.set(rel, (this.relVowelWeight.get(rel) ?? 0) + this.vowelMix[v]);
      }
    }

    for (const [name, entries] of this.targets) {
      const cur = this.current.get(name) ?? 0;
      const next = cur + ((this.target.get(name) ?? 0) - cur) * t;
      this.current.set(name, next);

      let out = next;
      if (lip > 0) {
        const dot = name.indexOf(".");
        const rel = dot >= 0 ? name.slice(dot + 1) : name;
        if (rel.startsWith("Mouth_")) {
          const vw = this.relVowelWeight.get(rel);
          out =
            vw !== undefined
              ? Math.max(next * (1 - lip), lip * LIP_VOWEL_GAIN * Math.min(1, vw))
              : next * (1 - lip);
        }
      }
      for (const entry of entries) {
        if (entry.mesh.morphTargetInfluences) entry.mesh.morphTargetInfluences[entry.index] = out;
      }
    }
  }
}

/**
 * Retargets skeletal animation tracks from a Link! Like! Love Live! motion GLB
 * onto a loaded character costume GLB hierarchy.
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

      if (mappedNode && costumeBones.has(mappedNode)) {
        const TrackCtor = track.constructor as new (
          name: string,
          times: ArrayLike<number>,
          values: ArrayLike<number>
        ) => THREE.KeyframeTrack;
        mappedTracks.push(new TrackCtor(`${mappedNode}${propSuffix}`, track.times, track.values));
      } else if (costumeBones.has(nodeName)) {
        mappedTracks.push(track);
      }
    }
    return new THREE.AnimationClip(clip.name, clip.duration, mappedTracks);
  });
}
