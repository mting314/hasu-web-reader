#!/usr/bin/env python3
"""Read Project Sekai's Vulkan shader programs: SMOL-V -> SPIR-V -> readable disassembly.

Some PJSK passes only ship a Vulkan program (Toon-v3's Outline pass has no GLES3 variant), and
Unity stores Vulkan programs as SMOL-V-compressed SPIR-V. The canonical tools (aras-p/smol-v,
SPIRV-Cross / spirv-dis) are C++, and this machine refuses to run locally built binaries, so:
  - `smolv_decode` is a line-by-line port of smol-v's `smolv::Decode` (MIT, Aras Pranckevičius,
    https://github.com/aras-p/smol-v, encoding versions 0 and 1); its per-opcode table
    `_OP_DATA` was extracted from smolv.cpp's kSpirvOpData, not retyped. The decoder checks its
    output the same way smol-v does (exact decoded size from the header).
  - `disassemble` prints SPIR-V using Khronos's machine-readable grammar
    (SPIRV-Headers spirv.core.grammar.json + extinst.glsl.std.450.grammar.json), with OpName
    names substituted for ids.

A Unity Vulkan program entry (shader blob, platform 18) starts with a 0x20-byte header whose
words 9..12 are (offset, size) pairs of the two stage streams relative to 0x20.

Usage:
  uv run python -I scripts/pjsk_spirv.py <shader bundle> <shader name> <pass> [keyword ...]
      --grammar-dir DIR [--out DIR]
"""
from __future__ import annotations

import argparse
import json
import struct
import warnings
from pathlib import Path

# kSpirvOpData from smolv.cpp: per opcode (hasResult, hasType, deltaFromResult, varrest)
_OP_DATA = (
    "0000110000000001000000000000000000011100000010001101112100010001000100011100100110011001"
    "1001100110011001100110011001100110011001100110011001100110011001100100011100110011001100"
    "1190110111001100110011001100119011001100110111000000119011001101110011110021000000001101"
    "1100110011001100110000010001100000000000110011111121112111901111112111101100110011001121"
    "1121113111311121112111311131112111311131112100311110111011101120111011201110111011001110"
    "1110111011101110111011101110111011101110111011101110111111101100111011101120112011201120"
    "1120112011201120112011201120112011201120112011201120112011201120112011201120112011201100"
    "1110111011101110111011101110112011201120112011201120112011101130112011201120112011201120"
    "1120112011201120112011201120112011201120112011201120112011201120110011001120112011201120"
    "1120112011101140113011301110111011001100110011001100110011001100110011001100110000000000"
    "0000000011001100003000201100110000001100110011001100110011001100110011001100110011001100"
    "1100110011001100002100111000001000310000000000000000000000000000110011000000110011001100"
    "1100110011001100110011001100110011001100110011001100110011001100000000001100110011001100"
    "1100000000001100110011001100110011001100110000000000110011000000000011001100112111211131"
    "1131112111211131113111211131113111100000110000001100110011001100110011001100110011010021"
    "1100000100011111111111111111111111111111111111111111111111111111111111111111111111111111"
    "111111111111111111111111111111111111111111111111111111111111"
)

SPIRV_MAGIC = 0x07230203
SMOL_MAGIC = 0x534D4F4C
OP = {"Nop": 0, "Undef": 1, "SourceContinued": 2, "Source": 3, "SourceExtension": 4, "Name": 5,
      "MemberName": 6, "String": 7, "Line": 8, "Extension": 10, "ExtInstImport": 11,
      "VectorShuffleCompact": 13, "MemoryModel": 14, "EntryPoint": 15, "TypePointer": 32,
      "Variable": 59, "Load": 61, "Store": 62, "AccessChain": 65, "Decorate": 71, "MemberDecorate": 72,
      "VectorShuffle": 79, "FNegate": 127, "FAdd": 129, "FMul": 133, "Label": 248,
      "ControlBarrier": 224, "MemoryBarrier": 225, "LoopMerge": 246, "SelectionMerge": 247,
      "Branch": 249, "BranchConditional": 250, "MemoryNamedBarrier": 329, "ModuleProcessed": 330,
      "GroupNonUniformQuadSwap": 366}


