import {
  AuctionType,
  BackstopToken,
  FixedMath,
  Network,
  PoolMetadata,
  PoolOracle,
  PoolV2,
  PriceData,
  Reserve,
  ReserveData,
} from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import { SorobanHelper } from '../src/utils/soroban_helper.js';
import { WorkSubmissionType } from '../src/work_submitter.js';
import { ReserveConfig } from '@blend-capital/blend-sdk';
import { checkPoolForInterestAuction } from '../src/interest.js';
import { PoolConfig } from '../src/utils/config.js';

jest.mock('../src/utils/soroban_helper.js');
jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));
jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      backstopAddress: 'backstopAddress',
      backstopTokenAddress: 'backstopTokenAddress',
      fillerKeypair: Keypair.random(),
    },
  };
});

describe('checkPoolForInterestAuction', () => {
  let mockedSorobanHelper: jest.Mocked<SorobanHelper>;
  let mockBackstopToken: BackstopToken;
  let poolConfig: PoolConfig;

  beforeEach(() => {
    mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
    mockBackstopToken = {
      lpTokenPrice: 0.5,
    } as BackstopToken;
    poolConfig = {
      poolAddress: 'pool1',
      minPrimaryCollateral: FixedMath.toFixed(100, 7),
      primaryAsset: 'USD',
      minHealthFactor: 1.1,
      defaultProfitPct: 0.05,
      forceFill: true,
      supportedBid: ['asset1', 'asset2', 'asset3', 'backstopTokenAddress'],
      supportedLot: ['asset1', 'asset2', 'asset3'],
    };
  });

  it('returns interest auction creation submission happy path', async () => {
    const assets = ['asset1', 'asset2', 'asset3'];

    const backstopCredit = [BigInt(100e7), BigInt(2e7), BigInt(300e7)];
    const decimals = [7, 7, 7];
    const pool = buildPoolObject('pool1', assets, backstopCredit, decimals);

    const prices = [BigInt(1e7), BigInt(4e7), BigInt(0.75e7)];
    const poolOracle = buildPoolOracleObject(assets, prices, 7);

    mockedSorobanHelper.loadPool.mockResolvedValue(pool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(poolOracle);
    mockedSorobanHelper.loadBackstopToken.mockResolvedValue(mockBackstopToken);

    // usdc balance for filler
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(1000e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toEqual({
      type: WorkSubmissionType.AuctionCreation,
      poolId: 'pool1',
      auctionType: AuctionType.Interest,
      user: 'backstopAddress',
      auctionPercent: 100,
      bid: ['backstopTokenAddress'],
      lot: ['asset3', 'asset1'],
    });
  });

  it('returns undefined if filler does not have enough usdc', async () => {
    const assets = ['asset1', 'asset2', 'asset3'];

    const backstopCredit = [BigInt(100e7), BigInt(2e7), BigInt(300e7)];
    const decimals = [7, 7, 7];
    const pool = buildPoolObject('pool1', assets, backstopCredit, decimals);

    const prices = [BigInt(1e7), BigInt(4e7), BigInt(0.67e7)];
    const poolOracle = buildPoolOracleObject(assets, prices, 7);

    mockedSorobanHelper.loadPool.mockResolvedValue(pool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(poolOracle);
    mockedSorobanHelper.loadBackstopToken.mockResolvedValue(mockBackstopToken);

    // usdc balance for filler
    // -> auctionv val is ~301
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(300e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toBeUndefined();
  });

  it('returns undefined if config does not support included assets', async () => {
    const assets = ['asset1', 'asset2', 'asset3', 'asset4'];

    const backstopCredit = [BigInt(100e7), BigInt(2e7), BigInt(300e7), BigInt(100e7)];
    const decimals = [7, 7, 7, 7];
    const pool = buildPoolObject('pool1', assets, backstopCredit, decimals);

    const prices = [BigInt(1e7), BigInt(4e7), BigInt(0.67e7), BigInt(2e7)];
    const poolOracle = buildPoolOracleObject(assets, prices, 7);

    mockedSorobanHelper.loadPool.mockResolvedValue(pool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(poolOracle);
    mockedSorobanHelper.loadBackstopToken.mockResolvedValue(mockBackstopToken);

    // usdc balance for filler
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(5000e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toBeUndefined();
  });

  it('returns interest auction creation submission max 3 assets', async () => {
    const assets = ['asset1', 'asset2', 'asset3', 'asset4'];

    poolConfig.poolAddress = 'pool2';
    poolConfig.supportedLot = assets;

    const backstopCredit = [BigInt(105e7), BigInt(10e7), BigInt(200e7), BigInt(100e7)];
    const decimals = [7, 7, 7, 7];
    const pool = buildPoolObject('pool2', assets, backstopCredit, decimals);

    const prices = [BigInt(1e7), BigInt(4e7), BigInt(0.5e7), BigInt(2e7)];
    const poolOracle = buildPoolOracleObject(assets, prices, 7);

    mockedSorobanHelper.loadPool.mockResolvedValue(pool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(poolOracle);
    mockedSorobanHelper.loadBackstopToken.mockResolvedValue(mockBackstopToken);

    // backstop token balance for filler
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(1000e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toEqual({
      type: WorkSubmissionType.AuctionCreation,
      poolId: 'pool2',
      auctionType: AuctionType.Interest,
      user: 'backstopAddress',
      auctionPercent: 100,
      bid: ['backstopTokenAddress'],
      lot: ['asset4', 'asset1', 'asset3'],
    });
  });

  it('returns interest auction creation submission respects pool max positions', async () => {
    const assets = ['asset1', 'asset2', 'asset3', 'asset4'];

    poolConfig.poolAddress = 'pool2';
    poolConfig.supportedLot = assets;

    const backstopCredit = [BigInt(105e7), BigInt(10e7), BigInt(200e7), BigInt(100e7)];
    const decimals = [7, 7, 7, 7];
    const pool = buildPoolObject('pool2', assets, backstopCredit, decimals);
    pool.metadata.maxPositions = 3;

    const prices = [BigInt(1e7), BigInt(4e7), BigInt(0.5e7), BigInt(2e7)];
    const poolOracle = buildPoolOracleObject(assets, prices, 7);

    mockedSorobanHelper.loadPool.mockResolvedValue(pool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(poolOracle);
    mockedSorobanHelper.loadBackstopToken.mockResolvedValue(mockBackstopToken);

    // backstop token balance for filler
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(1000e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toEqual({
      type: WorkSubmissionType.AuctionCreation,
      poolId: 'pool2',
      auctionType: AuctionType.Interest,
      user: 'backstopAddress',
      auctionPercent: 100,
      bid: ['backstopTokenAddress'],
      lot: ['asset4', 'asset1'],
    });
  });

  it('returns undefined respects pool max positions', async () => {
    const assets = ['asset1', 'asset2', 'asset3', 'asset4'];

    poolConfig.poolAddress = 'pool2';
    poolConfig.supportedLot = assets;

    const backstopCredit = [BigInt(105e7), BigInt(10e7), BigInt(200e7), BigInt(60e7)];
    const decimals = [7, 7, 7, 7];
    const pool = buildPoolObject('pool2', assets, backstopCredit, decimals);
    pool.metadata.maxPositions = 3;

    const prices = [BigInt(1e7), BigInt(4e7), BigInt(0.5e7), BigInt(2e7)];
    const poolOracle = buildPoolOracleObject(assets, prices, 7);

    mockedSorobanHelper.loadPool.mockResolvedValue(pool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(poolOracle);
    mockedSorobanHelper.loadBackstopToken.mockResolvedValue(mockBackstopToken);

    // backstop token balance for filler
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(1000e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toBeUndefined();
  });
});

function buildPoolObject(
  id: string,
  assets: string[],
  backstopCredit: bigint[],
  decimals: number[]
): PoolV2 {
  const pool = new PoolV2(
    {} as Network,
    id,
    {
      maxPositions: 6,
      oracle: 'oracleId',
    } as PoolMetadata,
    new Map<string, Reserve>(
      assets.map((asset, index) => [
        asset,
        {
          config: { decimals: decimals[index] } as ReserveConfig,
          data: {
            bRate: BigInt(1_000_000_000_000),
            backstopCredit: backstopCredit[index],
          } as ReserveData,
        } as Reserve,
      ])
    ),
    1723578353
  );

  return pool;
}

function buildPoolOracleObject(assets: string[], prices: bigint[], decimals: number): PoolOracle {
  const poolOracle = new PoolOracle(
    'pool1',
    new Map<string, PriceData>(
      assets.map((asset, index) => [asset, { price: prices[index], timestamp: 1724950800 }])
    ),
    decimals,
    53255053
  );

  return poolOracle;
}
