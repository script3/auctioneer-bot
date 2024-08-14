import { AuctionData, Network, Pool, PoolContract, PoolUser } from '@blend-capital/blend-sdk';
import {
  Account,
  Contract,
  Keypair,
  nativeToScVal,
  scValToNative,
  SorobanRpc,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { APP_CONFIG } from './config.js';
import { logger } from './logger.js';

export class SorobanHelper {
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

  async loadUser(pool: Pool, address: string): Promise<PoolUser> {
    return await pool.loadUser(this.network, address);
  }

  async loadAuction(userId: string, auctionType: number): Promise<AuctionData | undefined> {
    try {
      let poolClient = new PoolContract(APP_CONFIG.poolAddress);
      let op = poolClient.call(
        'get_auction',
        ...[nativeToScVal(auctionType), nativeToScVal(userId, { type: 'address' })]
      );
      let account = new Account(userId, '123');
      let tx = new TransactionBuilder(account).addOperation(op).build();
      let rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);

      let result = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return scValToNative(result.result.retval) as AuctionData;
      }
      return undefined;
    } catch (e) {
      logger.error(`Error fetching liquidation: ${e}`);
      return undefined;
    }
  }

  async simLPTokenToUSDC(amount: number): Promise<number | undefined> {
    try {
      let comet = new Contract(APP_CONFIG.backstopTokenAddress);
      let op = comet.call(
        'wdr_tokn_amt_in_get_lp_tokns_out',
        ...[
          nativeToScVal(APP_CONFIG.usdcAddress, { type: 'address' }),
          nativeToScVal(amount, { type: 'i128' }),
          nativeToScVal(0, { type: 'i128' }),
          nativeToScVal(APP_CONFIG.blndAddress, { type: 'address' }),
        ]
      );
      let account = new Account(Keypair.random().publicKey(), '123');
      let tx = new TransactionBuilder(account).addOperation(op).build();
      let rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);

      let result = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return (scValToNative(result.result.retval) as number) / 1e7;
      }
      return undefined;
    } catch (e) {
      logger.error(`Error calculating comet token value: ${e}`);
      return undefined;
    }
  }

  async simBalance(tokenId: string, userId: string): Promise<number> {
    try {
      let contract = new Contract(tokenId);
      let op = contract.call('balance', ...[nativeToScVal(userId, { type: 'address' })]);
      let account = new Account(Keypair.random().publicKey(), '123');
      let tx = new TransactionBuilder(account).addOperation(op).build();
      let rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);

      let result = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return (scValToNative(result.result.retval) as number) / 1e7;
      } else {
        return 0;
      }
    } catch (e) {
      logger.error(`Error fetching balance: ${e}`);
      return 0;
    }
  }
}