_OPS = _OP_DATA


def _known_ops(version: int) -> int:
    return OP["ModuleProcessed"] + 1 if version == 0 else OP["GroupNonUniformQuadSwap"] + 1 if version == 1 else 0


def _flag(op: int, i: int, count: int) -> int:
    return int(_OPS[op * 4 + i]) if 0 <= op < count else 0


_SWAPS = [("Decorate", "Nop"), ("Load", "Undef"), ("Store", "SourceContinued"), ("AccessChain", "Source"),
          ("VectorShuffle", "SourceExtension"), ("MemberDecorate", "String"), ("Label", "Line"),
          ("Variable", None), ("FMul", "Extension"), ("FAdd", "ExtInstImport"), ("TypePointer", "MemoryModel"),
          ("FNegate", "EntryPoint")]


def _remap(op: int) -> int:
    for a, b in _SWAPS:
        x, y = OP[a], (9 if b is None else OP[b])
        if op == x:
            return y
        if op == y:
            return x
    return op


def _decode_len(op: int, n: int) -> int:
    n += 1
    if op in (OP["VectorShuffle"], OP["VectorShuffleCompact"]):
        n += 4
    if op == OP["Decorate"]:
        n += 2
    if op in (OP["Load"], OP["AccessChain"]):
        n += 3
    return n


def _zig(u: int) -> int:
    return ((u >> 1) ^ 0xFFFFFFFF) if (u & 1) else (u >> 1)


def _deco_extra(dec: int) -> int:
    if dec == 0 or 2 <= dec <= 5:
        return 0
    if 29 <= dec <= 37:
        return 1
    return -1


def smolv_decode(data: bytes) -> bytes:
    """smolv::Decode (encoding versions 0 and 1; the 2016 'before zero' flag is not supported)."""
    words = struct.unpack_from("<6I", data, 0)
    if words[0] != SMOL_MAGIC or len(data) < 24:
        raise ValueError("not a SMOL-V stream")
    version = words[1] >> 24
    if version > 1:
        raise ValueError(f"unsupported SMOL-V version {version}")
    size = words[5]
    count = _known_ops(version)
    out: list[int] = [SPIRV_MAGIC, words[1] & 0x00FFFFFF, words[2], words[3], words[4]]
    pos, end = 24, len(data)

    def varint() -> int:
        nonlocal pos
        v = shift = 0
        while pos < end:
            b = data[pos]
            pos += 1
            v |= (b & 127) << shift
            shift += 7
            if not b & 128:
                break
        return v & 0xFFFFFFFF

    def read4() -> int:
        nonlocal pos
        v = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        return v

    prev_result = prev_decorate = 0
    while pos < end:
        val = varint()
        n = ((val >> 20) << 4) | ((val >> 4) & 0xF)
        op = _remap(((val >> 4) & 0xFFF0) | (val & 0xF))
        n = _decode_len(op, n)
        swizzle = op == OP["VectorShuffleCompact"]
        if swizzle:
            op = OP["VectorShuffle"]
        out.append((n << 16) | op)
        ioffs = 1
        if _flag(op, 1, count):  # type
            out.append(varint())
            ioffs += 1
        if _flag(op, 0, count):  # result
            prev_result = (prev_result + _zig(varint())) & 0xFFFFFFFF
            out.append(prev_result)
            ioffs += 1
        if op in (OP["Decorate"], OP["MemberDecorate"]):
            prev_decorate = (prev_decorate + _zig(varint())) & 0xFFFFFFFF
            out.append(prev_decorate)
            ioffs += 1
        if op == OP["MemberDecorate"]:
            members = data[pos]
            pos += 1
            prev_index = prev_offset = 0
            for m in range(members):
                index = varint() + prev_index
                prev_index = index
                dec = varint()
                extra = _deco_extra(dec)
                mlen = varint() + 4 if extra == -1 else 4 + extra
                if m:
                    out += [(mlen << 16) | op, prev_decorate]
                out += [index, dec]
                if dec == 35:  # Offset
                    prev_offset = varint() + prev_offset
                    out.append(prev_offset)
                else:
                    out += [varint() for _ in range(4, mlen)]
            continue
        for _ in range(_flag(op, 2, count)):  # ids relative to the result
            if ioffs >= n:
                break
            out.append((prev_result - _zig(varint())) & 0xFFFFFFFF)
            ioffs += 1
        if swizzle and n <= 9:
            s = data[pos]
            pos += 1
            out += [(s >> sh) & 3 for k, sh in ((5, 6), (6, 4), (7, 2), (8, 0)) if n > k]
        elif _flag(op, 3, count):
            out += [varint() for _ in range(ioffs, n)]
        else:
            out += [read4() for _ in range(ioffs, n)]
    spirv = struct.pack(f"<{len(out)}I", *out)
    if len(spirv) != size:
        raise ValueError(f"decoded {len(spirv)} bytes, header says {size}")
    return spirv


