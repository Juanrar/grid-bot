// Autenticación con GRVT.
// Flujo: POST https://edge.grvt.io/auth/api_key/login con { api_key }
// → respuesta trae Set-Cookie: gravity=XXX y header X-Grvt-Account-Id.
// Esos dos valores se usan en todas las llamadas autenticadas de trading.

import dns from "dns"

// GRVT resuelve mal sobre IPv6 en algunas redes; forzamos IPv4.
dns.setDefaultResultOrder("ipv4first")

const LOGIN_URL = "https://edge.grvt.io/auth/api_key/login"
const SESSION_TTL_MS = 23 * 60 * 60 * 1000 // 23h (margen de seguridad sobre 24h)
const REAUTH_MARGIN_MS = 60 * 60 * 1000 // re-auth cuando queda menos de 1h

export class GrvtAuth {
    constructor(apiKey) {
        if (!apiKey) throw new Error("GRVT_API_KEY no configurada en .env")
        this.apiKey = apiKey
        this.gravityCookie = ""
        this.accountId = ""
        this.expiresAt = 0
    }

    get isAuthenticated() {
        return !!this.gravityCookie && Date.now() < this.expiresAt
    }

    async login() {
        const res = await fetch(LOGIN_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "grid-bot/1.0",
            },
            body: JSON.stringify({ api_key: this.apiKey }),
        })

        if (!res.ok) {
            const text = await res.text()
            throw new Error(`Login GRVT falló (${res.status}): ${text}`)
        }

        const setCookie = res.headers.get("set-cookie")
        const accountId = res.headers.get("x-grvt-account-id")
        if (!setCookie || !accountId) {
            throw new Error("Login GRVT: faltan headers set-cookie / x-grvt-account-id")
        }

        const match = setCookie.match(/gravity=([^;]+)/)
        if (!match) throw new Error("Login GRVT: cookie 'gravity' no encontrada")

        this.gravityCookie = match[1]
        this.accountId = accountId
        this.expiresAt = Date.now() + SESSION_TTL_MS

        const hours = Math.floor(SESSION_TTL_MS / 1000 / 3600)
        console.log(`🔐 Autenticado con GRVT (account ${accountId}, sesión ~${hours}h)`)
        return true
    }

    // Garantiza una sesión válida antes de cada request de trading.
    async ensureAuth() {
        if (!this.gravityCookie || Date.now() > this.expiresAt - REAUTH_MARGIN_MS) {
            await this.login()
        }
    }

    // Headers para las llamadas autenticadas.
    authHeaders() {
        return {
            "Content-Type": "application/json",
            "Cookie": `gravity=${this.gravityCookie}`,
            "X-Grvt-Account-Id": this.accountId,
            "User-Agent": "grid-bot/1.0",
        }
    }

    // Invalida la sesión (forzar re-login en el próximo request).
    invalidate() {
        this.gravityCookie = ""
        this.expiresAt = 0
    }
}
