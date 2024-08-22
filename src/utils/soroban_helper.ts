import {
  AuctionData,
  BackstopToken,
  ContractError,
  Network,
  parseError,
  Pool,
  PoolContract,
  PoolUser,
} from '@blend-capital/blend-sdk';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  scValToNative,
  SorobanRpc,
  TransactionBuilder,
  xdr,
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

  async loadUser(address: string): Promise<PoolUser> {
    const pool = await this.loadPool();
    return await pool.loadUser(this.network, address);
  }

  async loadAuction(userId: string, auctionType: number): Promise<AuctionData | undefined> {
    try {
      let rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);
      const res: xdr.ScVal[] = [
        xdr.ScVal.scvSymbol('Auction'),
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('auct_type'),
            val: xdr.ScVal.scvU32(auctionType),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('user'),
            val: Address.fromString(userId).toScVal(),
          }),
        ]),
      ];
      const ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: Address.fromString(APP_CONFIG.poolAddress).toScAddress(),
          key: xdr.ScVal.scvVec(res),
          durability: xdr.ContractDataDurability.temporary(),
        })
      );
      let ledgerData = await rpc.getLedgerEntries(ledgerKey);
      if (ledgerData.entries.length === 0) {
        return undefined;
      }
      let auction = PoolContract.spec.funcResToNative(
        'get_auction',
        ledgerData.entries[0].val.contractData().val()
      );
      return auction as AuctionData;
    } catch (e) {
      logger.error(`Error loading auction: ${e}`);
      throw e;
    }
  }

  async loadBackstopToken(): Promise<BackstopToken> {
    return await BackstopToken.load(
      this.network,
      APP_CONFIG.backstopTokenAddress,
      APP_CONFIG.blndAddress,
      APP_CONFIG.usdcAddress
    );
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
      let tx = new TransactionBuilder(account, {
        networkPassphrase: this.network.passphrase,
        fee: BASE_FEE,
        timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 5 * 60 * 1000 },
      })
        .addOperation(op)
        .build();
      let rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);

      let result = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return scValToNative(result.result.retval) as number;
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
      let tx = new TransactionBuilder(account, {
        networkPassphrase: this.network.passphrase,
        fee: BASE_FEE,
        timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 5 * 60 * 1000 },
      })
        .addOperation(op)
        .build();
      let rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);

      let result = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return Number(scValToNative(result.result.retval));
      } else {
        return 0;
      }
    } catch (e) {
      logger.error(`Error fetching balance: ${e}`);
      return 0;
    }
  }

  async submitTransaction<T>(
    operation: string,
    keypair: Keypair,
    parser: (xdr_string: string) => T
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse & { txHash: string }> {
    const rpc = new SorobanRpc.Server(this.network.rpc, this.network.opts);
    const curr_time = Date.now();
    const account = await rpc.getAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      networkPassphrase: this.network.passphrase,
      fee: BASE_FEE,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 5 * 60 * 1000 },
    })
      .addOperation(xdr.Operation.fromXDR(operation, 'base64'))
      .build();

    const simResult = await rpc.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationSuccess(simResult)) {
      let assembledTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      assembledTx.sign(keypair);
      let txResponse = await rpc.sendTransaction(assembledTx);
      while (txResponse.status === 'TRY_AGAIN_LATER' && Date.now() - curr_time < 20000) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        txResponse = await rpc.sendTransaction(assembledTx);
      }
      if (txResponse.status !== 'PENDING') {
        const error = parseError(txResponse);
        logger.error('Transaction failed to send: ' + txResponse.hash + ' ' + error);
        throw error;
      }

      let get_tx_response = await rpc.getTransaction(txResponse.hash);
      while (get_tx_response.status === 'NOT_FOUND') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        get_tx_response = await rpc.getTransaction(txResponse.hash);
      }

      if (get_tx_response.status !== 'SUCCESS') {
        const error = parseError(get_tx_response);
        logger.error('Tx Failed: ', error);
        console.log(get_tx_response);

        throw error;
      }
      logger.info('Transaction successfully submitted: ' + get_tx_response);
      return { ...get_tx_response, txHash: txResponse.hash };
    }
    const error = parseError(simResult);
    throw error;
  }
}
