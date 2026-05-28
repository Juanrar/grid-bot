// Motor de grid trading simplificado.
// Estado en memoria, reconstruido desde config.json y reconciliado contra
// las órdenes abiertas reales de GRVT en cada arranque/tick.
//
// Estrategia (LONG):
//   - Se generan numGrids+1 niveles equiespaciados entre lowerPrice y upperPrice.
//   - Compra inicial market para respaldar los niveles SELL por encima del precio.
//   - Se deja vacío el nivel más cercano al precio (el "gap" / punto de entrada).
//   - Loop: cuando un nivel se llena, se coloca una contra-orden un nivel
//     arriba/abajo capturando el spread como profit.

import { getInstrumentSpec } from "./grvtClient.js"

const ORDER_ALLOC = 0.75 // margen de seguridad sobre el capital apalancado
const REPLACE_LAG_MS = 10000 // no re-colocar un nivel puesto hace < 10s (lag de GRVT)

export class GridEngine {
    constructor(client, config) {
        this.client = client
        this.config = config
        this.pair = config.pair
        this.spec = getInstrumentSpec(config.pair)
        this.levels = [] // { index, price, side, quantity, isFilled, orderId }
        this.quantityPerLevel = 0
        this.recentlyPlaced = new Map() // index → timestamp
        this.processedFills = new Set() // fill_id procesados
        this.running = false
    }

    // ── Cálculo de niveles ───────────────────────────────────────────

    calculateGridLevels(currentPrice) {
        const { lowerPrice, upperPrice, numGrids, investmentUSDT, leverage, direction } = this.config

        if (currentPrice <= lowerPrice || currentPrice >= upperPrice) {
            throw new Error(
                `Precio actual ${currentPrice} fuera del rango [${lowerPrice}, ${upperPrice}]`
            )
        }

        const spacing = (upperPrice - lowerPrice) / numGrids
        const midPrice = (lowerPrice + upperPrice) / 2
        const effCap = investmentUSDT * leverage * ORDER_ALLOC
        const qtyStep = this.spec.minSize
        const qtyDecimals = this._stepDecimals(qtyStep)

        let qty = Math.max(
            Math.ceil((effCap / numGrids / midPrice) / qtyStep) * qtyStep,
            qtyStep
        )
        // Garantizar min_notional en el precio más bajo (peor caso para buys).
        while (qty * lowerPrice < this.spec.minNotional) {
            qty += qtyStep
        }
        qty = Number(qty.toFixed(qtyDecimals))
        this.quantityPerLevel = qty

        const levels = []
        for (let i = 0; i <= numGrids; i++) {
            const price = Math.round((lowerPrice + i * spacing) * 100) / 100
            let side
            if (direction === "long") {
                side = price < currentPrice ? "buy" : "sell"
            } else {
                side = price > currentPrice ? "sell" : "buy"
            }
            levels.push({ index: i, price, side, quantity: qty, isFilled: false, orderId: null })
        }

        this.levels = levels
        console.log(
            `🧮 Grid: ${numGrids} grids (${levels.length} niveles), spacing $${spacing.toFixed(2)}, ` +
                `qty ${qty} por nivel (effCap $${effCap.toFixed(2)})`
        )
        return levels
    }

    _stepDecimals(step) {
        const s = String(step)
        if (!s.includes(".")) return 0
        return s.split(".")[1].length
    }

    getFixedQty() {
        return this.quantityPerLevel
    }

    // ── Bootstrap ────────────────────────────────────────────────────

