import axios from "axios"
import crypto from "cripto"

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

    async getPrice(symbol) {
        const response = await this.http.get("/api/v3/ticker/price", {
            params: {
                symbol
            },
        })
        return parseFloat(response.data.price)
    }
}
