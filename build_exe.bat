@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: Stock Dip Analyzer - EXE Builder
:: Self-elevates to admin for symlink privileges (winCodeSign)
:: Disables code signing to skip certificate requirements
:: ============================================================

:: --- Self-elevate to Administrator if not already elevated ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [BUILD] Not elevated. Requesting admin privileges...
    powershell -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/k cd /d ""%~dp0"" && ""%~f0""' -Verb RunAs"
    exit /b
)

:: --- Navigate to script directory ---
cd /d "%~dp0"

echo.
echo ============================================================
echo   Stock Dip Analyzer - EXE Builder
echo   Working dir: %CD%
echo ============================================================
echo.

:: --- Disable electron-builder code signing (no cert needed) ---
set CSC_IDENTITY_AUTO_DISCOVERY=false
set CSC_LINK=
set WIN_CSC_LINK=
set WIN_CSC_KEY_PASSWORD=

:: --- Enable symlink creation for current session (Developer Mode workaround) ---
:: The winCodeSign 7z archive contains macOS symlinks; 7-zip needs symlink privilege.
:: Running as admin grants SeCreateSymbolicLinkPrivilege.

:: --- Clean stale winCodeSign cache to avoid partial extractions ---
echo [BUILD] Cleaning stale electron-builder cache...
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" (
    rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
    echo [BUILD] Cleared winCodeSign cache.
) else (
    echo [BUILD] No stale cache found.
)

:: --- Run Vite build ---
echo.
echo [BUILD] Step 1/2 — Running Vite production build...
echo ------------------------------------------------------------
call npx vite build
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Vite build failed! Check output above.
    pause
    exit /b 1
)
echo [BUILD] Vite build succeeded.

:: --- Run electron-builder ---
echo.
echo [BUILD] Step 2/2 — Running electron-builder (NSIS installer)...
echo ------------------------------------------------------------
call npx electron-builder --win nsis 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] electron-builder failed! Check output above.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   BUILD COMPLETE
echo   Output: dist\
echo ============================================================
echo.

:: --- Show the output files ---
dir /b dist\*.exe 2>nul || echo (No .exe found in dist\)
dir /b "dist\win-unpacked\*.exe" 2>nul

pause
