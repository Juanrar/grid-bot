import { BinanceClient } from "./src/binanceClient.js";

async function main(){
    const apiKey = process.env.BINANCE_API_KEY
    const secretKey = process.env.BINANCE_SECRET_KEY

    const client = new BinanceClient(apiKey, secretKey)
    const price = await client.getPrice("BTCUSDT")
    console.log(`The price of BTCUSDT is ${price}`)
}

main().catch(console.error);