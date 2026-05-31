@echo off
REM Wrapper para arrancar el grid-bot al iniciar sesion en Windows.
REM Lo invoca la Tarea Programada "GridBot" (ver crear-tarea mas abajo).
REM Hace cd a la carpeta del proyecto, asegura logs/ y vuelca todo a logs\bot.log.

cd /d "C:\Users\juanc\OneDrive\Escritorio\projects\grid-bot"
if not exist logs mkdir logs

echo ============================================================ >> logs\bot.log
echo Bot iniciado: %DATE% %TIME% >> logs\bot.log
echo ============================================================ >> logs\bot.log

"C:\Program Files\nodejs\node.exe" src\index.js >> logs\bot.log 2>&1

echo Bot finalizado: %DATE% %TIME% (exit %ERRORLEVEL%) >> logs\bot.log
