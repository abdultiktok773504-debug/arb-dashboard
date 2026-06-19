"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const trader_1 = require("../lib/trader");
const mexc_1 = require("../lib/mexc");
const weex_1 = require("../lib/weex");
const router = (0, express_1.Router)();
const SYMBOLS = ["PEPE", "DOGE", "SHIB", "WIF", "BONK", "FLOKI", "TURBO", "MEW", "MEME"];
const MIN_SPREAD_PERCENT = 0.15;
const BUDGET_PER_TRADE = 50;
const MIN_USDT_TO_TRADE = BUDGET_PER_TRADE * 0.95;
const session = {
    totalOpportunities: 0,
    totalNetProfit: 0,
    bestSpread: 0,
    bestSymbol: "",
    scansCompleted: 0,
    topPerformers: Object.fromEntries(SYMBOLS.map((s) => [s, { bestSpreadPercent: 0, opportunityCount: 0, estimatedTotalProfit: 0 }])),
};
async function fetchMexcPrice(symbol) {
    try {
        const res = await fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}USDT`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok)
            return null;
        const data = await res.json();
        return data.price ? parseFloat(data.price) : null;
    }
    catch {
        return null;
    }
}
async function fetchWeexPrice(symbol) {
    try {
        const res = await fetch(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${symbol}USDT`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok)
            return null;
        const data = await res.json();
        if (!data.data?.length)
            return null;
        const price = data.data[0].lastPr ?? data.data[0].close;
        return price ? parseFloat(price) : null;
    }
    catch {
        return null;
    }
}
async function scanPrices() {
    const results = await Promise.all(SYMBOLS.map(async (sym) => {
        const [mexc, weex] = await Promise.all([fetchMexcPrice(sym), fetchWeexPrice(sym)]);
        return { sym, mexc, weex };
    }));
    session.scansCompleted += 1;
    const timestamp = new Date().toISOString();
    const prices = [];
    const opportunities = [];
    for (const { sym, mexc, weex } of results) {
        if (!mexc || !weex)
            continue;
        const spread = Math.abs(mexc - weex);
        const spreadPercent = (spread / Math.min(mexc, weex)) * 100;
        prices.push({ symbol: `${sym}/USDT`, mexcPrice: mexc, weexPrice: weex, spread, spreadPercent, timestamp });
        if (spreadPercent > MIN_SPREAD_PERCENT) {
            const buyExchange = mexc < weex ? "MEXC" : "WEEX";
            const sellExchange = mexc < weex ? "WEEX" : "MEXC";
            const estimatedProfit = (BUDGET_PER_TRADE * spreadPercent) / 100;
            opportunities.push({
                symbol: `${sym}/USDT`, buyExchange, sellExchange,
                buyPrice: Math.min(mexc, weex), sellPrice: Math.max(mexc, weex),
                spreadPercent, estimatedProfit, timestamp,
            });
            session.totalOpportunities += 1;
            session.totalNetProfit += estimatedProfit;
            if (spreadPercent > session.bestSpread) {
                session.bestSpread = spreadPercent;
                session.bestSymbol = `${sym}/USDT`;
            }
            const tp = session.topPerformers[sym];
            if (tp) {
                if (spreadPercent > tp.bestSpreadPercent)
                    tp.bestSpreadPercent = spreadPercent;
                tp.opportunityCount += 1;
                tp.estimatedTotalProfit += estimatedProfit;
            }
        }
    }
    return { prices, opportunities };
}
let lastScan = null;
async function getCachedScan() {
    const now = Date.now();
    if (!lastScan || now - lastScan.ts > 2500) {
        const { prices, opportunities } = await scanPrices();
        lastScan = { prices, opportunities, ts: now };
    }
    return lastScan;
}
// ── Auto-bot ──────────────────────────────────────────────────────────────────
const autobot = { enabled: false, tradesExecuted: 0, lastTradeAt: null, timer: null };
async function autobotTick() {
    if (!autobot.enabled)
        return;
    try {
        const [mexcUsdt, weexUsdt] = await Promise.all([(0, mexc_1.getMexcBalance)("USDT"), (0, weex_1.getWeexBalance)("USDT")]);
        const canBuyMexc = mexcUsdt >= MIN_USDT_TO_TRADE;
        const canBuyWeex = weexUsdt >= MIN_USDT_TO_TRADE;
        if (!canBuyMexc && !canBuyWeex) {
            console.warn(`[BOT] Both exchanges low — MEXC:$${mexcUsdt.toFixed(2)} WEEX:$${weexUsdt.toFixed(2)}`);
            if (autobot.enabled)
                autobot.timer = setTimeout(() => { void autobotTick(); }, 10000);
            return;
        }
        const scan = await getCachedScan();
        const opps = scan.opportunities;
        for (const opp of opps) {
            if (!autobot.enabled)
                break;
            if (opp.buyExchange === "MEXC" && !canBuyMexc)
                continue;
            if (opp.buyExchange === "WEEX" && !canBuyWeex)
                continue;
            console.log(`[BOT] Trading ${opp.symbol} spread=${opp.spreadPercent.toFixed(3)}%`);
            const result = await (0, trader_1.executeTrade)(opp.symbol, opp.buyExchange, opp.sellExchange, opp.buyPrice, opp.sellPrice, opp.spreadPercent, BUDGET_PER_TRADE);
            if (result.status === "success" || result.status === "partial") {
                autobot.tradesExecuted += 1;
                autobot.lastTradeAt = new Date().toISOString();
            }
        }
    }
    catch (err) {
        console.error("[BOT] Tick failed:", err);
    }
    if (autobot.enabled)
        autobot.timer = setTimeout(() => { void autobotTick(); }, 3000);
}
function startAutobot() {
    if (autobot.timer)
        clearTimeout(autobot.timer);
    autobot.timer = setTimeout(() => { void autobotTick(); }, 1000);
    console.log("[BOT] Started");
}
function stopAutobot() {
    if (autobot.timer) {
        clearTimeout(autobot.timer);
        autobot.timer = null;
    }
    console.log("[BOT] Stopped");
}
// ── Routes ────────────────────────────────────────────────────────────────────
router.get("/arb/autobot", (_req, res) => {
    res.json({ enabled: autobot.enabled, tradesExecuted: autobot.tradesExecuted, lastTradeAt: autobot.lastTradeAt });
});
router.post("/arb/autobot", (req, res) => {
    const { enabled } = req.body;
    autobot.enabled = !!enabled;
    autobot.enabled ? startAutobot() : stopAutobot();
    res.json({ enabled: autobot.enabled, tradesExecuted: autobot.tradesExecuted, lastTradeAt: autobot.lastTradeAt });
});
router.get("/arb/prices", async (_req, res) => {
    const scan = await getCachedScan();
    res.json(scan.prices);
});
router.get("/arb/opportunities", async (_req, res) => {
    const scan = await getCachedScan();
    res.json(scan.opportunities);
});
router.get("/arb/stats", (_req, res) => {
    res.json({
        totalOpportunities: session.totalOpportunities,
        totalNetProfit: session.totalNetProfit,
        bestSpread: session.bestSpread,
        bestSymbol: session.bestSymbol || "—",
        scansCompleted: session.scansCompleted,
        budgetPerTrade: BUDGET_PER_TRADE,
        mexcFee: 0,
        weexFee: 0,
    });
});
router.get("/arb/top-performers", (_req, res) => {
    const top = Object.entries(session.topPerformers)
        .map(([symbol, data]) => ({ symbol: `${symbol}/USDT`, ...data }))
        .sort((a, b) => b.bestSpreadPercent - a.bestSpreadPercent);
    res.json(top);
});
router.post("/arb/trade", async (req, res) => {
    const { symbol, buyExchange, sellExchange, buyPrice, sellPrice, spreadPercent } = req.body;
    if (!symbol || !buyExchange || !sellExchange) {
        res.status(400).json({ error: "Missing required fields" });
        return;
    }
    const result = await (0, trader_1.executeTrade)(symbol, buyExchange, sellExchange, buyPrice, sellPrice, spreadPercent, BUDGET_PER_TRADE);
    res.json(result);
});
router.get("/arb/trades", (_req, res) => {
    res.json(trader_1.tradeHistory);
});
router.get("/arb/balances", async (_req, res) => {
    const [mexcUsdt, weexUsdt] = await Promise.all([(0, mexc_1.getMexcBalance)("USDT"), (0, weex_1.getWeexBalance)("USDT")]);
    const mexcCoins = {};
    const weexCoins = {};
    await Promise.all(SYMBOLS.map(async (sym) => {
        const [m, w] = await Promise.all([(0, mexc_1.getMexcBalance)(sym), (0, weex_1.getWeexBalance)(sym)]);
        if (m > 0)
            mexcCoins[sym] = m;
        if (w > 0)
            weexCoins[sym] = w;
    }));
    res.json({ mexc: { usdt: mexcUsdt, coins: mexcCoins }, weex: { usdt: weexUsdt, coins: weexCoins } });
});
exports.default = router;
