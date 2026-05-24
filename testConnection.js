import { BinanceClient } from "./src/binanceClient.js";
import dotenv from "dotenv"

dotenv.config()

async function main(){
    const apiKey = process.env.BINANCE_API_KEY
    const secretKey = process.env.BINANCE_API_SECRET

    const client = new BinanceClient(apiKey, secretKey)
    const price = await client.getPrice("BTCUSDT")
    console.log(`The price of BTCUSDT is ${price}`)

    const openOrders = await client.getOpenOrders("BTCUSDT")
    console.log("Open Orders:", openOrders)
}

main().catch((err) => {
  console.error("ERROR:", err);
  if (err.response) {
    console.error("RESPONSE DATA:", err.response.data);
  }
});