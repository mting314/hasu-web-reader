#!/usr/bin/env python3
"""Fetch Project Sekai (EN) asset bundles from the game's own CDN, for the PJSK cast swap.

The storage.sekai.best mirror only serves pre-extracted textures/JSON (no meshes, skins or
Avatars), so 3D models have to come from the official CDN as raw bundles:

  handshake  https://game-version.sekai-en.com/{appVersion}/{appHash}
             -> {profile, assetbundleHostHash} (msgpack under AES, EN keyset)
  bundle     https://n-{profile}-{hostHash}-assetbundle.sekai-en.com/{assetVersion}/{assetHash}/android/{bundleName}

The current (appVersion, appHash, assetVersion, assetHash) come from Sekai-World's
sekai-master-db-en-diff versions.json. The CDN's bundle index
(…-assetbundle-info.sekai-en.com) answers 403 without a logged-in game session, and we don't
register guest accounts, so bundle names come from the storage.sekai.best mirror's folder listing
(`ls`) and dependencies from each bundle's own AssetBundle object. Bundles are stored de-obfuscated (sssekai's decrypt_iter), so UnityPy.load opens
them directly. The handshake/header code follows ~/github/sekai-story-diff/scripts/fetch_official_bundles.py.

Usage (uv group `pjsk`):
  uv run --group pjsk python -I scripts/pjsk_fetch.py ls live_pv/model/
  uv run --group pjsk python -I scripts/pjsk_fetch.py master --out data-inspect/pjsk costume3dModels character3ds
  uv run --group pjsk python -I scripts/pjsk_fetch.py get    --out data-inspect/pjsk <bundle name> ...
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from io import BytesIO
from pathlib import Path

import msgpack
import requests
from sssekai.crypto.APIManager import SEKAI_APIMANAGER_KEYSETS, decrypt
from sssekai.crypto.AssetBundle import decrypt_iter

GAME_VERSION_EN = "https://game-version.sekai-en.com"
MIRROR = "https://storage.sekai.best"
BROWSER_UA = "Mozilla/5.0 Chrome/158"  # Cloudflare 403s python's default User-Agent
MASTER_EN = "https://sekai-world.github.io/sekai-master-db-en-diff"
UNITY_VERSION = "2022.3.52f1"

session = requests.Session()


def client_headers(app_version: str, app_hash: str) -> dict[str, str]:
    return {
        "Accept": "application/octet-stream",
        "Content-Type": "application/octet-stream",
        "User-Agent": f"UnityPlayer/{UNITY_VERSION}",
        "X-Platform": "Android",
        "X-DeviceModel": "sssekai",
        "X-OperatingSystem": "Android",
        "X-Unity-Version": UNITY_VERSION,
        "X-App-Version": app_version,
        "X-App-Hash": app_hash,
    }


def unpack(resp: requests.Response) -> dict:
    resp.raise_for_status()
    return msgpack.unpackb(decrypt(resp.content, SEKAI_APIMANAGER_KEYSETS["en"]), strict_map_key=False)


def latest_versions() -> dict:
    """{appVersion, appHash, assetVersion, assetHash, ...} of the current EN release."""
    resp = session.get(f"{MASTER_EN}/versions.json", timeout=30)
    resp.raise_for_status()
    return resp.json()


class Cdn:
    def __init__(self, asset_version: str | None = None, asset_hash: str | None = None):
        v = latest_versions()
        session.headers.update(client_headers(v["appVersion"], v["appHash"]))
        gv = unpack(session.get(f"{GAME_VERSION_EN}/{v['appVersion']}/{v['appHash']}", timeout=45))
        self.profile, self.host_hash = gv["profile"], gv["assetbundleHostHash"]
        if not asset_version or not asset_hash:
            asset_version, asset_hash = v["assetVersion"], v["assetHash"]
        self.asset_version, self.asset_hash = asset_version, asset_hash
        self.base = (
            f"https://n-{self.profile}-{self.host_hash}-assetbundle.sekai-en.com"
            f"/{asset_version}/{asset_hash}/android"
        )

    def bundle(self, name: str) -> bytes:
        resp = session.get(f"{self.base}/{name}", timeout=180)
        resp.raise_for_status()
        src = BytesIO(resp.content)
        return b"".join(decrypt_iter(lambda n: src.read(n)))


def bundle_dependencies(blob: bytes) -> list[str]:
    """Bundle names this bundle depends on, from its own AssetBundle object."""
    import UnityPy

    UnityPy.config.FALLBACK_UNITY_VERSION = UNITY_VERSION  # PJSK strips the version from headers
    env = UnityPy.load(blob)
    for obj in env.objects:
        if obj.type.name == "AssetBundle":
            return list(obj.read_typetree().get("m_Dependencies") or [])
    return []


def mirror_ls(bucket: str, prefix: str) -> tuple[list[str], list[str]]:
    """Folders and files under prefix on the storage.sekai.best mirror (S3 ListObjectsV2).
    The mirror's folder names are the bundle names, so this finds bundles without the CDN's
    index (which needs a logged-in game session)."""
    folders: list[str] = []
    keys: list[str] = []
    token = None
    while True:
        params = {"list-type": "2", "delimiter": "/", "prefix": prefix}
        if token:
            params["continuation-token"] = token
        resp = requests.get(f"{MIRROR}/{bucket}", params=params, timeout=60, headers={"User-Agent": BROWSER_UA})
        resp.raise_for_status()
        t = resp.text
        folders += [f for f in re.findall(r"<Prefix>([^<]*)</Prefix>", t) if f != prefix]
        keys += re.findall(r"<Key>([^<]*)</Key>", t)
        m = re.search(r"<NextContinuationToken>([^<]*)</NextContinuationToken>", t)
        if not m:
            return folders, keys
        token = m.group(1)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["ls", "master", "get"])
    ap.add_argument("args", nargs="*", help="ls: mirror prefixes; master: table names; get: bundle names")
    ap.add_argument("--out", type=Path, default=Path("data-inspect/pjsk"))
    ap.add_argument("--bucket", default="sekai-jp-assets",
                    help="ls: mirror bucket (the EN bucket has no live_pv/)")
    ap.add_argument("--asset-version", help="default: latest in sekai-master-db-en-diff versions.json")
    ap.add_argument("--asset-hash")
    ap.add_argument("--no-deps", action="store_true", help="get: skip the dependency closure")
    a = ap.parse_intermixed_args()

    if a.command == "ls":
        for prefix in a.args:
            folders, keys = mirror_ls(a.bucket, prefix)
            for f in folders:
                print(f)
            for k in keys:
                print(k)
        return

    a.out.mkdir(parents=True, exist_ok=True)
    if a.command == "master":
        dest = a.out / "master"
        dest.mkdir(exist_ok=True)
        for table in a.args:
            resp = session.get(f"{MASTER_EN}/{table}.json", timeout=60)
            resp.raise_for_status()
            (dest / f"{table}.json").write_bytes(resp.content)
            print(f"{table}: {len(resp.json())} rows")
        return

    cdn = Cdn(a.asset_version, a.asset_hash)
    print(f"asset version {cdn.asset_version}")
    todo: list[str] = []
    for arg in a.args:  # "@file" = one bundle name (or mirror folder, trailing "/" ok) per line
        lines = Path(arg[1:]).read_text().split() if arg.startswith("@") else [arg]
        todo += [n.rstrip("/") for n in lines]
    seen: set[str] = set()
    while todo:
        name = todo.pop(0)
        if name in seen:
            continue
        seen.add(name)
        dest = a.out / "bundles" / name
        if dest.exists():
            blob = dest.read_bytes()
        else:
            try:
                blob = cdn.bundle(name)
            except requests.HTTPError as e:
                print(f"  {name}: {e.response.status_code}")
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(blob)
            print(f"  {name}  {len(blob) / 1e6:.2f} MB")
        if not a.no_deps:
            todo += bundle_dependencies(blob)


if __name__ == "__main__":
    main()