    async placeInitialOrders() {
        const currentPrice = await this.client.getPrice(this.pair)
        this.calculateGridLevels(currentPrice)

        console.log(`📊 Precio actual ${this.pair}: $${currentPrice}`)

        let initialInventoryReady = true
        if (this.config.direction === "long") {
            try {
                await this.executeInitialPurchase(currentPrice)
            } catch (err) {
                const msg = String(err?.message ?? "")
                if (msg.includes("Insufficient margin to create order") || msg.includes('"code":2080')) {
                    initialInventoryReady = false
                    console.warn("⚠️  Sin margen para compra inicial. Arranco solo con BUYs por debajo del precio.")
                } else {
                    throw err
                }
            }
        }

        // Nivel "gap": el más cercano al precio actual se deja sin orden.
        const gap = this._closestLevel(currentPrice)
        if (gap) {
            gap.isFilled = true
            console.log(`🕳️  Gap level @ $${gap.price} (se deja vacío)`)
        }

        let placed = 0
        for (const level of this.levels) {
            if (level.isFilled) continue
            if (!this._shouldPlaceOrder(level, currentPrice)) continue
            if (this.config.direction === "long" && !initialInventoryReady && level.side === "sell") continue
            try {
                await this._placeGridOrder(level)
                placed++
                await new Promise((r) => setTimeout(r, 200)) // throttle anti rate-limit
            } catch (err) {
                console.error(`❌ Error colocando nivel ${level.index} @ $${level.price}: ${err.message}`)
            }
        }
        console.log(`✅ Grid inicial colocado: ${placed} órdenes`)
    }

    // Compra market inicial para respaldar todos los niveles SELL por encima
    // del precio (estrategia LONG).
    async executeInitialPurchase(currentPrice) {
        const sellLevelsAbove = this.levels.filter((l) => l.price > currentPrice)
        if (sellLevelsAbove.length === 0) return

        const totalQty = sellLevelsAbove.reduce((sum, l) => sum + l.quantity, 0)
        const notional = totalQty * currentPrice
        if (notional < this.spec.minNotional) {
            console.log(`⚠️  Compra inicial omitida: notional $${notional.toFixed(2)} < min`)
            return
        }

        // Precio ligeramente por encima del ask para asegurar fill (IOC).
        const ticker = await this.client.getTicker(this.pair)
        const ask = parseFloat(ticker.best_ask_price ?? ticker.best_ask ?? ticker.last_price)
        const safePrice = Math.floor(ask * 1.001 * 100) / 100
        const size = (Math.floor(totalQty * 100) / 100).toString()

        console.log(`💰 Compra inicial: BUY ${size} ${this.pair} @ ~$${safePrice} (IOC, notional $${notional.toFixed(2)})`)
        await this.client.createOrder(
            {
                instrument: this.pair,
                side: "buy",
                size,
                price: safePrice.toString(),
                type: "limit",
                timeInForce: "ioc",
            },
            true
        )
        // Damos un momento a que ejecute antes de colocar el grid.
        await new Promise((r) => setTimeout(r, 2000))
    }

    _closestLevel(currentPrice) {
        let best = null
        let minDist = Infinity
        for (const level of this.levels) {
            if (level.isFilled) continue
            const d = Math.abs(level.price - currentPrice)
            if (d < minDist) {
                minDist = d
                best = level
            }
        }
        return best
    }

    _shouldPlaceOrder(level, currentPrice) {
        if (this.config.direction === "long") {
            return (
                (level.side === "buy" && level.price < currentPrice) ||
                (level.side === "sell" && level.price > currentPrice)
            )
        }
        return (
            (level.side === "sell" && level.price > currentPrice) ||
            (level.side === "buy" && level.price < currentPrice)
        )
    }

    async _placeGridOrder(level) {
        const notional = level.quantity * level.price
        if (notional < this.spec.minNotional) {
            console.log(`⚠️  Skip nivel ${level.index}: notional $${notional.toFixed(2)} < min`)
            return
        }
        this.recentlyPlaced.set(level.index, Date.now())
        const order = await this.client.createOrder({
            instrument: this.pair,
            side: level.side,
            size: level.quantity.toString(),
            price: level.price.toString(),
            type: "limit",
            timeInForce: "gtc",
        })
        level.orderId = order.order_id
        level.isFilled = false
        console.log(`📝 ${level.side.toUpperCase()} ${level.quantity} @ $${level.price} (nivel ${level.index})`)
    }

