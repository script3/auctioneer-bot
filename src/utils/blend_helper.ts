import { Network, Pool, PoolUser } from '@blend-capital/blend-sdk';

export class BlendHelper {
  network: Network;
  poolId: string;
  backstopId: string;
  timestamp: number;

  constructor(network: Network, poolId: string, backstopId: string) {
    this.network = network;
    this.poolId = poolId;
    this.backstopId = backstopId;
    this.timestamp = Math.floor(Date.now() / 1000);
  }

  async loadPool(): Promise<Pool> {
    return await Pool.load(this.network, this.poolId, this.timestamp);
  }

  async loadUser(pool: Pool, address: string): Promise<PoolUser> {
    return await pool.loadUser(this.network, address);
  }
}