class Grammar:
    def __init__(self, directory: Path):
        core = json.loads((directory / "spirv.core.grammar.json").read_text())
        self.ops = {i["opcode"]: i for i in core["instructions"]}
        self.kinds = {k["kind"]: k for k in core["operand_kinds"]}
        glsl = json.loads((directory / "extinst.glsl.std.450.grammar.json").read_text())
        self.glsl = {i["opcode"]: i["opname"] for i in glsl["instructions"]}


def disassemble(spirv: bytes, g: Grammar) -> str:
    words = struct.unpack(f"<{len(spirv) // 4}I", spirv)
    if words[0] != SPIRV_MAGIC:
        raise ValueError("not SPIR-V")
    names: dict[int, str] = {}
    float_types: set[int] = set()
    insts = []
    i = 5
    while i < len(words):
        n, op = words[i] >> 16, words[i] & 0xFFFF
        insts.append((op, words[i + 1:i + n]))
        i += n
    for op, ops in insts:  # names first
        if op == OP["Name"]:
            raw = struct.pack(f"<{len(ops) - 1}I", *ops[1:])
            names[ops[0]] = raw.split(b"\0")[0].decode(errors="replace")
        elif op == 22:  # OpTypeFloat
            float_types.add(ops[0])
    ref = lambda x: f"%{names.get(x, x)}"  # noqa: E731
    lines = []
    for op, ops in insts:
        info = g.ops.get(op)
        if info is None:
            lines.append(f"Op{op} {list(ops)}")
            continue
        out, res, k = [], None, 0
        result_type = None
        for spec in info.get("operands", []):
            kind, quant = spec["kind"], spec.get("quantifier")
            reps = 0
            while k < len(ops) and (quant == "*" or reps == 0):
                reps += 1
                if kind == "IdResult":
                    res = ref(ops[k]); k += 1
                elif kind == "IdResultType":
                    result_type = ops[k]; out.append(ref(ops[k])); k += 1
                elif kind in ("IdRef", "IdScope", "IdMemorySemantics"):
                    out.append(ref(ops[k])); k += 1
                elif kind == "LiteralString":
                    raw = b""
                    while k < len(ops):
                        raw += struct.pack("<I", ops[k]); k += 1
                        if b"\0" in raw[-4:]:
                            break
                    out.append(json.dumps(raw.split(b"\0")[0].decode(errors="replace")))
                elif kind == "LiteralContextDependentNumber":
                    w = ops[k]; k += 1
                    out.append(f"{struct.unpack('<f', struct.pack('<I', w))[0]:.9g}" if result_type in float_types else str(w))
                elif kind == "LiteralExtInstInteger":
                    out.append(g.glsl.get(ops[k], str(ops[k]))); k += 1
                elif kind.startswith("Pair"):
                    out.append(f"{ops[k]} {ops[k + 1]}"); k += 2
                elif kind in g.kinds and g.kinds[kind]["category"] in ("ValueEnum", "BitEnum"):
                    kd = g.kinds[kind]
                    v = ops[k]; k += 1
                    if kd["category"] == "ValueEnum":
                        e = next((x for x in kd["enumerants"] if x["value"] == v), None)
                        out.append(e["enumerant"] if e else str(v))
                        for p in (e or {}).get("parameters", []):
                            if k < len(ops):
                                out.append(ref(ops[k]) if p["kind"].startswith("Id") else str(ops[k])); k += 1
                    else:
                        flags = [x["enumerant"] for x in kd["enumerants"] if isinstance(x["value"], str) and int(x["value"], 16) & v]
                        out.append("|".join(flags) or "None")
                else:
                    out.append(str(ops[k])); k += 1
                if quant == "?":
                    break
        out += [str(x) for x in ops[k:]]
        lines.append((f"{res} = " if res else "") + info["opname"] + (" " + " ".join(out) if out else ""))
    return "\n".join(lines)


