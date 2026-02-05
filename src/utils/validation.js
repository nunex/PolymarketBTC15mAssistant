/**
 * Data validation utilities
 */

export function validateMarketData(market) {
  if (!market) {
    throw new Error('Market data is null or undefined');
  }

  const required = ['slug', 'question', 'endDate', 'clobTokenIds', 'outcomes'];
  const missing = required.filter(field => !market[field]);
  
  if (missing.length > 0) {
    throw new Error(`Invalid market data: missing ${missing.join(', ')}`);
  }
  
  return true;
}

export function validatePrice(price, fieldName = 'price') {
  if (price === null || price === undefined) {
    return null;
  }
  
  const num = Number(price);
  if (!Number.isFinite(num) || num < 0) {
    console.warn(`[Validation] Invalid ${fieldName}: ${price}`);
    return null;
  }
  
  return num;
}

export function validateOrderBook(orderbook) {
  if (!orderbook) return false;
  
  const hasValidBids = Array.isArray(orderbook.bids) && orderbook.bids.length > 0;
  const hasValidAsks = Array.isArray(orderbook.asks) && orderbook.asks.length > 0;
  
  return hasValidBids || hasValidAsks;
}

export function safeNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}
