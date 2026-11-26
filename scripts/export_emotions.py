#!/usr/bin/env python3
"""Export the story mode's facial expression data (Tecotec.EmotionData) from the raw game data.

`[キャラ表示 <char> <costume> emotion_<name> ...]` names the character's emotion bundle (container
`emotion_<name>`). It holds one ScriptableObject:
  TransitionTime            seconds between expressions
  BlinkData                 BlinkInterval, CloseTime, CloseStayTime, OpenFadeTime, Keys
  LipSyncData[]             per name: the blendshape for each vowel A/I/U/E/O
  LipABData[]               per name: one mouth blendshape, LipWeights steps, LipInterval
  Emotions[]                Name (as used by [キャラ表情変更]), OverrideBlink, OverrideLipSync,
                            LipSyncDataName, LipABDataName, UnuseTransition, Keys
where every key is {Name: "<Mesh>_.<Shape>", BlendShapeKeyIndex, BlendShapeValue: 0-100}.
The JSON keeps the data as Unity serializes it (field names unchanged).

Usage: uv run scripts/export_emotions.py [emotion_kaho ...] [--out public/assets/3d/emotions]
       (no names = every emotion_* container in the index)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unity_assets as UA  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INDEX = ROOT / ".inspect-tmp" / "ios_index.jsonl"
DEFAULT_OUT = ROOT / "public" / "assets" / "3d" / "emotions"


def export(index: UA.BundleIndex, name: str) -> dict:
    env = index.load_env(name)
    for obj in env.objects:
        if obj.type.name == "MonoBehaviour":
            tt = obj.read_typetree()
            if "Emotions" in tt:
                return {k: v for k, v in tt.items() if not k.startswith("m_")}
    raise ValueError(f"{name}: no EmotionData")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="*")
    ap.add_argument("--index", default=str(DEFAULT_INDEX))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()
    index = UA.BundleIndex(args.index)
    names = args.names or sorted(c for c in index.by_container if c.startswith("emotion_"))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for name in names:
        data = export(index, name)
        path = out / f"{name}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"{name}: {len(data['Emotions'])} emotions -> {path}")


if __name__ == "__main__":
    main()
