# AGENTS.md

私人的 Obsidian plugin 離線資料庫。依 `plugins.json` 從 GitHub release 下載 plugin 檔案。
使用方式見 `README.md`；本檔記錄輸出結構與維護規則。

## 檔案

- `plugins.json`：人工維護的清單（array），欄位 `id`、`repo`、選填 `version`。
- `sync.py`：下載腳本，只用 Python 標準庫，不引入第三方套件。
- `log.md`：由 `sync.py` 自動維護，最新在前。不要手動編輯。
- `plugins/{id}/{tag}/`：由 `sync.py` 產生。不要手動修改或刪除。

## 輸出結構

```
plugins/
  meld-encrypt/
    v2.4.5/
      main.js
      manifest.json
      styles.css    # release 有提供才會下載
```

- 目錄名稱為 release tag，沒有 `v` 前綴時自動補上。
- 檔名是 `main.js`、`manifest.json`、`styles.css`（不是 `manifest.js`、`style.css`）。
- 舊版保留；目標版本已存在且 `main.js`、`manifest.json` 齊全就跳過。
- 缺少 `main.js` 或 `manifest.json`、或 `manifest.json` 的 `id` 與 `plugins.json` 不符，視為失敗，不留下半成品目錄。

## log.md 規則

- 只在有實際變動（新增、更新、失敗）時寫入新區塊；全部跳過或 `--dry-run` 不寫入。
- 跳過的項目只顯示在終端機，不記錄。

## 驗證

- 修改 `sync.py` 後先跑 `python3 sync.py --dry-run`。
- 測試錯誤情境（錯誤 repo、id 不符、重複 id）時，在 `/tmp` 的複本執行，避免汙染正式的 `log.md` 與 `plugins/`。
- 不要把測試用的假資料留在 `plugins.json`。

## Git

- `plugins/` 與 `log.md` 都要進 git，不加 `.gitignore`。
- `.gitattributes` 將 `plugins/**` 設為 `-text`，git 不轉換行尾，檔案須與 release 位元組一致。不要移除，也不要對 `plugins/` 內檔案做行尾轉換。
- 工作流程：WSL 執行 `sync.py`，Windows GitHub Desktop commit，最終在 Windows Obsidian 使用。
- 沒有使用者明確要求，不 commit、不 push。

## 已知限制

- 不使用 GitHub token，API 限制 60 次/小時（每個 plugin 約 1 次）。
- release 沒附 `main.js` 或 `manifest.json`（例如只有原始碼）的 plugin 無法下載。
- 目前只有 `plugins.json` 內的 8 個 plugin 實際連網測試過。
