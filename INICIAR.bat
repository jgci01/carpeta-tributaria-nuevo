@echo off
chcp 65001 >nul
title Carpetas Tributarias - Formex
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  No se encontro Node.js en este equipo.
  echo  Instala Node.js 18 o superior desde https://nodejs.org y vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)

echo  Iniciando la aplicacion...
node server.js --abrir
echo.
echo  El servidor se detuvo.
pause