    // ── Monitor loop ─────────────────────────────────────────────────

    async monitor() {
        const openOrders = await this.client.getOpenOrders(this.pair)
        const currentPrice = await this.client.getPrice(this.pair)

        // Mapa precio→orden de GRVT.
        const grvtPriceSet = new Set()
        const grvtOrderMap = new Map()
        for (const order of openOrders) {
            const leg = order.legs?.[0]
            if (!leg?.limit_price) continue
            const price = Math.round(parseFloat(leg.limit_price) * 100) / 100
            grvtPriceSet.add(price)
            grvtOrderMap.set(price, {
                orderId: order.order_id,
                side: leg.is_buying_asset ? "buy" : "sell",
            })
        }

        const gridStep = (this.config.upperPrice - this.config.lowerPrice) / this.config.numGrids
        const matchTolerance = Math.min(0.05, gridStep / 3)

        // Reconciliar niveles con la realidad de GRVT.
        const uncovered = []
        for (const level of this.levels) {
            const lp = Math.round(level.price * 100) / 100
            let covered = false
            for (const gp of grvtPriceSet) {
                if (Math.abs(gp - lp) < matchTolerance) {
                    const o = grvtOrderMap.get(gp)
                    level.orderId = o.orderId
                    level.side = o.side
                    level.isFilled = false
                    grvtPriceSet.delete(gp) // consumir para evitar doble match
                    covered = true
                    break
                }
            }
            if (!covered) uncovered.push({ level, dist: Math.abs(lp - currentPrice) })
        }

        uncovered.sort((a, b) => a.dist - b.dist)
        console.log(
            `📊 Monitor: ${openOrders.length} órdenes GRVT, ${uncovered.length} sin cubrir, precio $${currentPrice.toFixed(2)}`
        )

        // El nivel sin cubrir más cercano es el gap natural.
        if (uncovered.length > 0) {
            uncovered[0].level.isFilled = true
            uncovered[0].level.orderId = null
        }

        const filledLevels = []
        if (uncovered.length > 1) {
            const recentFills = await this.client.getFillHistory(50, this.pair)
            const now = Date.now()

            for (let i = 1; i < uncovered.length; i++) {
                const { level } = uncovered[i]

                // ¿Fue un fill reciente?
                const fill = recentFills.find((f) => {
                    const fp = parseFloat(f.price)
                    const ft = parseInt(f.event_time ?? "0") / 1e6
                    return Math.abs(fp - level.price) < 1.0 && now - ft < 90000
                })

                if (fill) {
                    const fillKey = fill.fill_id ?? fill.trade_id ?? `fill-${level.price}-${now}`
                    if (!this.processedFills.has(fillKey)) {
                        this.processedFills.add(fillKey)
                        if (this.processedFills.size > 200) {
                            ;[...this.processedFills].slice(0, 100).forEach((k) => this.processedFills.delete(k))
                        }
                        console.log(`✅ Fill confirmado: ${level.side} @ $${level.price}`)
                        filledLevels.push(level)
                    }
                    continue
                }

                // Guard de lag: colocada hace poco → no re-colocar todavía.
                const placedAt = this.recentlyPlaced.get(level.index)
                if (placedAt && now - placedAt < REPLACE_LAG_MS) continue

                // Re-colocar la orden faltante.
                const correctSide = level.price < currentPrice ? "buy" : "sell"
                level.side = correctSide
                level.quantity = this.getFixedQty()
                level.isFilled = false
                console.log(`⚠️  Re-colocando: ${correctSide} @ $${level.price}`)
                try {
                    await this._placeGridOrder(level)
                } catch (err) {
                    console.error(`❌ Falló re-colocar @ $${level.price}: ${err.message}`)
                }
            }
        }

        await this._killDuplicatesAndOrphans(openOrders)
        await this._placeCounterOrders(filledLevels, currentPrice)
    }

