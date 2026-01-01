import {
  Auction,
  AuctionData,
  BackstopToken,
  ContractErrorType,
  Network,
  parseError,
  Pool,
  PoolContract,
  PoolOracle,
  PoolUser,
  PoolV2,
  PositionsEstimate,
} from '@blend-capital/blend-sdk';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { APP_CONFIG } from './config.js';
import { logger } from './logger.js';

export interface PoolUserEst {
  estimate: PositionsEstimate;
  user: PoolUser;
}

export interface ErrorTimeout {
  timeout: number;
  error: any;
}

export class SorobanHelper {
  network: Network;
  feeLevel: 'high' | 'medium';
  private pool_cache: Map<string, Pool>;
  // cache for pool users keyed by 'poolId + userId'
  private user_cache: Map<string, PoolUser>;
  private oracle_cache: Map<string, PoolOracle>;

  constructor(feeLevel: 'high' | 'medium' = 'medium') {
    this.network = {
      rpc: APP_CONFIG.rpcURL,
      passphrase: APP_CONFIG.networkPassphrase,
      opts: {
        allowHttp: true,
      },
    };
    this.feeLevel = feeLevel;
    this.pool_cache = new Map();
    this.user_cache = new Map();
    this.oracle_cache = new Map();
  }

  setFeeLevel(feeLevel: 'high' | 'medium') {
    this.feeLevel = feeLevel;
  }

  async loadLatestLedger(): Promise<number> {
    try {
      let stellarRpc = new rpc.Server(this.network.rpc, this.network.opts);
      let ledger = await stellarRpc.getLatestLedger();
      return ledger.sequence;
    } catch (e) {
      logger.error(`Error loading latest ledger: ${e}`);
      throw e;
    }
  }

  async loadPool(poolId: string): Promise<Pool> {
    let cachedPool = this.pool_cache.get(poolId);
    try {
      if (cachedPool) {
        return cachedPool;
      }
      let pool: Pool = await PoolV2.load(this.network, poolId);
      this.pool_cache.set(poolId, pool);
      return pool;
    } catch (e: any) {
      logger.error(`Error loading ${poolId} pool:  ${e}`);
      throw e;
    }
  }

  async loadUser(poolId: string, userId: string): Promise<PoolUser> {
    let cachedUser = this.user_cache.get(poolId + userId);
    try {
      if (cachedUser) {
        return cachedUser;
      }
      const pool = await this.loadPool(poolId);
      const user = await pool.loadUser(userId);

      this.user_cache.set(poolId + userId, user);
      return user;
    } catch (e: any) {
      logger.error(`Error loading user: ${userId} in pool: ${poolId} Error: ${e}`);
      throw e;
    }
  }

  async loadPoolOracle(poolId: string): Promise<PoolOracle> {
    let cachedOracle = this.oracle_cache.get(poolId);
    try {
      if (cachedOracle) {
        return cachedOracle;
      }
      const pool = await this.loadPool(poolId);
      const oracle = await pool.loadOracle();
      this.oracle_cache.set(poolId, oracle);
      return oracle;
    } catch (e: any) {
      logger.error(`Error loading pool oracle for pool: ${poolId} Error: ${e}`);
      throw e;
    }
  }

  async loadUserPositionEstimate(poolId: string, userId: string): Promise<PoolUserEst> {
    try {
      const pool = await this.loadPool(poolId);
      const user = await this.loadUser(poolId, userId);
      const poolOracle = await this.loadPoolOracle(poolId);
      return { estimate: PositionsEstimate.build(pool, poolOracle, user.positions), user };
    } catch (e) {
      logger.error(
        `Error loading user position estimate for user: ${userId} in pool: ${poolId} Error: ${e}`
      );
      throw e;
    }
  }

