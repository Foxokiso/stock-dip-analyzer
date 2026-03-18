!macro customInit
  ; Search for the old stock-dip-analyzer uninstaller in the typical local app data directories
  IfFileExists "$LOCALAPPDATA\Programs\Stock Dip Analyzer\Uninstall Stock Dip Analyzer.exe" oldExists1
  IfFileExists "$LOCALAPPDATA\Programs\stock-dip-analyzer\Uninstall Stock Dip Analyzer.exe" oldExists2
  Goto skipUninstall

  oldExists1:
    MessageBox MB_YESNO "An older version of Stock Dip Analyzer was detected. Would you like to completely remove it before installing DDS response?" IDYES doUninstall1 IDNO skipUninstall
    
  doUninstall1:
    ExecWait '"$LOCALAPPDATA\Programs\Stock Dip Analyzer\Uninstall Stock Dip Analyzer.exe" /S _?=$LOCALAPPDATA\Programs\Stock Dip Analyzer'
    RMDir /r "$LOCALAPPDATA\Programs\Stock Dip Analyzer"
    Goto skipUninstall

  oldExists2:
    MessageBox MB_YESNO "An older version of Stock Dip Analyzer was detected. Would you like to completely remove it before installing DDS response?" IDYES doUninstall2 IDNO skipUninstall
    
  doUninstall2:
    ExecWait '"$LOCALAPPDATA\Programs\stock-dip-analyzer\Uninstall Stock Dip Analyzer.exe" /S _?=$LOCALAPPDATA\Programs\stock-dip-analyzer'
    RMDir /r "$LOCALAPPDATA\Programs\stock-dip-analyzer"

  skipUninstall:
!macroend