    // Mata órdenes duplicadas (mismo precio) y huérfanas (precio sin nivel esperado).
    async _killDuplicatesAndOrphans(openOrders) {
        const expectedLevels = this.levels.filter((l) => !l.isFilled)
        if (openOrders.length <= expectedLevels.length) return

        console.log(`🔴 ${openOrders.length} órdenes (esperadas ≤${expectedLevels.length}) — limpiando`)

        // Paso 1: duplicados exactos por precio.
        const byPrice = new Map()
        for (const order of openOrders) {
            const leg = order.legs?.[0]
            if (!leg?.limit_price) continue
            const pk = parseFloat(leg.limit_price).toFixed(2)
            if (!byPrice.has(pk)) byPrice.set(pk, [])
            byPrice.get(pk).push(order)
        }

        const survivors = []
        for (const [price, orders] of byPrice) {
            survivors.push(orders[0])
            for (let i = 1; i < orders.length; i++) {
                await this.client.cancelOrder(orders[i].order_id, this.pair)
                console.log(`🗑️  Duplicado eliminado @ $${price}`)
            }
        }

        // Paso 2: huérfanas — precio que no coincide con ningún nivel esperado.
        const expectedPrices = new Set(expectedLevels.map((l) => l.price.toFixed(2)))
        for (const order of survivors) {
            const leg = order.legs?.[0]
            if (!leg?.limit_price) continue
            const pk = parseFloat(leg.limit_price).toFixed(2)
            if (!expectedPrices.has(pk)) {
                await this.client.cancelOrder(order.order_id, this.pair)
                console.log(`🗑️  Huérfana eliminada @ $${pk}`)
            }
        }
    }

    // Por cada nivel llenado, coloca la contra-orden un nivel arriba/abajo.
    async _placeCounterOrders(filledLevels, currentPrice) {
        for (const level of filledLevels) {
            let counterIndex, counterSide
            if (level.side === "buy") {
                counterIndex = level.index + 1
                counterSide = "sell"
            } else {
                counterIndex = level.index - 1
                counterSide = "buy"
            }

            const counter = this.levels.find((l) => l.index === counterIndex)
            if (!counter) {
                console.log(`⚠️  Sin nivel contrario para index ${counterIndex}, omitido`)
                continue
            }

            // Si el nivel destino ya tiene orden activa, no duplicar.
            if (counter.orderId && !counter.isFilled) {
                level.isFilled = true
                level.orderId = null
                continue
            }

            const qty = this.getFixedQty()
            console.log(
                `🔄 Round-trip: ${level.side} lleno @ $${level.price} → ${counterSide} ${qty} @ $${counter.price}`
            )
            try {
                counter.side = counterSide
                counter.quantity = qty
                counter.isFilled = false
                await this._placeGridOrder(counter)
                level.isFilled = true
                level.orderId = null
            } catch (err) {
                console.error(`❌ Falló contra-orden @ $${counter.price}: ${err.message}`)
            }
        }
    }

    // ── Ciclo de vida ────────────────────────────────────────────────

    start(intervalMs = 5000) {
        this.running = true
        this.interval = setInterval(async () => {
            if (!this.running) return
            try {
                await this.monitor()
            } catch (err) {
                console.error(`❌ Error en monitor: ${err.message}`)
            }
        }, intervalMs)
        console.log(`🚀 Monitor iniciado (cada ${intervalMs / 1000}s)`)
    }

    async stop() {
        this.running = false
        if (this.interval) clearInterval(this.interval)
        console.log("🛑 Deteniendo bot — cancelando todas las órdenes...")
        const cancelled = await this.client.cancelAllOrders(this.pair)
        console.log(`✅ ${cancelled} órdenes canceladas. Posición (si hay) NO se cierra.`)
    }
}
