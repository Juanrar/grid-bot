// Cliente GRVT simplificado: market data (público) + trading (autenticado).
// Solo cubre lo necesario para operar un grid de ETH_USDT_Perp.

import { GrvtAuth } from "./grvtAuth.js";
import { buildSignedOrder } from "./orderSigner.js";

const MARKET_DATA_URL = "https://market-data.grvt.io/full/v1";
const TRADING_URL = "https://trades.grvt.io/full/v1";

// Specs de instrumentos. Suficiente para firmar y validar órdenes sin
// llamar al endpoint dinámico /instruments.
export const INSTRUMENT_SPECS = {
  ETH_USDT_Perp: {
    instrument: "ETH_USDT_Perp",
    assetId: "0x030401",
    baseDecimals: 9,
    minSize: 0.001,
    minNotional: 20,
    tickSize: 0.01,
  },
  BTC_USDT_Perp: {
    instrument: "BTC_USDT_Perp",
    assetId: "0x030501",
    baseDecimals: 9,
    minSize: 0.001,
    minNotional: 100,
    tickSize: 0.1,
  },
  SOL_USDT_Perp: {
    instrument: "SOL_USDT_Perp",
    assetId: "0x030601", // ID de activo (si falla la firma, verifica este ID en la API de GRVT)
    baseDecimals: 9,
    minSize: 0.07,
    minNotional: 5,
    tickSize: 0.01,
  },
};

export function getInstrumentSpec(pair) {
  const spec = INSTRUMENT_SPECS[pair];
  if (!spec) throw new Error(`Instrumento no soportado: ${pair}`);
  return spec;
}

// Limita a ~10 requests/segundo (límite de GRVT).
class RateLimiter {
  constructor(maxRequests = 10, windowMs = 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  async wait() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      const oldest = this.timestamps[0];
      const waitMs = this.windowMs - (now - oldest) + 50;
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    }
    this.timestamps.push(Date.now());
  }
}

export class GrvtClient {
  constructor({ apiKey, apiSecret, tradingAddress, accountId }) {
    this.auth = new GrvtAuth(apiKey);
    this.signingCreds = {
      privateKey: apiSecret,
      signerAddress: tradingAddress,
      subAccountId: accountId,
    };
    this.subAccountId = accountId;
    this.rateLimiter = new RateLimiter();
  }

  async login() {
    return this.auth.login();
  }

  // ── Helpers de request ──────────────────────────────────────────

  async _publicRequest(url, body = {}, timeout = 15000) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "grid-bot/1.0",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} en ${url}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.result ?? data;
  }

  async _authedRequest(url, body = {}, timeout = 30000) {
    await this.rateLimiter.wait();
    await this.auth.ensureAuth();

    const doFetch = () =>
      fetch(url, {
        method: "POST",
        headers: this.auth.authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });

    let res = await doFetch();

    // Sesión expirada: re-autenticar una vez y reintentar.
    if (res.status === 401) {
      this.auth.invalidate();
      await this.auth.ensureAuth();
      res = await doFetch();
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} en ${url}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.result ?? data;
  }

  // ── Market data (público) ───────────────────────────────────────

  async getTicker(instrument) {
    return this._publicRequest(`${MARKET_DATA_URL}/ticker`, { instrument });
  }

  async getPrice(instrument) {
    const ticker = await this.getTicker(instrument);
    return parseFloat(ticker.last_price);
  }

  // ── Trading (autenticado) ───────────────────────────────────────

  async getPositions() {
    const data = await this._authedRequest(`${TRADING_URL}/positions`, {
      sub_account_id: this.subAccountId,
    });
    return Array.isArray(data) ? data : [];
  }

  async getPosition(instrument) {
    const positions = await this.getPositions();
    return positions.find((p) => p.instrument === instrument) ?? null;
  }

  async getOpenOrders(instrument) {
    const body = { sub_account_id: this.subAccountId };
    if (instrument) body.instrument = instrument;
    const data = await this._authedRequest(`${TRADING_URL}/open_orders`, body);
    const all = Array.isArray(data) ? data : [];
    if (!instrument) return all;
    // GRVT a veces ignora el filtro de instrumento; filtramos client-side.
    return all.filter((o) => {
      if (o.instrument === instrument) return true;
      return o.legs?.[0]?.instrument === instrument;
    });
  }

  async getFillHistory(limit = 100, instrument) {
    const body = {
      sub_account_id: this.subAccountId,
      limit: Math.min(limit, 1000),
    };
    if (instrument) body.instrument = instrument;
    const data = await this._authedRequest(`${TRADING_URL}/fill_history`, body);
    return Array.isArray(data) ? data : [];
  }

  async setLeverage(instrument, leverage) {
    await this._authedRequest(`${TRADING_URL}/set_leverage`, {
      sub_account_id: this.subAccountId,
      instrument,
      leverage: String(leverage),
    });
    return true;
  }

  // Valida tamaño/notional/tick antes de firmar.
  _validateOrder(spec, size, price) {
    const sizeNum = parseFloat(size);
    const priceNum = parseFloat(price);
    if (sizeNum < spec.minSize) {
      throw new Error(
        `Size ${size} < min_size ${spec.minSize} para ${spec.instrument}`,
      );
    }
    const notional = sizeNum * priceNum;
    if (notional < spec.minNotional) {
      throw new Error(
        `Notional $${notional.toFixed(2)} < min_notional $${spec.minNotional}`,
      );
    }
  }

  /**
   * Crea una orden firmada con EIP-712.
   * @param {object} req - { instrument, side, size, price, type, timeInForce?, postOnly? }
   * @param {boolean} allowMarket - permite IOC/market (compra inicial / cierre)
   */
  async createOrder(req, allowMarket = false) {
    await this.rateLimiter.wait();
    const spec = getInstrumentSpec(req.instrument);
    const isMarket = req.type === "market";

    if (isMarket && !allowMarket) {
      throw new Error(
        "Solo se permiten órdenes limit (usar allowMarket=true para casos especiales)",
      );
    }
    if (!isMarket) this._validateOrder(spec, req.size, req.price);

    // time_in_force: gtc=1, ioc=3
    const tifMap = { gtc: 1, ioc: 3 };
    const timeInForce = tifMap[req.timeInForce ?? "gtc"] ?? 1;

    const payload = buildSignedOrder(
      {
        side: req.side,
        size: req.size,
        price: req.price,
        isMarket,
        timeInForce,
        postOnly: req.postOnly ?? false,
      },
      this.signingCreds,
      spec,
    );

    const data = await this._authedRequest(
      `${TRADING_URL}/create_order`,
      payload,
    );
    const orderId = data.order_id ?? data.result?.order_id;

    return {
      order_id: orderId,
      instrument: req.instrument,
      side: req.side,
      size: req.size,
      price: req.price ?? "0",
      status: "open",
    };
  }

  async cancelOrder(orderId, instrument) {
    try {
      await this._authedRequest(`${TRADING_URL}/cancel_order`, {
        sub_account_id: this.subAccountId,
        order_id: orderId,
        instrument,
      });
      return true;
    } catch (err) {
      console.error(`Error cancelando orden ${orderId}: ${err.message}`);
      return false;
    }
  }

  async cancelAllOrders(instrument) {
    const body = { sub_account_id: this.subAccountId };
    if (instrument) body.instrument = instrument;
    try {
      const data = await this._authedRequest(
        `${TRADING_URL}/cancel_all_orders`,
        body,
      );
      return data.cancelled_count ?? 0;
    } catch (err) {
      console.error(`Error cancelando todas las órdenes: ${err.message}`);
      return 0;
    }
  }
}
