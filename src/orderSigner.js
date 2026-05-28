// Firma de órdenes GRVT con EIP-712 (V4).
// Portado de la implementación verificada del repo original.
// CRÍTICO: PRICE_MULTIPLIER = 1e9 (no usar quote_decimals).

import { SignTypedDataVersion, signTypedData } from "@metamask/eth-sig-util"

const EIP712_DOMAIN = {
    name: "GRVT Exchange",
    version: "0",
    chainId: 325, // GRVT producción
}

const EIP712_TYPES = {
    EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
    ],
    Order: [
        { name: "subAccountID", type: "uint64" },
        { name: "isMarket", type: "bool" },
        { name: "timeInForce", type: "uint8" },
        { name: "postOnly", type: "bool" },
        { name: "reduceOnly", type: "bool" },
        { name: "legs", type: "OrderLeg[]" },
        { name: "nonce", type: "uint32" },
        { name: "expiration", type: "int64" },
    ],
    OrderLeg: [
        { name: "assetID", type: "uint256" },
        { name: "contractSize", type: "uint64" },
        { name: "limitPrice", type: "uint64" },
        { name: "isBuyingContract", type: "bool" },
    ],
}

const PRICE_MULTIPLIER = 1e9

// time_in_force numérico → string del API.
const TIF_NUM_TO_STRING = {
    1: "GOOD_TILL_TIME", // GTC
    3: "IMMEDIATE_OR_CANCEL", // IOC
}

function generateNonce() {
    return Math.floor(Math.random() * 1e9)
}

// Expiración en nanosegundos (default 24h).
function generateExpiration(hours = 24) {
    const ms = Date.now() + hours * 3600000
    return (ms * 1e6).toString()
}

function roundToTickSize(price, tickSize) {
    return Math.floor(price / tickSize) * tickSize
}

// price (string) → limitPrice entero usando PRICE_MULTIPLIER.
function priceToLimitPrice(price, tickSize) {
    const p = roundToTickSize(parseFloat(price), tickSize)
    return Math.round(p * PRICE_MULTIPLIER).toString()
}

// size (string) → contractSize en base units (base_decimals).
function sizeToContractSize(size, spec) {
    const sized = Math.floor(parseFloat(size) / spec.minSize) * spec.minSize
    const contractSize = Math.round(sized * Math.pow(10, spec.baseDecimals))
    return contractSize.toString()
}

// Redondea un precio al tick size para enviarlo al API (string human-readable).
export function roundPrice(price, tickSize) {
    const p = typeof price === "string" ? parseFloat(price) : price
    return roundToTickSize(p, tickSize).toString()
}

/**
 * Firma una orden y devuelve el payload listo para POST /create_order.
 *
 * @param {object} params - { side: 'buy'|'sell', size, price, isMarket?, timeInForce?, postOnly? }
 * @param {object} creds  - { privateKey, signerAddress, subAccountId }
 * @param {object} spec   - { instrument, assetId, baseDecimals, minSize, tickSize }
 */
export function buildSignedOrder(params, creds, spec) {
    const {
        side,
        size,
        price,
        isMarket = false,
        timeInForce = 1,
        postOnly = false,
    } = params

    if (!isMarket && price == null) {
        throw new Error("Precio requerido para órdenes limit")
    }
    if (!creds.privateKey || !creds.signerAddress || !creds.subAccountId) {
        throw new Error("Credenciales de firma incompletas (privateKey / signerAddress / subAccountId)")
    }

    const nonce = generateNonce()
    const expiration = generateExpiration(24)
    const contractSize = sizeToContractSize(size, spec)
    const limitPrice = isMarket ? "0" : priceToLimitPrice(price, spec.tickSize)
    const isBuyingContract = side === "buy"

    const orderMessage = {
        subAccountID: creds.subAccountId,
        isMarket,
        timeInForce,
        postOnly,
        reduceOnly: false,
        legs: [
            {
                assetID: spec.assetId,
                contractSize,
                limitPrice,
                isBuyingContract,
            },
        ],
        nonce,
        expiration,
    }

    const typedData = {
        primaryType: "Order",
        domain: EIP712_DOMAIN,
        types: EIP712_TYPES,
        message: orderMessage,
    }

    const signature = signTypedData({
        privateKey: Buffer.from(creds.privateKey.replace(/^0x/, ""), "hex"),
        data: typedData,
        version: SignTypedDataVersion.V4,
    })

    const r = "0x" + signature.slice(2, 66)
    const s = "0x" + signature.slice(66, 130)
    const v = parseInt(signature.slice(130, 132), 16)

    // Payload con valores human-readable que espera /create_order.
    return {
        order: {
            sub_account_id: creds.subAccountId,
            is_market: isMarket,
            time_in_force: TIF_NUM_TO_STRING[timeInForce] ?? "GOOD_TILL_TIME",
            post_only: postOnly,
            reduce_only: false,
            legs: [
                {
                    instrument: spec.instrument,
                    size: roundPrice(size, spec.minSize),
                    limit_price: isMarket ? undefined : roundPrice(price, spec.tickSize),
                    is_buying_asset: isBuyingContract,
                },
            ],
            signature: {
                signer: creds.signerAddress,
                r,
                s,
                v,
                expiration,
                nonce,
            },
            metadata: {
                client_order_id: String(Date.now()),
            },
        },
    }
}
