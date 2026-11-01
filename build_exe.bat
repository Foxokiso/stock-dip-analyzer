@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: Stock Dip Analyzer - EXE Builder
:: Self-elevates to admin for symlink privileges (winCodeSign)
:: Disables code signing to skip certificate requirements
:: ============================================================

:: --- Self-elevate to Administrator if not already elevated ---
:: Admin grants the symlink privilege 7-Zip needs to extract electron-builder's
:: legacy winCodeSign archive, which contains macOS symlinks. electron-builder 26.18
:: fetches that archive only to sign or to build AppX, and this script does neither,
:: so elevation is probably no longer needed. It stays until a build as a standard
:: user has been confirmed: CI runners are administrators, so CI cannot show it.
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

:: --- Run Vite build ---
echo.
echo [BUILD] Step 1/2 - Running Vite production build...
echo ------------------------------------------------------------
call npm run build:renderer
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Vite build failed! Check output above.
    pause
    exit /b 1
)
echo [BUILD] Vite build succeeded.

:: --- Run electron-builder ---
echo.
echo [BUILD] Step 2/2 - Running electron-builder (NSIS installer)...
echo ------------------------------------------------------------
:: Target, arch and --publish never match CI; --no refuses to download a missing
:: package while elevated.
call npm exec --no -- electron-builder --win nsis --x64 --publish never 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] electron-builder failed! Check output above.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   BUILD COMPLETE
echo   Output: release\
echo ============================================================
echo.

:: --- Show the output files ---
dir /b release\*.exe 2>nul || echo (No .exe found in release\)
dir /b "release\win-unpacked\*.exe" 2>nul

pause
