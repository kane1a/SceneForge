# 安全政策

## 支援的版本

只有最新的正式版本會收到安全性修正。

## 回報安全漏洞

請**不要**在公開的 Issue 回報安全漏洞。請使用 GitHub 的 [Private vulnerability reporting](https://github.com/kane1a/SceneForge/security/advisories/new) 私下回報，內容包括：

- 受影響的版本
- 問題說明與重現步驟
- 可能造成的影響

收到後會盡快回覆，修正發佈前請先不要公開細節。

## 已知限制

- 沒有設定密碼的 `.sfe` 劇本檔使用內嵌在程式中的金鑰，只能防止一般檢視，不能防止有心人解讀。需要保密的劇本，請在「另存新檔」時設定密碼（AES-256-GCM，金鑰由密碼經 PBKDF2 產生）。
- 程式目前沒有數位簽章。請只從本專案的 [Releases](https://github.com/kane1a/SceneForge/releases) 下載。
