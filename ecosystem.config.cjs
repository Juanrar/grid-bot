// Configuración de pm2 para correr el grid bot 24/7 en la VM de Oracle Cloud.
// Uso: pm2 start ecosystem.config.cjs && pm2 save
//
// pm2 reinicia el proceso si crashea. OJO: hoy cada reinicio vuelve a llamar
// placeInitialOrders() (compra market inicial), lo que puede duplicar posición.
// Hasta que placeInitialOrders sea idempotente, conviene investigar cada
// reinicio en los logs (pm2 logs grid-bot) antes de dejarlo totalmente solo.

module.exports = {
  apps: [
    {
      name: "grid-bot",
      script: "src/index.js",
      // Reinicia si el proceso muere, con backoff para no spamear el exchange.
      autorestart: true,
      restart_delay: 5000,         // espera 5s antes de relanzar
      max_restarts: 10,            // si crashea 10 veces seguidas, se rinde
      min_uptime: "60s",           // debe vivir 60s para contar como "arranque ok"
      // Reinicia si supera 300MB de RAM (fuga de memoria, etc.).
      max_memory_restart: "300M",
      // Logs con timestamp.
      time: true,
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      // Las credenciales se leen de .env vía dotenv (no se ponen acá).
      env: {
        NODE_ENV: "production",
      },
    },
  ],
}
