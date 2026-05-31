' Lanza start-bot.bat con ventana OCULTA.
' Lo invoca la Tarea Programada "GridBot".
' El "0" = ventana oculta; False = no esperar a que termine.
' Asegúrate de que la ruta a start-bot.bat sea correcta.
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c ""C:\Users\juanc\OneDrive\Escritorio\projects\grid-bot\start-bot.bat""", 0, False
