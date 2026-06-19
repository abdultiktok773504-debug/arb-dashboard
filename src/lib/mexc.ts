import crypto from "crypto";

const BASE = "https://api.mexc.com";
const API_KEY = process.env.MEXC_API_KEY ?? "";
const API_SECRET = process.env.MEXC_API_SECRET ?? "";

function sign(queryString: string): string {
  return crypto.createHmac("sha256", API_SECRET).update(queryString).digest("hex");
}

function buildQuery(params: Record<string, string | number>): string {
  return Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
}

async function signedRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number> = {},
): Promise<unknown> {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const queryString = buildQuery(allParams);
  const signature = sign(queryString);
  const url =
    method === "GET" || method === "DELETE"
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

export async function getMexcBalance(asset: string): Promise<number> {
  try {
    const data = (await signedRequest("GET", "/api/v3/account")) as {
      balances?: Array<{ asset: string; free: string }>;
    };
    const bal = data.balances?.find((b) => b.asset === asset);
    return bal ? parseFloat(bal.free) : 0;
  } catch { return 0; }
}

export async function placeMexcMarketOrder(
  symbol: string,
  side: "BUY" | "SELL",
  quoteQty?: number,
  qty?: number,
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    const params: Record<string, string | number> = {
      symbol: symbol.replace("/", ""),
      side,
      type: "MARKET",
    };
    if (side === "BUY" && quoteQty !== undefined) params.quoteOrderQty = quoteQty.toFixed(2);
    else if (qty !== undefined) params.quantity = qty;

    const data = (await signedRequest("POST", "/api/v3/order", params)) as {
      orderId?: number; msg?: string;
    };
    if (data.orderId) return { success: true, orderId: String(data.orderId) };
    return { success: false, error: data.msg ?? "Unknown error" };
  } catch (err) { return { success: false, error: String(err) }; }
}

export async function getMexcAssetQty(symbol: string, usdtSpend: number, price: number): Promise<number> {
  try {
    const infoRes = await fetch(
      `${BASE}/api/v3/exchangeInfo?symbol=${symbol.replace("/", "")}`,
      { signal: AbortSignal.timeout(5000) },
    );
    const info = (await infoRes.json()) as {
      symbols?: Array<{ filters?: Array<{ filterType: string; stepSize?: string }> }>;
    };
    const stepSize = info.symbols?.[0]?.filters?.find((f) => f.filterType === "LOT_SIZE")?.stepSize ?? "1";
    const step = parseFloat(stepSize);
    return Math.floor((usdtSpend / price) / step) * step;
  } catch { return usdtSpend / price; }
}
