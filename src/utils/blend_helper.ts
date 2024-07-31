import { Network, Pool } from "@blend-capital/blend-sdk";

export class BlendHelper {
  private network: Network;
  timestamp: number;

  constructor(network: Network) {
    this.network = network;
    this.timestamp = Math.floor(Date.now() / 1000);
  }

  async loadPool(poolId: string): Promise<Pool> {
    return await Pool.load(this.network, poolId, this.timestamp);
  }
}
