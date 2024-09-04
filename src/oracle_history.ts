import { PoolOracle, PriceData } from '@blend-capital/blend-sdk';

export interface PriceChanges {
  up: string[];
  down: string[];
}

export class OracleHistory {
  /**
   * The minimum price change required to be considered significant, such that "0.05" indicates a 5% change.
   */
  priceDelta: number;
  /**
   * A map of asset IDs to the last stored price data.
   */
  priceHistory: Map<string, PriceData>;

  constructor(priceDelta: number) {
    this.priceDelta = priceDelta;
    this.priceHistory = new Map();
  }

  /**
   * Fetch any significant price changes over the last day, or since the last significant change, whichever is more recent.
   * @param current - The current pool oracle state
   * @returns An object containing the asset IDs of assets with significant price changes
   */
  public getSignificantPriceChanges(current: PoolOracle): PriceChanges {
    let up: string[] = [];
    let down: string[] = [];

    for (let [assetId, priceData] of current.prices) {
      let priceHistory = this.priceHistory.get(assetId);

      if (priceHistory === undefined) {
        this.priceHistory.set(assetId, priceData);
        continue;
      }

      let delta = Math.abs(
        Number(priceData.price - priceHistory.price) / Number(priceHistory.price)
      );
      if (delta >= this.priceDelta) {
        // price has changed significantly
        if (priceData.price > priceHistory.price) {
          up.push(assetId);
        } else {
          down.push(assetId);
        }
        // set the new price as the last viewed price
        this.priceHistory.set(assetId, priceData);
      }
      // TODO: Do we want this? Or would it be better to just wait for a significant change?
      else if (priceData.timestamp > priceHistory.timestamp + 24 * 60 * 60) {
        // update the last viewed price after a day has passed without a significant change
        this.priceHistory.set(assetId, priceData);
      }
    }

    return { up, down };
  }
}
