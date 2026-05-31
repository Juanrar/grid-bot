# Elimina la Tarea Programada "GridBot" (desactiva el auto-arranque).
# EJECUTAR COMO ADMINISTRADOR.
#   powershell -ExecutionPolicy Bypass -File borrar-tarea.ps1

Unregister-ScheduledTask -TaskName "GridBot" -Confirm:$false
Write-Host "Tarea 'GridBot' eliminada. El bot ya no arranca solo al iniciar sesion." -ForegroundColor Yellow