  async loadAuction(
    poolId: string,
    userId: string,
    auctionType: number
  ): Promise<Auction | undefined> {
    try {
      const stellarRpc = new rpc.Server(this.network.rpc, this.network.opts);
      const ledgerKey = AuctionData.ledgerKey(poolId, {
        auct_type: auctionType,
        user: userId,
      });
      const ledgerData = await stellarRpc.getLedgerEntries(ledgerKey);
      if (ledgerData.entries.length === 0) {
        return undefined;
      }
      let auctionData = PoolContract.parsers.getAuction(
        ledgerData.entries[0].val.contractData().val().toXDR('base64')
      );
      return new Auction(userId, auctionType, auctionData);
    } catch (e) {
      logger.error(`Error loading auction for user: ${userId} in pool: ${poolId} Error: ${e}`);
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

  /**
   * @dev WARNING: If loading balances for the filler, use `getFillerAvailableBalances` instead.
   */
  async loadBalances(userId: string, tokens: string[]): Promise<Map<string, bigint>> {
    try {
      let balances = new Map<string, bigint>();

      // break tokens array into chunks of at most 5 tokens
      let concurrency_limit = 5;
      let promise_chunks: string[][] = [];
      for (let i = 0; i < tokens.length; i += concurrency_limit) {
        promise_chunks.push(tokens.slice(i, i + concurrency_limit));
      }

      // fetch each chunk of token balances concurrently
      for (const chunk of promise_chunks) {
        const chunkResults = await Promise.all(
          chunk.map((token) => this.simBalance(token, userId))
        );
        chunk.forEach((token, index) => {
          balances.set(token, chunkResults[index]);
        });
      }
      return balances;
    } catch (e) {
      logger.error(`Error loading balances: ${e}`);
      throw e;
    }
  }

  async loadAllowance(
    tokenId: string,
    from: string,
    spender: string
  ): Promise<{ expiration_ledger: number; amount: bigint }> {
    try {
      const stellarRpc = new rpc.Server(this.network.rpc, this.network.opts);
      const res: xdr.ScVal[] = [
        xdr.ScVal.scvSymbol('Allowance'),
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('from'),
            val: Address.fromString(from).toScVal(),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('spender'),
            val: Address.fromString(spender).toScVal(),
          }),
        ]),
      ];
      const ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: Address.fromString(tokenId).toScAddress(),
          key: xdr.ScVal.scvVec(res),
          durability: xdr.ContractDataDurability.temporary(),
        })
      );
      const ledgerData = await stellarRpc.getLedgerEntries(ledgerKey);

      if (ledgerData.entries.length !== 1) {
        return {
          expiration_ledger: 0,
          amount: 0n,
        };
      }
      let allowance = scValToNative(ledgerData.entries[0].val.contractData().val());

      if (
        allowance === undefined ||
        allowance.expiration_ledger === undefined ||
        allowance.amount === undefined
      ) {
        throw new Error('Invalid allowance data');
      }

      return allowance;
    } catch (e) {
      logger.error(
        `Error loading allowance expiration for tokenId: ${tokenId}\n` +
          `from: ${from}\n` +
          `spender: ${spender}\n` +
          `Error: ${e}`
      );
      throw e;
    }
  }

  /**
   * Fetch the amount of USDC required to mint "lp_tokens" of LP tokens
   * @param lp_tokens The amount of LP tokens to simulate minting
   * @returns The amount of USDC required to mint the LP tokens, or undefined if the simulation failed
   */
  async simLPTokensGetUSDCIn(lp_tokens: bigint): Promise<bigint | undefined> {
    try {
      let comet = new Contract(APP_CONFIG.backstopTokenAddress);
      let op = comet.call(
        'dep_lp_tokn_amt_out_get_tokn_in',
        ...[
          nativeToScVal(APP_CONFIG.usdcAddress, { type: 'address' }),
          nativeToScVal(lp_tokens, { type: 'i128' }),
          nativeToScVal(1_000_000_0000000, { type: 'i128' }),
          nativeToScVal(APP_CONFIG.backstopTokenAddress, {
            type: 'address',
          }),
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
      let stellarRpc = new rpc.Server(this.network.rpc, this.network.opts);

      let result = await stellarRpc.simulateTransaction(tx);
      if (rpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return scValToNative(result.result.retval);
      } else if (rpc.Api.isSimulationError(result)) {
        logger.error(
          `Simulation failed for simLPTokensGetUSDCIn with lp_tokens: ${lp_tokens}`,
          result?.error
        );
        return undefined;
      } else {
        logger.error(
          `Unknown simulation result for simLPTokensGetUSDCIn with lp_tokens: ${lp_tokens}`
        );
        return undefined;
      }
    } catch (e) {
      logger.error(`Error calculating comet token value: ${e}`);
      return undefined;
    }
  }

  /**
   * Fetch the amount of USDC that would be received by withdrawing "lp_tokens" of LP tokens
   * @param lp_tokens The amount of LP tokens withdrawing
   * @returns The amount of USDC that would be received by withdrawing the LP tokens, or undefined if the simulation failed
   */
  async simLPTokensToUSDC(lp_tokens: bigint): Promise<bigint | undefined> {
    try {
      let comet = new Contract(APP_CONFIG.backstopTokenAddress);
      let op = comet.call(
        'wdr_tokn_amt_in_get_lp_tokns_out',
        ...[
          nativeToScVal(APP_CONFIG.usdcAddress, { type: 'address' }),
          nativeToScVal(lp_tokens, { type: 'i128' }),
          nativeToScVal(0, { type: 'i128' }),
          nativeToScVal(APP_CONFIG.backstopAddress, { type: 'address' }),
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
      let stellarRpc = new rpc.Server(this.network.rpc, this.network.opts);

      let result = await stellarRpc.simulateTransaction(tx);
      if (rpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return scValToNative(result.result.retval);
      } else if (rpc.Api.isSimulationError(result)) {
        logger.error(
          `Simulation failed for simLPTokensToUSDC with lp_tokens: ${lp_tokens}`,
          result?.error
        );
        return undefined;
      } else {
        logger.error(
          `Unknown simulation result for simLPTokensToUSDC with lp_tokens: ${lp_tokens}`
        );
        return undefined;
      }
    } catch (e) {
      logger.error(`Error calculating comet token value: ${e}`);
      return undefined;
    }
  }

  async simBalance(tokenId: string, userId: string): Promise<bigint> {
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
      let stellarRpc = new rpc.Server(this.network.rpc, this.network.opts);

      let result = await stellarRpc.simulateTransaction(tx);
      if (rpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return scValToNative(result.result.retval);
      } else {
        return 0n;
      }
    } catch (e) {
      logger.error(`Error fetching balance: ${e}`);
      return 0n;
    }
  }

  /**
   * Fetch the owner of the Interest Filler contract
   * @returns The owner address or undefined if the simulation failed
   */
  async simInterestFillerOwner(): Promise<string | undefined> {
    try {
      let contract = new Contract(APP_CONFIG.interestFillerAddress);
      let op = contract.call('get_owner', ...[]);
      let account = new Account(Keypair.random().publicKey(), '123');
      let tx = new TransactionBuilder(account, {
        networkPassphrase: this.network.passphrase,
        fee: BASE_FEE,
        timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 5 * 60 * 1000 },
      })
        .addOperation(op)
        .build();
      let stellarRpc = new rpc.Server(this.network.rpc, this.network.opts);

      let result = await stellarRpc.simulateTransaction(tx);
      if (rpc.Api.isSimulationSuccess(result) && result.result?.retval) {
        return scValToNative(result.result.retval);
      } else {
        return undefined;
      }
    } catch (e) {
      logger.error(`Error fetching interest filler owner: ${e}`);
      return undefined;
    }
  }

  async submitTransaction<T>(
    operation: string,
    keypair: Keypair
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse & { txHash: string }> {
    const stellarRpc = new rpc.Server(this.network.rpc, this.network.opts);

    let feeStats = await stellarRpc.getFeeStats();
    let fee =
      this.feeLevel === 'high'
        ? Math.max(
            parseInt(feeStats.sorobanInclusionFee.p90),
            APP_CONFIG.highBaseFee ?? 10000
          ).toString()
        : Math.max(
            parseInt(feeStats.sorobanInclusionFee.p70),
            APP_CONFIG.baseFee ?? 5000
          ).toString();

    let account = await stellarRpc.getAccount(keypair.publicKey());
    let tx = new TransactionBuilder(account, {
      networkPassphrase: this.network.passphrase,
      fee: fee,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 5 * 60 * 1000 },
    })
      .addOperation(xdr.Operation.fromXDR(operation, 'base64'))
      .build();

    logger.info(
      `Attempting to simulate and submit transaction ${tx.hash().toString('hex')}: ${tx.toXDR()}`
    );
    let simResult = await stellarRpc.simulateTransaction(tx);

    if (rpc.Api.isSimulationRestore(simResult)) {
      logger.info('Simulation ran into expired entries. Attempting to restore.');
      account = await stellarRpc.getAccount(keypair.publicKey());
      const fee = Number(simResult.restorePreamble.minResourceFee) + 1000;
      const restore_tx = new TransactionBuilder(account, { fee: fee.toString() })
        .setNetworkPassphrase(this.network.passphrase)
        .setTimeout(0)
        .setSorobanData(simResult.restorePreamble.transactionData.build())
        .addOperation(Operation.restoreFootprint({}))
        .build();
      restore_tx.sign(keypair);
      let restore_result = await this.sendTransaction(restore_tx);
      logger.info(`Successfully restored. Tx Hash: ${restore_result.txHash}`);
      account = await stellarRpc.getAccount(keypair.publicKey());
      tx = new TransactionBuilder(account, {
        networkPassphrase: this.network.passphrase,
        fee: BASE_FEE,
        timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 5 * 60 * 1000 },
      })
        .addOperation(xdr.Operation.fromXDR(operation, 'base64'))
        .build();
      simResult = await stellarRpc.simulateTransaction(tx);
    }

    if (rpc.Api.isSimulationSuccess(simResult)) {
      let assembledTx = rpc.assembleTransaction(tx, simResult).build();
      assembledTx.sign(keypair);
      return await this.sendTransaction(assembledTx);
    } else {
      const error = parseError(simResult);
      logger.error(`Tx failed to simlate: ${ContractErrorType[error.type]}`);
      throw error;
    }
  }

  private async sendTransaction(
    transaction: Transaction
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse & { txHash: string }> {
    logger.info(`Submitting transaction: ${transaction.hash().toString('hex')}`);
    const stellarRpc = new rpc.Server(this.network.rpc, this.network.opts);
    let txResponse = await stellarRpc.sendTransaction(transaction);
    if (txResponse.status === 'TRY_AGAIN_LATER') {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      txResponse = await stellarRpc.sendTransaction(transaction);
    }
    let submitStartTime = Date.now();

    if (txResponse.status !== 'PENDING') {
      const error = parseError(txResponse);
      logger.error(
        `Transaction failed to send: Tx Hash: ${txResponse.hash} Error Result XDR: ${txResponse.errorResult?.toXDR('base64')} Parsed Error: ${ContractErrorType[error.type]}`
      );
      throw error;
    }
    let get_tx_response = await stellarRpc.getTransaction(txResponse.hash);
    while (get_tx_response.status === 'NOT_FOUND' && Date.now() - submitStartTime < 12000) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      get_tx_response = await stellarRpc.getTransaction(txResponse.hash);
    }

    if (get_tx_response.status === 'NOT_FOUND') {
      logger.error(`Transaction not found: ${txResponse.hash}`);
      throw new Error('Transaction not found');
    }

    if (get_tx_response.status !== 'SUCCESS') {
      const error = parseError(get_tx_response);
      logger.error(
        `Tx Failed: ${ContractErrorType[error.type]}, Error Result XDR: ${get_tx_response.resultXdr.toXDR('base64')}`
      );

      throw error;
    }
    logger.info(
      'Transaction successfully submitted: ' +
        `Ledger: ${get_tx_response.ledger}\n` +
        `Transaction Result XDR: ${get_tx_response.resultXdr.toXDR('base64')}\n` +
        `Tx Hash: ${txResponse.hash}`
    );
    return { ...get_tx_response, txHash: txResponse.hash };
  }
}
