"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tradeHistory = void 0;
exports.executeTrade = executeTrade;
const mexc_1 = require("./mexc");
const weex_1 = require("./weex");
exports.tradeHistory = [];
const activeTrades = new Set();
const COOLDOWN_MS = 30_000;
const lastTradeTime = {};
async function executeTrade(symbol, buyExchange, sellExchange, buyPrice, sellPrice, spreadPercent, budget) {
    const coin = symbol.replace("/USDT", "");
    const base = {
        id: `${symbol}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        symbol, buyExchange, sellExchange, buyPrice, sellPrice, spreadPercent,
        usdtSpent: budget,
        estimatedProfit: (budget * spreadPercent) / 100,
        status: "failed",
    };
    if (activeTrades.has(symbol)) {
        base.error = "Trade already in progress for this symbol";
        exports.tradeHistory.unshift(base);
        return base;
    }
    const now = Date.now();
    const lastTrade = lastTradeTime[symbol] ?? 0;
    if (now - lastTrade < COOLDOWN_MS) {
        const wait = Math.ceil((COOLDOWN_MS - (now - lastTrade)) / 1000);
        base.error = `Cooldown active — wait ${wait}s`;
        exports.tradeHistory.unshift(base);
        return base;
    }
    activeTrades.add(symbol);
    try {
        let buyResult;
        let sellResult;
        if (buyExchange === "MEXC" && sellExchange === "WEEX") {
            const mexcUsdt = await (0, mexc_1.getMexcBalance)("USDT");
            const weexCoinBal = await (0, weex_1.getWeexBalance)(coin);
            if (mexcUsdt < budget * 0.95) {
                base.error = `Insufficient MEXC USDT: $${mexcUsdt.toFixed(2)}`;
                exports.tradeHistory.unshift(base);
                return base;
            }
            const coinQty = (budget / buyPrice).toFixed(6);
            if (weexCoinBal < parseFloat(coinQty) * 0.95) {
                base.error = `Insufficient WEEX ${coin}: ${weexCoinBal}`;
                exports.tradeHistory.unshift(base);
                return base;
            }
            [buyResult, sellResult] = await Promise.all([
                (0, mexc_1.placeMexcMarketOrder)(symbol, "BUY", budget),
                (0, weex_1.placeWeexMarketOrder)(symbol, "sell", undefined, coinQty),
            ]);
        }
        else {
            const weexUsdt = await (0, weex_1.getWeexBalance)("USDT");
            const mexcCoinBal = await (0, mexc_1.getMexcBalance)(coin);
            if (weexUsdt < budget * 0.95) {
                base.error = `Insufficient WEEX USDT: $${weexUsdt.toFixed(2)}`;
                exports.tradeHistory.unshift(base);
                return base;
            }
            const coinQty = await (0, mexc_1.getMexcAssetQty)(symbol, budget, sellPrice);
            if (mexcCoinBal < coinQty * 0.95) {
                base.error = `Insufficient MEXC ${coin}: ${mexcCoinBal}`;
                exports.tradeHistory.unshift(base);
                return base;
            }
            [buyResult, sellResult] = await Promise.all([
                (0, weex_1.placeWeexMarketOrder)(symbol, "buy", budget),
                (0, mexc_1.placeMexcMarketOrder)(symbol, "SELL", undefined, coinQty),
            ]);
        }
        base.buyOrderId = buyResult.orderId;
        base.sellOrderId = sellResult.orderId;
        if (buyResult.success && sellResult.success) {
            base.status = "success";
            lastTradeTime[symbol] = Date.now();
        }
        else if (buyResult.success || sellResult.success) {
            base.status = "partial";
            base.error = `Partial: buy=${buyResult.success} sell=${sellResult.success}`;
        }
        else {
            base.status = "failed";
            base.error = `Buy: ${buyResult.error} | Sell: ${sellResult.error}`;
        }
    }
    catch (err) {
        base.status = "failed";
        base.error = String(err);
    }
    finally {
        activeTrades.delete(symbol);
    }
    exports.tradeHistory.unshift(base);
    if (exports.tradeHistory.length > 200)
        exports.tradeHistory.splice(200);
    return base;
}
