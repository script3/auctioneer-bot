import { Network, Pool, PoolConfig, PoolUser } from '@blend-capital/blend-sdk';
import { APP_CONFIG } from './config.js';

export class BlendHelper {
  network: Network;
  timestamp: number;
  private pool_cache: Pool | undefined;

  constructor() {
    this.network = {
      rpc: APP_CONFIG.rpcURL,
      passphrase: APP_CONFIG.networkPassphrase,
      opts: {
        allowHttp: true,
      },
    };
    this.timestamp = Math.floor(Date.now() / 1000);
    this.pool_cache = undefined;
  }

  async loadPool(): Promise<Pool> {
    if (this.pool_cache) {
      return this.pool_cache;
    } else {
      this.pool_cache = await Pool.load(this.network, APP_CONFIG.poolAddress, this.timestamp);
      return this.pool_cache;
    }
  }

  async loadPoolConfig(): Promise<PoolConfig> {
    if (this.pool_cache) {
      return this.pool_cache.config;
    } else {
      return await PoolConfig.load(this.network, APP_CONFIG.poolAddress);
    }
  }

  async loadUser(pool: Pool, address: string): Promise<PoolUser> {
    return await pool.loadUser(this.network, address);
  }
}
