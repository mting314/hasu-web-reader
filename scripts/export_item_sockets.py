#!/usr/bin/env python3
"""Export the game's ModelSocketData assets (where `[キャラ小物表示]` attaches a hand prop) to
data_cache/item_sockets.json, so the build doesn't need the raw data.

`[キャラ小物表示 <char> <socket> <prop> <key>]` (Tecotec.CharaItemShowCommand) loads the
`Tecotec.ModelSocketData` asset named <socket> (e.g. `kaho_prv_smartphone_hand_r`): its
`Socket.TargetBone` is a transform path under the costume root
(`SCSch011KahDeA/Model/KahDeA_Reference/.../KahDeA_RHand`), plus the item's local position, euler
angles and scale there. `ModelAttachItemHandler.Attach(Transform, ModelSocketData)` (RVA 0x497A37C)
does `Find(TargetBone)`, `SetParent(bone, false)` and sets localPosition / localEulerAngles /
localScale; if the path isn't found (another costume's rig) the item isn't attached. Its
`OverrideSettings` would set a hand layer of the Animator (OverrideAnimation, RVA 0x497A728), but
only when `LayerName` is set, and it is empty in every socket the scripts use.

Usage: uv run scripts/export_item_sockets.py [--out data_cache/item_sockets.json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unity_assets as UA  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INDEX = ROOT / ".inspect-tmp" / "ios_index.jsonl"
DEFAULT_OUT = ROOT / "data_cache" / "item_sockets.json"
STORY_DIR = Path("/Users/michaelting/github/hasu-dub/story_main_txt")


def vec(d: dict) -> list[float]:
    return [round(float(d[k]), 6) for k in "xyz"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--index", default=str(DEFAULT_INDEX))
    ap.add_argument("--stories", default=str(STORY_DIR))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    names: set[str] = set()
    for path in sorted(Path(args.stories).glob("story_main_*.txt")):
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\[キャラ小物表示\s+(\S+)\s+(\S+)", line.strip())
            if m:
                names.add(m.group(2))

    index = UA.BundleIndex(args.index)
    out: dict[str, dict] = {}
    for name in sorted(names):
        if name not in index.by_container:
            print(f"  [missing] {name}")
            continue
        env, bundle = index.load_closure(name)
        for obj in env.objects:
            # the asset in the named bundle itself, not one its dependencies might also hold
            if obj.type.name != "MonoBehaviour" or obj.assets_file.parent.name != bundle:
                continue
            tt = obj.read_typetree()
            if "Socket" not in tt:
                continue
            s, o = tt["Socket"], tt["OverrideSettings"]
            out[name] = {
                "targetBone": s["TargetBone"],
                "position": vec(s["LocalPositionOffset"]),
                "rotation": vec(s["LocalRotationAngles"]),
                "scale": vec(s["LocalScale"]),
                "override": {"layer": o["LayerName"], "key": o["TriggerKey"], "value": o["TriggerValue"]},
            }
    lines = [f" {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in out.items()]
    Path(args.out).write_text("{\n" + ",\n".join(lines) + "\n}\n", encoding="utf-8")
    print(f"{len(out)} of {len(names)} sockets -> {args.out}")


if __name__ == "__main__":
    main()