def unity_vulkan_streams(entry: bytes) -> list[bytes]:
    """The SMOL-V stage streams of a Unity Vulkan program entry, in file order. Each starts at a
    'SMOL' magic; its byte size is one of the header words (the header also holds the variant's
    keyword strings, so their position varies), picked as the one smol-v decodes exactly."""
    magic = struct.pack("<I", SMOL_MAGIC)
    starts = [i for i in range(0, len(entry) - 3, 4) if entry[i:i + 4] == magic]
    header = struct.unpack_from(f"<{starts[0] // 4}I", entry, 0)
    streams = []
    for p in starts:
        for n in sorted(set(header)):
            if 24 <= n <= len(entry) - p:
                try:
                    smolv_decode(entry[p:p + n])
                except (ValueError, struct.error, IndexError):
                    continue
                streams.append(entry[p:p + n])
                break
        else:
            raise ValueError(f"no stream size found for the SMOL-V stream at {p:#x}")
    return streams


def main() -> None:
    import UnityPy
    from UnityPy.helpers.CompressionHelper import decompress_lz4

    UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.52f1"
    warnings.filterwarnings("ignore", module="UnityPy")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bundle")
    ap.add_argument("shader")
    ap.add_argument("pass_name")
    ap.add_argument("keywords", nargs="*")
    ap.add_argument("--grammar-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("."))
    a = ap.parse_args()
    env = UnityPy.load(a.bundle)
    tt = next(o.read_typetree() for o in env.objects
              if o.type.name == "Shader" and o.read_typetree()["m_ParsedForm"]["m_Name"] == a.shader)
    pf = tt["m_ParsedForm"]
    p = tt["platforms"].index(18)  # Vulkan
    blob = bytes(tt["compressedBlob"])
    data = b"".join(decompress_lz4(blob[o:o + c], d) for o, c, d in zip(tt["offsets"][p], tt["compressedLengths"][p], tt["decompressedLengths"][p]))
    entries = [struct.unpack_from("<iii", data, 4 + i * 12) for i in range(struct.unpack_from("<i", data, 0)[0])]
    grammar = Grammar(a.grammar_dir)
    want = set(a.keywords)
    names = pf["m_KeywordNames"]
    for pas in pf["m_SubShaders"][0]["m_Passes"]:
        if pas["m_State"]["m_Name"] != a.pass_name:
            continue
        for tier in pas["progVertex"]["m_PlayerSubPrograms"]:
            for s in tier:
                if s["m_GpuProgramType"] != 25 or {names[k] for k in s["m_KeywordIndices"]} != want:
                    continue
                o, n, _ = entries[s["m_BlobIndex"]]
                a.out.mkdir(parents=True, exist_ok=True)
                for i, stream in enumerate(unity_vulkan_streams(data[o:o + n])):
                    text = disassemble(smolv_decode(stream), grammar)
                    f = a.out / f"{a.pass_name}__{'+'.join(sorted(want)) or 'none'}__stage{i}.spvasm"
                    f.write_text(text)
                    print("wrote", f, text.count("\n"), "lines")
                return
    raise SystemExit("no matching Vulkan subprogram")


if __name__ == "__main__":
    main()
