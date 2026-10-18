; Always recreate the Start Menu link after an update. Electron Builder can
; preserve an existing .lnk when the shortcut name did not change, even when
; its target points to an older installation directory.
!macro customInstall
  Delete "$newStartMenuLink"
  CreateShortCut "$newStartMenuLink" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
