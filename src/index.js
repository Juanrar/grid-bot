// Entry point del grid bot.
// Carga credenciales de .env + parámetros de config.json, conecta a GRVT,
// crea el grid de ETH_USDT y lo opera en vivo.

import "dotenv/config"
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { GrvtClient } from "./grvtClient.js"
import { GridEngine } from "./gridEngine.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
    const path = join(__dirname, "..", "config.json")
    const config = JSON.parse(readFileSync(path, "utf8"))

    const required = ["pair", "direction", "leverage", "lowerPrice", "upperPrice", "numGrids", "investmentUSDT"]
    for (const key of required) {
        if (config[key] == null) throw new Error(`config.json: falta el campo '${key}'`)
    }
    if (config.lowerPrice >= config.upperPrice) {
        throw new Error("config.json: lowerPrice debe ser < upperPrice")
    }
    if (config.numGrids < 1) throw new Error("config.json: numGrids debe ser >= 1")
    return config
}

function loadCredentials() {
    const creds = {
        apiKey: process.env.GRVT_API_KEY,
        apiSecret: process.env.GRVT_API_SECRET,
        tradingAddress: process.env.GRVT_TRADING_ADDRESS,
        accountId: process.env.GRVT_TRADING_ACCOUNT_ID,
    }
    const missing = Object.entries(creds)
        .filter(([, v]) => !v)
        .map(([k]) => k)
    if (missing.length > 0) {
        throw new Error(`Faltan credenciales en .env: ${missing.join(", ")}`)
    }
    return creds
}

async function main() {
    const config = loadConfig()
    const creds = loadCredentials()

    console.log("═".repeat(60))
    console.log(`🤖 Grid Bot — ${config.pair} ${config.direction.toUpperCase()} ${config.leverage}x`)
    console.log(`   Rango: $${config.lowerPrice} - $${config.upperPrice} | ${config.numGrids} grids | $${config.investmentUSDT} USDT`)
    console.log("═".repeat(60))

    const client = new GrvtClient(creds)
    await client.login()

    // Apalancamiento del instrumento.
    // Algunas cuentas/entornos GRVT no exponen set_leverage en API; no abortamos el bot.
    try {
        await client.setLeverage(config.pair, config.leverage)
        console.log(`⚡ Leverage ${config.leverage}x configurado para ${config.pair}`)
    } catch (err) {
        const msg = String(err?.message ?? "")
        if (msg.includes("/set_leverage") && msg.includes("HTTP 404")) {
            console.warn(
                `⚠️  GRVT no expone set_leverage para esta cuenta/API. Continúo sin cambiar leverage por API; configúralo manualmente en la plataforma.`
            )
        } else {
            throw err
        }
    }

    const engine = new GridEngine(client, config)

    // Coloca el grid inicial (incluye compra inicial market en LONG).
    await engine.placeInitialOrders()

    // Arranca el loop de monitoreo/reposición.
    engine.start(config.monitorIntervalMs ?? 5000)

    // Apagado limpio: cancela órdenes abiertas (no cierra posición).
    const shutdown = async () => {
        console.log("\n⏹️  Señal de apagado recibida...")
        await engine.stop()
        process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
}

main().catch((err) => {
    console.error(`💥 Error fatal: ${err.message}`)
    process.exit(1)
})
