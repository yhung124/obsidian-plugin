# obsidian-plugin

私人的 Obsidian plugin 離線資料庫。依 `plugins.json` 從 GitHub release 下載 plugin 檔案。

## plugins.json

```json
[
  { "id": "meld-encrypt", "repo": "meld-cp/obsidian-encrypt" },
  { "id": "another-plugin", "repo": "owner/repo", "version": "1.2.3" }
]
```

- `id`：Obsidian plugin ID（需與 `manifest.json` 內的 `id` 一致）
- `repo`：GitHub `owner/name`
- `version`：選填，釘選版本；省略則抓 latest release

## 使用

```bash
python3 sync.py                 # 同步全部
python3 sync.py --only meld-encrypt
python3 sync.py --dry-run       # 只顯示會下載什麼，不寫檔、不寫 log
```

只需 Python 3 標準庫。未帶 token 呼叫 GitHub API，限制為 60 次/小時（每個 plugin 約 1 次）。

## 輸出結構與 log

輸出放在 `plugins/{id}/{tag}/`，更新紀錄寫入 `log.md`。詳細的目錄結構、失敗判定與 log 規則見 [AGENTS.md](AGENTS.md)。
