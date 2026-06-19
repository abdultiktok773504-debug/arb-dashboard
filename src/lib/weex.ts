import crypto from "crypto";

// WEEX uses Bitget infrastructure
// Replit blocks api.bitget.com for WEEX keys — use Render.com or VPS
const BASE = "https://api.bitget.com";
const API_KEY = process.env.WEEX_API_KEY ?? "";
const API_SECRET = process.env.WEEX_API_SECRET ?? "";
const PASSPHRASE = process.env.WEEX_API_PASSPHRASE ?? "";

function sign(timestamp: string, method: string, path: string, body = ""): string {
  const prehash = timestamp + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", API_SECRET).update(prehash).digest("base64");
}

async function signedRequest(
  method: "GET" | "POST",
  path: string,
  bodyObj?: Record<string, unknown>,
): Promise<unknown> {
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
  const d = data as Record<string, unknown>;
  if (d["code"] && d["code"] !== "00000") {
    console.warn(`[WEEX] API error code=${d["code"]} msg=${d["msg"]} path=${path}`);
  }
  return data;
}

export async function getWeexBalance(coin: string): Promise<number> {
  try {
    const data = (await signedRequest("GET", "/api/v2/spot/account/assets")) as {
      data?: Array<{ coin: string; available: string }>;
    };
    const bal = data.data?.find((b) => b.coin === coin);
    return bal ? parseFloat(bal.available) : 0;
  } catch { return 0; }
}

export async function placeWeexMarketOrder(
  symbol: string,
  side: "buy" | "sell",
  usdtSize?: number,
  coinSize?: string,
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      symbol: symbol.replace("/", ""),
      side,
      orderType: "market",
      force: "gtc",
    };
    if (side === "buy" && usdtSize !== undefined) body.size = usdtSize.toFixed(2);
    else if (coinSize !== undefined) body.size = coinSize;

    const data = (await signedRequest("POST", "/api/v2/spot/trade/place-order", body)) as {
      data?: { orderId?: string }; msg?: string;
    };
    if (data.data?.orderId) return { success: true, orderId: data.data.orderId };
    return { success: false, error: data.msg ?? JSON.stringify(data) };
  } catch (err) { return { success: false, error: String(err) }; }
}
