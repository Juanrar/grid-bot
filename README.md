# grid-bot

Bot de **grid trading** para el exchange de perpetuos [GRVT](https://grvt.io).
Coloca una rejilla de órdenes límite entre un precio mínimo y máximo y captura
el spread cada vez que el precio oscila dentro del rango. Escrito en Node.js
(ESM puro, sin build).

## ¿Cómo funciona?

La estrategia (en modo `long`) divide el rango `[lowerPrice, upperPrice]` en
`numGrids` niveles equiespaciados:

- Los niveles **por debajo** del precio actual son órdenes de **compra**.
- Los niveles **por encima** son órdenes de **venta** (respaldadas por una
  compra market inicial que arma el inventario).
- El nivel más cercano al precio se deja vacío (el "gap" o punto de entrada).
- Cuando un nivel se llena, el bot coloca automáticamente la **contra-orden** un
  nivel más arriba/abajo, capturando la diferencia como ganancia.

El estado de la rejilla vive **en memoria** y se reconcilia contra las órdenes
reales de GRVT en cada tick del monitor, así que el bot se autocorrige si una
orden se cancela o queda desincronizada.

---

## Instalación

```bash
git clone <tu-repo> grid-bot
cd grid-bot
npm install
```

---

## Configuración

### 1. Credenciales (`.env`)

Copiá `.env.example` a `.env` y completá tus credenciales de GRVT:

```bash
GRVT_API_KEY=               # API key
GRVT_API_SECRET=0x...       # private key de firma EIP-712 — ¡trátala como una llave de wallet!
GRVT_TRADING_ACCOUNT_ID=    # sub-account id
GRVT_TRADING_ADDRESS=0x...  # dirección del signer
```

### 2. Parámetros de la rejilla (`config.json`)

```jsonc
{
  "pair": "ETH_USDT_Perp",   // instrumento (ver instrumentos soportados)
  "direction": "long",       // estrategia
  "leverage": 20,            // apalancamiento
  "lowerPrice": 1900,        // límite inferior del rango
  "upperPrice": 2200,        // límite superior del rango
  "numGrids": 60,            // cantidad de niveles
  "investmentUSDT": 60,      // capital a usar (en USDT)
  "monitorIntervalMs": 5000  // frecuencia del loop de monitoreo (opcional)
}
```

**Validaciones**: `lowerPrice` debe ser menor que `upperPrice`, `numGrids ≥ 1`,
y el precio actual debe caer dentro del rango al arrancar. La cantidad por nivel
se calcula a partir de `investmentUSDT * leverage` y se ajusta para cumplir el
notional mínimo del instrumento.

### 3. Cómo elegir el par

Conviene operar pares donde el **costo mínimo por orden sea bajo**: cuanto más
chica es la orden mínima, más grillas podés meter en el mismo capital y mejor
aprovechás los movimientos del precio.

| Par  | Tamaño mínimo | Notional aproximado |
| ---- | ------------- | ------------------- |
| BTC  | 0.002         | ~147 USDT           |
| ETH  | 0.010         | ~20 USDT            |
| SOL  | 0.07          | ~5 USDT             |

La orden mínima (en USDT) es mucho menor en monedas con menor valor por unidad,
así que con el mismo capital armás una rejilla más densa.

> Actualmente solo están cableados `ETH_USDT_Perp` y `BTC_USDT_Perp` en
> `INSTRUMENT_SPECS` (`src/grvtClient.js`). Para usar otro par (p. ej. SOL),
> agregá ahí su spec: `assetId`, decimales, `tickSize`, `minSize` y `minNotional`.

---

## Uso

```bash
npm start
```

El bot hace login, configura el apalancamiento (si la API lo permite), coloca
la rejilla inicial y arranca el loop de monitoreo. Para detenerlo, `Ctrl+C`:
hace un **apagado limpio que cancela las órdenes abiertas, pero NO cierra la
posición** (el inventario queda en tu cuenta).

### Reinicios seguros

`placeInitialOrders()` es **idempotente**: al arrancar inspecciona las órdenes y
la posición reales antes de comprar o colocar nada.

- Si ya hay órdenes vivas → no toca nada, el monitor reconcilia.
- Si hay posición pero sin órdenes → coloca la rejilla **sin recomprar**.
- Solo en un arranque limpio (sin posición ni órdenes) hace la compra inicial.

Esto evita duplicar la posición cuando se reinicia la PC o el gestor de procesos.

---

### Windows (Tarea Programada)

Para arrancar el bot al iniciar sesión, con ventana oculta:

```powershell
# Como administrador, una sola vez:
powershell -ExecutionPolicy Bypass -File crear-tarea.ps1
```

Registra la tarea `GridBot` (arranca 1 min después del login). Para quitarla,
ejecutá `borrar-tarea.ps1`. Los logs van a `logs\bot.log`.

> Estos scripts usan la ruta absoluta del proyecto; actualizalos si movés la
> carpeta.