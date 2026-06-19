
"use strict";
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── MEXC ────────────────────────────────────────────────────────────────────
const MEXC_BASE = "https://api.mexc.com";
const MEXC_KEY = process.env.MEXC_API_KEY || "";
const MEXC_SECRET = process.env.MEXC_API_SECRET || "";

function mexcSign(qs) {
  return crypto.createHmac("sha256", MEXC_SECRET).update(qs).digest("hex");
}
function buildQuery(params) {
  return Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
}
async function mexcRequest(method, path, params = {}) {
  const ts = Date.now();
  const qs = buildQuery({ ...params, timestamp: ts });
  const sig = mexcSign(qs);
  const url = (method === "GET")
    ? `${MEXC_BASE}${path}?${qs}&signature=${sig}`
    : `${MEXC_BASE}${path}`;
  const body = (method === "POST") ? `${qs}&signature=${sig}` : undefined;
  const res = await fetch(url, {
    method,
    headers: {
      "X-MEXC-APIKEY": MEXC_KEY,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
    signal: AbortSignal.timeout(8000),
  });
  return res.json();
}
async function getMexcBalance(asset) {
  try {
    const d = await mexcRequest("GET", "/api/v3/account");
    const b = d.balances?.find(x => x.asset === asset);
    return b ? parseFloat(b.free) : 0;
  } catch { return 0; }
}
async function placeMexcOrder(symbol, side, quoteQty, qty) {
  try {
    const p = { symbol: symbol.replace("/", ""), side, type: "MARKET" };
    if (side === "BUY" && quoteQty) p.quoteOrderQty = quoteQty.toFixed(2);
    else if (qty) p.quantity = qty;
    const d = await mexcRequest("POST", "/api/v3/order", p);
    if (d.orderId) return { success: true, orderId: String(d.orderId) };
    return { success: false, error: d.msg || "Unknown" };
  } catch (e) { return { success: false, error: String(e) }; }
}
async function getMexcAssetQty(symbol, usdtSpend, price) {
  try {
    const r = await fetch(`${MEXC_BASE}/api/v3/exchangeInfo?symbol=${symbol.replace("/","")}`, { signal: AbortSignal.timeout(5000) });
    const info = await r.json();
    const step = parseFloat(info.symbols?.[0]?.filters?.find(f => f.filterType === "LOT_SIZE")?.stepSize || "1");
    return Math.floor((usdtSpend / price) / step) * step;
  } catch { return usdtSpend / price; }
}

// ─── WEEX (Bitget) ───────────────────────────────────────────────────────────
const WEEX_BASE = "https://api.bitget.com";
const WEEX_KEY = process.env.WEEX_API_KEY || "";
const WEEX_SECRET = process.env.WEEX_API_SECRET || "";
const WEEX_PASS = process.env.WEEX_API_PASSPHRASE || "";

function weexSign(ts, method, path, body = "") {
  return crypto.createHmac("sha256", WEEX_SECRET).update(ts + method.toUpperCase() + path + body).digest("base64");
}
async function weexRequest(method, path, bodyObj) {
  const ts = Date.now().toString();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const sig = weexSign(ts, method, path, bodyStr);
  const res = await fetch(`${WEEX_BASE}${path}`, {
    method,
    headers: {
      "ACCESS-KEY": WEEX_KEY,
      "ACCESS-SIGN": sig,
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": WEEX_PASS,
      "Content-Type": "application/json",
      locale: "en-US",
    },
    body: bodyStr || undefined,
    signal: AbortSignal.timeout(8000),
  });
  return res.json();
}
async function getWeexBalance(coin) {
  try {
    const d = await weexRequest("GET", "/api/v2/spot/account/assets");
    const b = d.data?.find(x => x.coin === coin);
    return b ? parseFloat(b.available) : 0;
  } catch { return 0; }
}
async function placeWeexOrder(symbol, side, usdtSize, coinSize) {
  try {
    const body = { symbol: symbol.replace("/", ""), side, orderType: "market", force: "gtc" };
    if (side === "buy" && usdtSize) body.size = usdtSize.toFixed(2);
    else if (coinSize) body.size = coinSize;
    const d = await weexRequest("POST", "/api/v2/spot/trade/place-order", body);
    if (d.data?.orderId) return { success: true, orderId: d.data.orderId };
    return { success: false, error: d.msg || JSON.stringify(d) };
  } catch (e) { return { success: false, error: String(e) }; }
}

// ─── TRADER ──────────────────────────────────────────────────────────────────
const tradeHistory = [];
const activeTrades = new Set();
const lastTradeTime = {};
const COOLDOWN_MS = 30000;

async function executeTrade(symbol, buyEx, sellEx, buyPrice, sellPrice, spreadPct, budget) {
  const coin = symbol.replace("/USDT", "");
  const base = {
    id: `${symbol}-${Date.now()}`, timestamp: new Date().toISOString(),
    symbol, buyExchange: buyEx, sellExchange: sellEx,
    buyPrice, sellPrice, spreadPercent: spreadPct,
    usdtSpent: budget, estimatedProfit: (budget * spreadPct) / 100, status: "failed",
  };
  if (activeTrades.has(symbol)) { base.error = "Trade in progress"; tradeHistory.unshift(base); return base; }
  const now = Date.now();
  const last = lastTradeTime[symbol] || 0;
  if (now - last < COOLDOWN_MS) {
    base.error = `Cooldown ${Math.ceil((COOLDOWN_MS-(now-last))/1000)}s`;
    tradeHistory.unshift(base); return base;
  }
  activeTrades.add(symbol);
  try {
    let buy, sell;
    if (buyEx === "MEXC") {
      const mexcUsdt = await getMexcBalance("USDT");
      const weexCoin = await getWeexBalance(coin);
      if (mexcUsdt < budget * 0.95) { base.error = `Low MEXC USDT: $${mexcUsdt.toFixed(2)}`; tradeHistory.unshift(base); return base; }
      const coinQty = (budget / buyPrice).toFixed(6);
      if (weexCoin < parseFloat(coinQty) * 0.95) { base.error = `Low WEEX ${coin}`; tradeHistory.unshift(base); return base; }
      [buy, sell] = await Promise.all([placeMexcOrder(symbol, "BUY", budget), placeWeexOrder(symbol, "sell", undefined, coinQty)]);
    } else {
      const weexUsdt = await getWeexBalance("USDT");
      const mexcCoin = await getMexcBalance(coin);
      if (weexUsdt < budget * 0.95) { base.error = `Low WEEX USDT: $${weexUsdt.toFixed(2)}`; tradeHistory.unshift(base); return base; }
      const coinQty = await getMexcAssetQty(symbol, budget, sellPrice);
      if (mexcCoin < coinQty * 0.95) { base.error = `Low MEXC ${coin}`; tradeHistory.unshift(base); return base; }
      [buy, sell] = await Promise.all([placeWeexOrder(symbol, "buy", budget), placeMexcOrder(symbol, "SELL", undefined, coinQty)]);
    }
    base.buyOrderId = buy.orderId; base.sellOrderId = sell.orderId;
    if (buy.success && sell.success) { base.status = "success"; lastTradeTime[symbol] = Date.now(); }
    else if (buy.success || sell.success) { base.status = "partial"; base.error = `buy=${buy.success} sell=${sell.success}`; }
    else { base.status = "failed"; base.error = `Buy:${buy.error}|Sell:${sell.error}`; }
  } catch (e) { base.status = "failed"; base.error = String(e); }
  finally { activeTrades.delete(symbol); }
  tradeHistory.unshift(base);
  if (tradeHistory.length > 200) tradeHistory.splice(200);
  return base;
}

// ─── SCANNER ─────────────────────────────────────────────────────────────────
const SYMBOLS = ["PEPE","DOGE","SHIB","WIF","BONK","FLOKI","TURBO","MEW","MEME"];
const MIN_SPREAD = 0.15;
const BUDGET = 50;
const MIN_USDT = BUDGET * 0.95;

const session = {
  totalOpportunities:0, totalNetProfit:0, bestSpread:0, bestSymbol:"", scansCompleted:0,
  topPerformers: Object.fromEntries(SYMBOLS.map(s=>[s,{bestSpreadPercent:0,opportunityCount:0,estimatedTotalProfit:0}])),
};

async function fetchMexcPrice(sym) {
  try {
    const r = await fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${sym}USDT`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json(); return d.price ? parseFloat(d.price) : null;
  } catch { return null; }
}
async function fetchWeexPrice(sym) {
  try {
    const r = await fetch(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}USDT`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json(); if (!d.data?.length) return null;
    const p = d.data[0].lastPr || d.data[0].close; return p ? parseFloat(p) : null;
  } catch { return null; }
}
async function scanPrices() {
  const results = await Promise.all(SYMBOLS.map(async sym => {
    const [mexc, weex] = await Promise.all([fetchMexcPrice(sym), fetchWeexPrice(sym)]);
    return { sym, mexc, weex };
  }));
  session.scansCompleted++;
  const ts = new Date().toISOString();
  const prices = [], opportunities = [];
  for (const { sym, mexc, weex } of results) {
    if (!mexc || !weex) continue;
    const spread = Math.abs(mexc - weex);
    const spreadPct = (spread / Math.min(mexc, weex)) * 100;
    prices.push({ symbol:`${sym}/USDT`, mexcPrice:mexc, weexPrice:weex, spread, spreadPercent:spreadPct, timestamp:ts });
    if (spreadPct > MIN_SPREAD) {
      const buyEx = mexc < weex ? "MEXC" : "WEEX";
      const sellEx = mexc < weex ? "WEEX" : "MEXC";
      const profit = (BUDGET * spreadPct) / 100;
      opportunities.push({ symbol:`${sym}/USDT`, buyExchange:buyEx, sellExchange:sellEx, buyPrice:Math.min(mexc,weex), sellPrice:Math.max(mexc,weex), spreadPercent:spreadPct, estimatedProfit:profit, timestamp:ts });
      session.totalOpportunities++; session.totalNetProfit += profit;
      if (spreadPct > session.bestSpread) { session.bestSpread = spreadPct; session.bestSymbol = `${sym}/USDT`; }
      const tp = session.topPerformers[sym];
      if (tp) { if (spreadPct > tp.bestSpreadPercent) tp.bestSpreadPercent = spreadPct; tp.opportunityCount++; tp.estimatedTotalProfit += profit; }
    }
  }
  return { prices, opportunities };
}
let lastScan = null;
async function getCached() {
  const now = Date.now();
  if (!lastScan || now - lastScan.ts > 2500) {
    try { const { prices, opportunities } = await scanPrices(); lastScan = { prices, opportunities, ts: now }; } catch {}
  }
  return lastScan;
}

// ─── AUTO-BOT ────────────────────────────────────────────────────────────────
const bot = { enabled:false, tradesExecuted:0, lastTradeAt:null, timer:null };

async function botTick() {
  if (!bot.enabled) return;
  try {
    const [mexcUsdt, weexUsdt] = await Promise.all([getMexcBalance("USDT"), getWeexBalance("USDT")]);
    const canMexc = mexcUsdt >= MIN_USDT, canWeex = weexUsdt >= MIN_USDT;
    if (!canMexc && !canWeex) { console.log(`[BOT] Both low MEXC:$${mexcUsdt.toFixed(2)} WEEX:$${weexUsdt.toFixed(2)}`); }
    else {
      const scan = await getCached();
      for (const opp of (scan?.opportunities || [])) {
        if (!bot.enabled) break;
        if (opp.buyExchange === "MEXC" && !canMexc) continue;
        if (opp.buyExchange === "WEEX" && !canWeex) continue;
        console.log(`[BOT] ${opp.symbol} spread=${opp.spreadPercent.toFixed(3)}%`);
        const r = await executeTrade(opp.symbol, opp.buyExchange, opp.sellExchange, opp.buyPrice, opp.sellPrice, opp.spreadPercent, BUDGET);
        if (r.status === "success" || r.status === "partial") { bot.tradesExecuted++; bot.lastTradeAt = new Date().toISOString(); }
      }
    }
  } catch (e) { console.error("[BOT] Error:", e); }
  if (bot.enabled) bot.timer = setTimeout(botTick, 3000);
}
function startBot() { if (bot.timer) clearTimeout(bot.timer); bot.timer = setTimeout(botTick, 1000); console.log("[BOT] Started"); }
function stopBot() { if (bot.timer) { clearTimeout(bot.timer); bot.timer = null; } console.log("[BOT] Stopped"); }

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/api/arb/autobot", (_, res) => res.json({ enabled:bot.enabled, tradesExecuted:bot.tradesExecuted, lastTradeAt:bot.lastTradeAt }));
app.post("/api/arb/autobot", (req, res) => {
  bot.enabled = !!req.body.enabled;
  bot.enabled ? startBot() : stopBot();
  res.json({ enabled:bot.enabled, tradesExecuted:bot.tradesExecuted, lastTradeAt:bot.lastTradeAt });
});
app.get("/api/arb/prices", async (_, res) => { const s = await getCached(); res.json(s?.prices || []); });
app.get("/api/arb/opportunities", async (_, res) => { const s = await getCached(); res.json(s?.opportunities || []); });
app.get("/api/arb/stats", (_, res) => res.json({ ...session, budgetPerTrade:BUDGET, mexcFee:0, weexFee:0, bestSymbol: session.bestSymbol || "—" }));
app.get("/api/arb/top-performers", (_, res) => res.json(
  Object.entries(session.topPerformers).map(([sym,d]) => ({ symbol:`${sym}/USDT`,...d })).sort((a,b) => b.bestSpreadPercent - a.bestSpreadPercent)
));
app.post("/api/arb/trade", async (req, res) => {
  const { symbol, buyExchange, sellExchange, buyPrice, sellPrice, spreadPercent } = req.body;
  if (!symbol) { res.status(400).json({ error: "Missing fields" }); return; }
  res.json(await executeTrade(symbol, buyExchange, sellExchange, buyPrice, sellPrice, spreadPercent, BUDGET));
});
app.get("/api/arb/trades", (_, res) => res.json(tradeHistory));
app.get("/api/arb/balances", async (_, res) => {
  const [mu, wu] = await Promise.all([getMexcBalance("USDT"), getWeexBalance("USDT")]);
  const mc = {}, wc = {};
  await Promise.all(SYMBOLS.map(async sym => {
    const [m, w] = await Promise.all([getMexcBalance(sym), getWeexBalance(sym)]);
    if (m > 0) mc[sym] = m; if (w > 0) wc[sym] = w;
  }));
  res.json({ mexc:{ usdt:mu, coins:mc }, weex:{ usdt:wu, coins:wc } });
});

app.listen(PORT, () => console.log(`[ARB] Server running on port ${PORT}`));
