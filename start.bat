@echo off
REM Double-click this file to start the bot.
REM Closing the window stops the bot.

setlocal
cd /d "%~dp0"
title NightmareJr

echo ============================================
echo   NightmareJr - Spotify to Discord
echo ============================================
echo.

if not exist ".env" (
  echo ERROR: .env file is missing.
  echo Copy .env.example to .env and fill it in.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies for the first time...
  call npm install
  if errorlevel 1 goto failed
  echo.
)

echo Building...
call npm run build
if errorlevel 1 goto failed

echo.
echo Starting. Leave this window open - closing it stops the bot.
echo In Discord: join a voice channel, then type /join
echo.

node dist\index.js

echo.
echo ============================================
echo   The bot stopped.
echo ============================================
echo.
echo If this was unexpected, the reason is printed above.
pause
exit /b 0

:failed
echo.
echo Startup failed - see the error above.
echo Run "npm run doctor" in this folder to check your setup.
echo.
pause
exit /b 1
