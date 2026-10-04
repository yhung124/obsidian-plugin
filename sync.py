#!/usr/bin/env python3
"""依 plugins.json 從 GitHub release 下載 Obsidian plugin 到 plugins/{id}/{tag}/。"""

import argparse
import json
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "plugins.json"
OUT_DIR = ROOT / "plugins"
LOG_FILE = ROOT / "log.md"
LOG_HEADER = "# Update Log\n"

REQUIRED_ASSETS = ("main.js", "manifest.json")
OPTIONAL_ASSETS = ("styles.css",)
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
TIMEOUT = 30


class SyncError(Exception):
    pass


def load_config():
    try:
        data = json.loads(CONFIG.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"找不到 {CONFIG}")
    except json.JSONDecodeError as e:
        raise SystemExit(f"{CONFIG.name} 不是合法 JSON: {e}")
    if not isinstance(data, list):
        raise SystemExit(f"{CONFIG.name} 最外層必須是 array")

    seen = set()
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            raise SystemExit(f"{CONFIG.name}[{i}] 必須是 object")
        pid, repo = item.get("id"), item.get("repo")
        if not isinstance(pid, str) or not ID_RE.match(pid):
            raise SystemExit(f"{CONFIG.name}[{i}] id 缺少或格式錯誤: {pid!r}")
        if not isinstance(repo, str) or not REPO_RE.match(repo):
            raise SystemExit(f"{CONFIG.name}[{i}] repo 必須是 owner/name: {repo!r}")
        ver = item.get("version")
        if ver is not None and not (isinstance(ver, str) and ID_RE.match(ver.lstrip("v") or "x")):
            raise SystemExit(f"{CONFIG.name}[{i}] version 格式錯誤: {ver!r}")
        if pid in seen:
            raise SystemExit(f"{CONFIG.name} id 重複: {pid}")
        seen.add(pid)
    return data


def http_get(url):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "obsidian-plugin-sync", "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code in (403, 429) and e.headers.get("X-RateLimit-Remaining") == "0":
            reset = e.headers.get("X-RateLimit-Reset")
            when = (
                datetime.fromtimestamp(int(reset)).strftime("%Y-%m-%d %H:%M:%S")
                if reset
                else "未知"
            )
            raise SyncError(f"GitHub API rate limit，重置時間 {when}")
        if e.code == 404:
            raise SyncError(f"HTTP 404: 找不到 {url}")
        raise SyncError(f"HTTP {e.code}: {url}")
    except urllib.error.URLError as e:
        raise SyncError(f"網路錯誤: {e.reason}")
    except TimeoutError:
        raise SyncError(f"逾時: {url}")


def fetch_release(repo, version):
    if version:
        # 同時嘗試帶 v 與不帶 v 的 tag
        bare = version.lstrip("v")
        candidates = [version] + [t for t in (bare, f"v{bare}") if t != version]
        last = None
        for tag in candidates:
            try:
                return json.loads(http_get(f"https://api.github.com/repos/{repo}/releases/tags/{tag}"))
            except SyncError as e:
                last = e
        raise last
    return json.loads(http_get(f"https://api.github.com/repos/{repo}/releases/latest"))


def dir_name(tag):
    return tag if tag.startswith("v") else f"v{tag}"


def is_complete(path):
    return path.is_dir() and all((path / n).is_file() for n in REQUIRED_ASSETS)


