import { APP_CONFIG } from './config.js';
import { AuctioneerDatabase, PriceEntry } from './db.js';
import { stringify } from './json.js';
import { logger } from './logger.js';

interface ExchangePrice {
  symbol: string;
  price: number;
}

/**
 * Set exchange prices in the database.
 * @param db - The database to set prices in
 */
export async function setPrices(db: AuctioneerDatabase): Promise<void> {
  const coinbaseSymbols: string[] = [];
  const binanceSymbols: string[] = [];
  for (const source of APP_CONFIG.priceSources) {
    if (source.type === 'coinbase') {
      coinbaseSymbols.push(source.symbol);
    } else if (source.type === 'binance') {
      binanceSymbols.push(source.symbol);
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const [coinbasePricesResult, binancePricesResult] = await Promise.all([
    coinbasePrices(coinbaseSymbols),
    binancePrices(binanceSymbols),
  ]);
  const exchangePriceResult = coinbasePricesResult.concat(binancePricesResult);

  const priceEntries: PriceEntry[] = [];
  for (const price of exchangePriceResult) {
    const assetId = APP_CONFIG.priceSources.find(
      (source) => source.symbol === price.symbol
    )?.assetId;
    if (assetId) {
      priceEntries.push({
        asset_id: assetId,
        price: price.price,
        timestamp: timestamp,
      });
    }
  }
  db.setPriceEntries(priceEntries);
}

/**
 * Fetch spot prices for a set of symbols from Coinbase. If an error occurs, an empty array is returned.
 * @param symbols - The tickers to fetch prices for (productId for Coinbase)
 * @returns An array of prices for the tickers
 */
async function coinbasePrices(symbols: string[]): Promise<ExchangePrice[]> {
  try {
    if (symbols.length === 0) {
      return [];
    }

    let resp = await fetch(
      `https://api.coinbase.com/api/v3/brokerage/market/products?${symbols.map((symbol) => `product_ids=${symbol}`).join('&')}`
    );

    if (resp.ok) {
      const data = (await resp.json()) as any;
      if (!Array.isArray(data.products)) {
        logger.error(`Unexpected response from coinbase: ${stringify(data)}`);
        return [];
      }

      const prices: ExchangePrice[] = [];
      for (const product of data.products) {
        const price = product.price;
        if (price) {
          const as_number = Number(price);
          if (Number.isFinite(as_number)) {
            prices.push({
              symbol: product.product_id,
              price: as_number,
            });
          }
        }
      }
      return prices;
    } else {
      logger.error(`Http error fetching Coinbase price: ${resp.status} ${resp.statusText}`);
      return [];
    }
  } catch (error: any) {
    logger.error(`Error fetching Coinbase prices: ${error}`);
    return [];
  }
}

/**
 * Fetch spot prices for a set of symbols from Binance. If an error occurs, an empty array is returned.
 * @param symbols - The tickers to fetch prices for
 * @returns An array of prices for the tickers
 */
async function binancePrices(symbols: string[]): Promise<ExchangePrice[]> {
  try {
    if (symbols.length === 0) {
      return [];
    }

    let resp = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbols=[${symbols.map((symbol) => `"${symbol}"`).join(',')}]`
    );
    if (resp.ok) {
      const data = (await resp.json()) as any[];
      if (!Array.isArray(data)) {
        logger.error(`Unexpected response from Binance: ${stringify(data)}`);
        return [];
      }
      const prices: ExchangePrice[] = [];
      for (const price of data) {
        const as_number = Number(price.price);
        if (Number.isFinite(as_number)) {
          prices.push({
            symbol: price.symbol,
            price: as_number,
          });
        }
      }
      return prices;
    } else {
      logger.error(`Http error fetching Binance price: ${resp.status} ${resp.statusText}`);
      return [];
    }
  } catch (error: any) {
    logger.error(`Error fetching Binance prices: ${error}`);
    return [];
  }
}
