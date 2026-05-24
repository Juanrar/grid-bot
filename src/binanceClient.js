import axios from "axios"
import crypto from "crypto"

const BASE_URL = "https://api.binance.com"

export class BinanceClient{
    constructor(apiKey, secretKey){
        this.apiKey = apiKey
        this.secretKey = secretKey

        this.http = axios.create({
            baseURL: BASE_URL,
            headers: {
                "X-MBX-APIKEY": this.apiKey
            }
        })
    }

    // firma para las solicitudes privadas
    _sign(queryString) {
        return crypto
        .createHmac('sha256', this.secretKey)
        .update(queryString)
        .digest('hex')
    }
    
    // Construye los params firmados agregando timestamp + signature
    _signedParams(params = {}) {
        const timestamp = Date.now();
        const allParams = { ...params, timestamp };
        const queryString = new URLSearchParams(allParams).toString();
        const signature = this._sign(queryString);
        return { ...allParams, signature };
    }

    async getPrice(symbol) {
        const response = await this.http.get("/api/v3/ticker/price", {
            params: {
                symbol
            },
        })
        return parseFloat(response.data.price)
    }

    async getAccountInfo(){
        const query = this._signedParams()
        const response = await this.http.get("/api/v3/account", {
        params: query
        });

        const balances = response.data.balances.filter(
            (b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
        )

        return balances.map((b) => ({
            asset: b.asset,
            free: parseFloat(b.free),
            locked: parseFloat(b.locked),
            total: parseFloat(b.free) + parseFloat(b.locked)
        }))
    }

    async getOpenOrders(symbol) {
        const query = this._signedParams({ symbol })
        const res = await this.http.get("/api/v3/openOrders", { params: query })
        return res.data
    }
}
