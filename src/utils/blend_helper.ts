import { Network, Pool, PoolUser } from '@blend-capital/blend-sdk';

export class BlendHelper {
  network: Network;
  poolId: string;
  backstopId: string;
  timestamp: number;
  private pool_cache: Pool | undefined;

  constructor(network: Network, poolId: string, backstopId: string) {
    this.network = network;
    this.poolId = poolId;
    this.backstopId = backstopId;
    this.timestamp = Math.floor(Date.now() / 1000);
    this.pool_cache = undefined;
  }

  async loadPool(): Promise<Pool> {
    if (this.pool_cache) {
      return this.pool_cache;
    } else {
      this.pool_cache = await Pool.load(this.network, this.poolId, this.timestamp);
      return this.pool_cache;
    }
  }

  async loadUser(pool: Pool, address: string): Promise<PoolUser> {
    return await pool.loadUser(this.network, address);
  }
}
