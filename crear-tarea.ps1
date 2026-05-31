# Registra la Tarea Programada "GridBot" para arrancar el bot al iniciar sesion.
# EJECUTAR COMO ADMINISTRADOR (una sola vez).
#   Click derecho sobre este archivo > "Ejecutar con PowerShell" (como admin),
#   o desde una terminal elevada:  powershell -ExecutionPolicy Bypass -File crear-tarea.ps1

# Lanzamos via wscript + .vbs para que NO se vea ninguna ventana de consola.
$action  = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument '"C:\Users\juanc\OneDrive\Escritorio\projects\grid-bot\start-bot-hidden.vbs"'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT1M"   # espera 1 min tras el login (red/OneDrive listos)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName "GridBot" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Limited `
    -Description "Arranca el grid-bot de GRVT al iniciar sesion en Windows" `
    -Force

Write-Host ""
Write-Host "Tarea 'GridBot' registrada. Arranca 1 min despues de iniciar sesion." -ForegroundColor Green
Write-Host "Logs en: C:\Users\juanc\OneDrive\Escritorio\projects\grid-bot\logs\bot.log"
Get-ScheduledTask -TaskName "GridBot" | Select-Object TaskName, State
