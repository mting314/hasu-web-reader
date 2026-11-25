#!/usr/bin/env python3
"""Write per-costume toon material parameters (from the game's Unity materials) next to each costume GLB.

Input:  the report.json files produced by the UnityPy model export
        (data-inspect/model-export/<model>/report.json, one per costume .fbx and face .fbx)
Output: public/assets/3d/costume/<id>/<id>_materials.json

StageCanvas loads that JSON and feeds the values into createUberToonMaterial in place of its
hard-coded defaults. Only MELPOT/Toon/UberToonShader materials are written, and only the
properties the Three.js UberToon port implements. Colors are written as stored in the Unity
material (sRGB); the renderer converts them to linear.

Usage: export_toon_materials.py <model_export_dir> <costume.glb> [<costume.glb> ...]
"""
import json
import struct
import sys
from pathlib import Path

UBER = "MELPOT/Toon/UberToonShader"
FLOATS = {
    "_1stShadowStep": "u1stShadowStep",
    "_1stShadowFather": "u1stShadowFather",
    "_2ndShadowStep": "u2ndShadowStep",
    "_2ndShadowFather": "u2ndShadowFather",
    "_ShadowBorderRange": "uShadowBorderRange",
    "_RimPower": "uRimPower",
    "_RimSmoothness": "uRimSmoothness",
    "_AmbientMode": "uAmbientMode",
}
COLORS = {
    "_1stShadowColor": "u1stShadowColor",
    "_2ndShadowColor": "u2ndShadowColor",
    "_ShadowBorderColor": "uShadowBorderColor",
    "_RimColor": "uRimColor",
    "_AmbientColor": "uAmbientColor",
}


def glb_json(path: Path) -> dict:
    d = path.read_bytes()
    return json.loads(d[20:20 + struct.unpack("<I", d[12:16])[0]])


def main():
    export_dir, glbs = Path(sys.argv[1]), [Path(p) for p in sys.argv[2:]]
    for glb in glbs:
        j = glb_json(glb)
        mat_names = [m["name"] for m in j["materials"]]
        # SCSch013TsuDeA_Cos_MT -> scsch013tsudea (costume), SCSch013Tsu_Face_MT -> scsch013tsu (face)
        codes = {n.rsplit("_", 2)[0].lower() for n in mat_names if n.endswith("_MT")}
        game = {}
        for code in codes:
            for rep in (export_dir / code / "report.json", export_dir / f"{code}_face_normal" / "report.json"):
                if rep.exists():
                    r = json.loads(rep.read_text())
                    for ren in r["renderers"]:
                        for m in ren["materials"]:
                            if m and m["shader"] == UBER:
                                game[m["name"]] = m
        out, missing = {}, []
        for name in mat_names:
            m = game.get(name)
            if m is None:
                if not any(k in name for k in ("EyeHi", "_Eye_")):
                    missing.append(name)
                continue
            tex = {k: v["texture"] for k, v in m["textures"].items()}
            uniforms = {u: m["floats"][k] for k, u in FLOATS.items() if k in m["floats"]}
            uniforms.update({u: [round(c, 4) for c in list(m["colors"][k].values())[:3]] for k, u in COLORS.items() if k in m["colors"]})
            out[name] = {
                "uniforms": uniforms,
                # texture names (= GLB image names); StageCanvas resolves them against every texture in the GLB
                "mainTex": tex.get("_MainTex"),
                "shadow1Tex": tex.get("_1stShadowTex"),
                "shadow2Tex": tex.get("_2ndShadowTex"),
                "gameTextures": {k: v for k, v in tex.items() if v},
            }
        glb_images = {im.get("name") for im in j.get("images", [])}
        for name, e in out.items():
            for slot in ("mainTex", "shadow1Tex", "shadow2Tex"):
                if e[slot] and e[slot] not in glb_images:
                    print(f"  warning: {name}.{slot} = {e[slot]} is not embedded in {glb.name}")
        dest = glb.with_name(glb.stem + "_materials.json")
        dest.write_text(json.dumps({"source": "Unity material export (UnityPy)", "shader": UBER, "materials": out}, indent=2))
        print(f"{dest}: {len(out)} materials" + (f"; no game data for {missing}" if missing else ""))


if __name__ == "__main__":
    main()
