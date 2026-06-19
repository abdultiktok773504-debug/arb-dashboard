import { placeMexcMarketOrder, getMexcBalance, getMexcAssetQty } from "./mexc";
import { placeWeexMarketOrder, getWeexBalance } from "./weex";

export interface TradeResult {
  id: string;
  timestamp: string;
  symbol: string;
  buyExchange: string;
  sellExchange: string;
  buyPrice: number;
  sellPrice: number;
  spreadPercent: number;
  usdtSpent: number;
  estimatedProfit: number;
  status: "success" | "partial" | "failed";
  buyOrderId?: string;
  sellOrderId?: string;
  error?: string;
}

export const tradeHistory: TradeResult[] = [];
const activeTrades = new Set<string>();
const COOLDOWN_MS = 30_000;
const lastTradeTime: Record<string, number> = {};

export async function executeTrade(
  symbol: string,
  buyExchange: string,
  sellExchange: string,
  buyPrice: number,
  sellPrice: number,
  spreadPercent: number,
  budget: number,
): Promise<TradeResult> {
  const coin = symbol.replace("/USDT", "");
  const base: TradeResult = {
    id: `${symbol}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    symbol, buyExchange, sellExchange, buyPrice, sellPrice, spreadPercent,
    usdtSpent: budget,
    estimatedProfit: (budget * spreadPercent) / 100,
    status: "failed",
  };

  if (activeTrades.has(symbol)) {
    base.error = "Trade already in progress for this symbol";
    tradeHistory.unshift(base);
    return base;
  }

  const now = Date.now();
  const lastTrade = lastTradeTime[symbol] ?? 0;
  if (now - lastTrade < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastTrade)) / 1000);
    base.error = `Cooldown active — wait ${wait}s`;
    tradeHistory.unshift(base);
    return base;
  }

  activeTrades.add(symbol);

  try {
    let buyResult: { success: boolean; orderId?: string; error?: string };
    let sellResult: { success: boolean; orderId?: string; error?: string };

    if (buyExchange === "MEXC" && sellExchange === "WEEX") {
      const mexcUsdt = await getMexcBalance("USDT");
      const weexCoinBal = await getWeexBalance(coin);
      if (mexcUsdt < budget * 0.95) {
        base.error = `Insufficient MEXC USDT: $${mexcUsdt.toFixed(2)}`;
        tradeHistory.unshift(base); return base;
      }
      const coinQty = (budget / buyPrice).toFixed(6);
      if (weexCoinBal < parseFloat(coinQty) * 0.95) {
        base.error = `Insufficient WEEX ${coin}: ${weexCoinBal}`;
        tradeHistory.unshift(base); return base;
      }
      [buyResult, sellResult] = await Promise.all([
        placeMexcMarketOrder(symbol, "BUY", budget),
        placeWeexMarketOrder(symbol, "sell", undefined, coinQty),
      ]);
    } else {
      const weexUsdt = await getWeexBalance("USDT");
      const mexcCoinBal = await getMexcBalance(coin);
      if (weexUsdt < budget * 0.95) {
        base.error = `Insufficient WEEX USDT: $${weexUsdt.toFixed(2)}`;
        tradeHistory.unshift(base); return base;
      }
      const coinQty = await getMexcAssetQty(symbol, budget, sellPrice);
      if (mexcCoinBal < coinQty * 0.95) {
        base.error = `Insufficient MEXC ${coin}: ${mexcCoinBal}`;
        tradeHistory.unshift(base); return base;
      }
      [buyResult, sellResult] = await Promise.all([
        placeWeexMarketOrder(symbol, "buy", budget),
        placeMexcMarketOrder(symbol, "SELL", undefined, coinQty),
      ]);
    }

    base.buyOrderId = buyResult.orderId;
    base.sellOrderId = sellResult.orderId;

    if (buyResult.success && sellResult.success) {
      base.status = "success";
      lastTradeTime[symbol] = Date.now();
    } else if (buyResult.success || sellResult.success) {
      base.status = "partial";
      base.error = `Partial: buy=${buyResult.success} sell=${sellResult.success}`;
    } else {
      base.status = "failed";
      base.error = `Buy: ${buyResult.error} | Sell: ${sellResult.error}`;
    }
  } catch (err) {
    base.status = "failed";
    base.error = String(err);
  } finally {
    activeTrades.delete(symbol);
  }

  tradeHistory.unshift(base);
  if (tradeHistory.length > 200) tradeHistory.splice(200);
  return base;
}