def sync_one(item, dry_run):
    """回傳 dict: status(new/update/skip/fail), id, version, note"""
    pid, repo = item["id"], item["repo"]
    res = {"id": pid, "version": "-", "status": "fail", "note": ""}
    try:
        release = fetch_release(repo, item.get("version"))
        tag = release.get("tag_name")
        if not tag or not ID_RE.match(tag):
            raise SyncError(f"tag_name 異常: {tag!r}")
        vdir = dir_name(tag)
        res["version"] = vdir

        plugin_dir = OUT_DIR / pid
        target = plugin_dir / vdir
        if is_complete(target):
            res.update(status="skip", note="已存在")
            return res

        assets = {a["name"]: a["browser_download_url"] for a in release.get("assets", [])}
        missing = [n for n in REQUIRED_ASSETS if n not in assets]
        if missing:
            raise SyncError(f"release 缺少必要檔案: {', '.join(missing)}")
        names = list(REQUIRED_ASSETS) + [n for n in OPTIONAL_ASSETS if n in assets]

        previous = (
            sorted(p.name for p in plugin_dir.iterdir() if p.is_dir() and is_complete(p))
            if plugin_dir.is_dir()
            else []
        )
        is_update = bool(previous)
        note = ", ".join(names)
        if is_update:
            note += f"（前一個版本 {previous[-1]}，已保留）"
        if dry_run:
            res.update(status="update" if is_update else "new", note=note + " [dry-run]")
            return res

        plugin_dir.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix=f".{vdir}.", dir=plugin_dir))
        try:
            for n in names:
                (tmp / n).write_bytes(http_get(assets[n]))
            try:
                manifest = json.loads((tmp / "manifest.json").read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                raise SyncError("manifest.json 不是合法 JSON")
            if manifest.get("id") != pid:
                raise SyncError(
                    f"manifest id ({manifest.get('id')!r}) 與 plugins.json id ({pid!r}) 不符"
                )
            if target.exists():  # 先前不完整的殘留
                shutil.rmtree(target)
            tmp.rename(target)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            try:
                plugin_dir.rmdir()  # 僅在空目錄時移除
            except OSError:
                pass
            raise
        res.update(status="update" if is_update else "new", note=note)
        return res
    except SyncError as e:
        res["note"] = str(e)
        return res


def write_log(results):
    changed = [r for r in results if r["status"] != "skip"]
    if not changed:
        return
    labels = {"new": "新增", "update": "更新", "fail": "失敗"}
    now = datetime.now().astimezone()
    offset = now.strftime("%z")
    stamp = f"{now:%Y-%m-%d %H:%M:%S} ({offset[:3]}:{offset[3:]})"
    lines = [f"## {stamp}", "", "| 動作 | Plugin | 版本 | 說明 |", "|---|---|---|---|"]
    for r in changed:
        note = r["note"].replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {labels[r['status']]} | {r['id']} | {r['version']} | {note} |")
    block = "\n".join(lines) + "\n"

    old = LOG_FILE.read_text(encoding="utf-8") if LOG_FILE.exists() else LOG_HEADER
    if old.startswith(LOG_HEADER):
        body = old[len(LOG_HEADER):].lstrip("\n")
    else:
        body = old
    content = f"{LOG_HEADER}\n{block}" + (f"\n{body}" if body else "")
    tmp = LOG_FILE.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(LOG_FILE)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", metavar="ID", help="只同步指定的 plugin id")
    ap.add_argument("--dry-run", action="store_true", help="只顯示會下載什麼，不寫入檔案與 log")
    args = ap.parse_args()

    items = load_config()
    if args.only:
        items = [i for i in items if i["id"] == args.only]
        if not items:
            raise SystemExit(f"plugins.json 中找不到 id: {args.only}")

    results = []
    for item in items:
        r = sync_one(item, args.dry_run)
        results.append(r)
        icon = {"new": "NEW ", "update": "UPD ", "skip": "SKIP", "fail": "FAIL"}[r["status"]]
        print(f"[{icon}] {r['id']} {r['version']} {r['note']}".rstrip())

    if not args.dry_run:
        write_log(results)

    count = lambda s: sum(1 for r in results if r["status"] == s)
    print(
        f"\n摘要: 新增 {count('new')}, 更新 {count('update')}, "
        f"跳過 {count('skip')}, 失敗 {count('fail')}"
    )
    return 1 if count("fail") else 0


if __name__ == "__main__":
    sys.exit(main())
