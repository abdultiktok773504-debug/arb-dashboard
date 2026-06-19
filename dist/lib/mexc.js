"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMexcBalance = getMexcBalance;
exports.placeMexcMarketOrder = placeMexcMarketOrder;
exports.getMexcAssetQty = getMexcAssetQty;
const crypto_1 = __importDefault(require("crypto"));
const BASE = "https://api.mexc.com";
const API_KEY = process.env.MEXC_API_KEY ?? "";
const API_SECRET = process.env.MEXC_API_SECRET ?? "";
function sign(queryString) {
    return crypto_1.default.createHmac("sha256", API_SECRET).update(queryString).digest("hex");
}
function buildQuery(params) {
    return Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
}
async function signedRequest(method, path, params = {}) {
    const timestamp = Date.now();
    const allParams = { ...params, timestamp };
    const queryString = buildQuery(allParams);
    const signature = sign(queryString);
    const url = method === "GET" || method === "DELETE"
        ? `${BASE}${path}?${queryString}&signature=${signature}`
        : `${BASE}${path}`;
    const body = method === "POST" ? `${queryString}&signature=${signature}` : undefined;
    const res = await fetch(url, {
        method,
        headers: {
            "X-MEXC-APIKEY": API_KEY,
            ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body,
        signal: AbortSignal.timeout(8000),
    });
    return res.json();
}
async function getMexcBalance(asset) {
    try {
        const data = (await signedRequest("GET", "/api/v3/account"));
        const bal = data.balances?.find((b) => b.asset === asset);
        return bal ? parseFloat(bal.free) : 0;
    }
    catch {
        return 0;
    }
}
async function placeMexcMarketOrder(symbol, side, quoteQty, qty) {
    try {
        const params = {
            symbol: symbol.replace("/", ""),
            side,
            type: "MARKET",
        };
        if (side === "BUY" && quoteQty !== undefined)
            params.quoteOrderQty = quoteQty.toFixed(2);
        else if (qty !== undefined)
            params.quantity = qty;
        const data = (await signedRequest("POST", "/api/v3/order", params));
        if (data.orderId)
            return { success: true, orderId: String(data.orderId) };
        return { success: false, error: data.msg ?? "Unknown error" };
    }
    catch (err) {
        return { success: false, error: String(err) };
    }
}
async function getMexcAssetQty(symbol, usdtSpend, price) {
    try {
        const infoRes = await fetch(`${BASE}/api/v3/exchangeInfo?symbol=${symbol.replace("/", "")}`, { signal: AbortSignal.timeout(5000) });
        const info = (await infoRes.json());
        const stepSize = info.symbols?.[0]?.filters?.find((f) => f.filterType === "LOT_SIZE")?.stepSize ?? "1";
        const step = parseFloat(stepSize);
        return Math.floor((usdtSpend / price) / step) * step;
    }
    catch {
        return usdtSpend / price;
    }
}
