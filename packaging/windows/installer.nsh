!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Remove NE PSD settings from this Windows account? Jobs, evidence, templates and output folders will be retained." IDNO keepSettings
  RMDir /r "$APPDATA\\ne-psd-desktop\\settings"
  RMDir /r "$LOCALAPPDATA\\ne-psd-desktop\\settings"
  keepSettings:
!macroend
