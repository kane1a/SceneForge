# 參與開發

感謝你願意幫忙！SceneForge 目前由個人維護，以下是參與方式。

## 回報問題與建議

- 錯誤請用 [回報錯誤](https://github.com/kane1a/SceneForge/issues/new?template=bug_report.yml) 範本，附上版本號與重現步驟。
- 想要的新功能請用 [功能建議](https://github.com/kane1a/SceneForge/issues/new?template=feature_request.yml) 範本，描述你寫作時遇到的情境。
- 請不要上傳未公開的劇本內容；需要範例時，用一小段虛構文字即可。

## 送出程式修改

1. Fork 後從 `main` 開新分支。
2. 安裝與建置：`npm ci`、`npm run build`。
3. 修改後實際開啟程式操作一次，確認功能正常。介面修改請沿用既有的共用元件、間距與對齊方式，保持全站風格一致。
4. 送出 Pull Request，說明改了什麼、為什麼改，介面修改請附前後截圖。

## 原則

- 中文優先：介面與文件使用台灣繁體中文用語。
- 劇本內容只存在使用者的電腦上；不要加入會把劇本傳到外部的功能。
- 共用元件從源頭修改，不在個別頁面加例外。
- 重構不可改變既有功能與外觀。

## 授權

送出的貢獻將以本專案的 [MIT](LICENSE) 授權釋出。
