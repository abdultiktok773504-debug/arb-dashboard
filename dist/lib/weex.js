"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWeexBalance = getWeexBalance;
exports.placeWeexMarketOrder = placeWeexMarketOrder;
const crypto_1 = __importDefault(require("crypto"));
// WEEX uses Bitget infrastructure
// Replit blocks api.bitget.com for WEEX keys — use Render.com or VPS
const BASE = "https://api.bitget.com";
const API_KEY = process.env.WEEX_API_KEY ?? "";
const API_SECRET = process.env.WEEX_API_SECRET ?? "";
const PASSPHRASE = process.env.WEEX_API_PASSPHRASE ?? "";
function sign(timestamp, method, path, body = "") {
    const prehash = timestamp + method.toUpperCase() + path + body;
    return crypto_1.default.createHmac("sha256", API_SECRET).update(prehash).digest("base64");
}
async function signedRequest(method, path, bodyObj) {
    // Bitget requires timestamp in MILLISECONDS as string
    const timestamp = Date.now().toString();
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
    const signature = sign(timestamp, method, path, bodyStr);
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            "ACCESS-KEY": API_KEY,
            "ACCESS-SIGN": signature,
            "ACCESS-TIMESTAMP": timestamp,
            "ACCESS-PASSPHRASE": PASSPHRASE,
            "Content-Type": "application/json",
            locale: "en-US",
        },
        body: bodyStr || undefined,
        signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const d = data;
    if (d["code"] && d["code"] !== "00000") {
        console.warn(`[WEEX] API error code=${d["code"]} msg=${d["msg"]} path=${path}`);
    }
    return data;
}
async function getWeexBalance(coin) {
    try {
        const data = (await signedRequest("GET", "/api/v2/spot/account/assets"));
        const bal = data.data?.find((b) => b.coin === coin);
        return bal ? parseFloat(bal.available) : 0;
    }
    catch {
        return 0;
    }
}
async function placeWeexMarketOrder(symbol, side, usdtSize, coinSize) {
    try {
        const body = {
            symbol: symbol.replace("/", ""),
            side,
            orderType: "market",
            force: "gtc",
        };
        if (side === "buy" && usdtSize !== undefined)
            body.size = usdtSize.toFixed(2);
        else if (coinSize !== undefined)
            body.size = coinSize;
        const data = (await signedRequest("POST", "/api/v2/spot/trade/place-order", body));
        if (data.data?.orderId)
            return { success: true, orderId: data.data.orderId };
        return { success: false, error: data.msg ?? JSON.stringify(data) };
    }
    catch (err) {
        return { success: false, error: String(err) };
    }
}
