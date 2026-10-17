!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current
  IfFileExists "$INSTDIR\resources\app-icon-1.4.11.ico" 0 noBrandIcon
  Delete "$DESKTOP\阿男帮你推.lnk"
  CreateShortCut "$DESKTOP\阿男帮你推.lnk" "$INSTDIR\prompt-vault.exe" "" "$INSTDIR\resources\app-icon-1.4.11.ico" 0
  Delete "$SMPROGRAMS\阿男帮你推.lnk"
  CreateShortCut "$SMPROGRAMS\阿男帮你推.lnk" "$INSTDIR\prompt-vault.exe" "" "$INSTDIR\resources\app-icon-1.4.11.ico" 0
noBrandIcon:
!macroend