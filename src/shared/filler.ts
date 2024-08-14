import { AuctionData, PoolConfig } from '@blend-capital/blend-sdk';
import { Filler } from '../utils/config.js';

/**
 * Check if the filler cares about the auction.
 * @param filler
 * @param auctionData
 * @param poolConfig
 * @returns A boolean indicating if the filler cares about the auction.
 */
export function shouldFillerCare(
  filler: Filler,
  auctionData: AuctionData,
  poolConfig: PoolConfig
): boolean {
  // validate lot
  for (let [assetIndex, _] of auctionData.lot) {
    const assetAddress = poolConfig.reserveList[assetIndex];
    if (!filler.supportedLot.some((address) => assetAddress === address)) {
      return false;
    }
  }
  // validate bid
  for (let [assetIndex, _] of auctionData.bid) {
    const assetAddress = poolConfig.reserveList[assetIndex];
    if (!filler.supportedBid.some((address) => assetAddress === address)) {
      return false;
    }
  }
  return true;
}
