; Intentionally no custom migration hooks. Use electron-builder's standard
; appId-based upgrade/uninstall handling. Do not execute an uninstaller found
; only by a guessed path, or recursively delete a legacy installation folder.
; A legacy installation with a different appId must be removed by its owner
; through Windows Settings before installing this application.
