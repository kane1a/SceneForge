
; SceneForge is intentionally per-user. Skip the install-mode page and never request elevation.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Keep user data on updates and silent uninstalls. Interactive uninstall defaults to keeping it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "要一併刪除 SceneForge 的資料（資料庫、快照、備份、垃圾桶）嗎？文件中的劇本檔不會被刪除。" IDYES sceneForgeDeleteUserData
      Goto sceneForgeKeepUserData
      sceneForgeDeleteUserData:
        RMDir /r "$LOCALAPPDATA\SceneForge"
      sceneForgeKeepUserData:
    ${endIf}
  ${endIf}
!macroend
