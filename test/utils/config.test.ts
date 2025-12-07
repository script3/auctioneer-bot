// config.test.ts
import { Keypair } from '@stellar/stellar-sdk';
import {
  validateAppConfig,
  validateAuctionProfit,
  validatePoolConfig,
  validatePriceSource,
} from '../../src/utils/config';

describe('validateAppConfig', () => {
  it('should return false for non-object config', () => {
    expect(validateAppConfig(null)).toBe(false);
    expect(validateAppConfig('string')).toBe(false);
  });

  it('should return false for config with missing or incorrect properties', () => {
    const invalidConfig = {
      name: 'App',
      rpcURL: 'http://localhost',
      networkPassphrase: 'Test',
      backstopAddress: 'backstop',
      backstopTokenAddress: 'token',
      usdcAddress: 'usdc',
      blndAddress: 'blnd',
      keypair: 'secret',
      pools: [],
      fillers: [],
      priceSources: [],
      slackWebhook: 123, // Invalid type
    };
    expect(validateAppConfig(invalidConfig)).toBe(false);
  });

  it('should return false for non-number base fee', () => {
    let invalidConfig = {
      name: 'App',
      rpcURL: 'http://localhost',
      networkPassphrase: 'Test',
      backstopAddress: 'backstop',
      backstopTokenAddress: 'token',
      usdcAddress: 'usdc',
      blndAddress: 'blnd',
      interestFillerAddress: 'filler',
      workerKeypair: Keypair.random().secret(),
      fillerKeypair: Keypair.random().secret(),
      pools: [
        {
          poolAddress: 'pool',
          defaultProfitPct: 1,
          minHealthFactor: 1,
          primaryAsset: 'asset',
          minPrimaryCollateral: '100',
          forceFill: true,
          supportedBid: ['bid'],
          supportedLot: ['lot'],
        },
      ],
      priceSources: [{ assetId: 'asset', type: 'binance', symbol: 'symbol' }],
      slackWebhook: 'http://webhook',
      horizonURL: 'http://horizon',
      highBaseFee: 10000,
      baseFee: '5000',
    };
    expect(validateAppConfig(invalidConfig)).toBe(false);
    // @ts-ignore
    invalidConfig.baseFee = 5000; // Fixing the base fee type
    // @ts-ignore
    invalidConfig.highBaseFee = '10000'; // Fixing the high base fee type
    expect(validateAppConfig(invalidConfig)).toBe(false);
  });

  it('should return true for valid config', () => {
    const validConfig = {
      name: 'App',
      rpcURL: 'http://localhost',
      networkPassphrase: 'Test',
      backstopAddress: 'backstop',
      backstopTokenAddress: 'token',
      usdcAddress: 'usdc',
      blndAddress: 'blnd',
      interestFillerAddress: 'filler',
      workerKeypair: Keypair.random().secret(),
      fillerKeypair: Keypair.random().secret(),
      pools: [
        {
          poolAddress: 'pool',
          defaultProfitPct: 1,
          minHealthFactor: 1,
          primaryAsset: 'asset',
          minPrimaryCollateral: '100',
          forceFill: true,
          supportedBid: ['bid'],
          supportedLot: ['lot'],
        },
      ],
      priceSources: [{ assetId: 'asset', type: 'binance', symbol: 'symbol' }],
      slackWebhook: 'http://webhook',
      horizonURL: 'http://horizon',
    };
    expect(validateAppConfig(validConfig)).toBe(true);
  });

  it('should return true for valid config with base fees', () => {
    const validConfig = {
      name: 'App',
      rpcURL: 'http://localhost',
      networkPassphrase: 'Test',
      backstopAddress: 'backstop',
      backstopTokenAddress: 'token',
      usdcAddress: 'usdc',
      blndAddress: 'blnd',
      interestFillerAddress: 'filler',
      workerKeypair: Keypair.random().secret(),
      fillerKeypair: Keypair.random().secret(),
      pools: [
        {
          poolAddress: 'pool',
          defaultProfitPct: 1,
          minHealthFactor: 1,
          primaryAsset: 'asset',
          minPrimaryCollateral: '100',
          forceFill: true,
          supportedBid: ['bid'],
          supportedLot: ['lot'],
        },
      ],
      priceSources: [{ assetId: 'asset', type: 'binance', symbol: 'symbol' }],
      slackWebhook: 'http://webhook',
      horizonURL: 'http://horizon',
      highBaseFee: 10000,
      baseFee: 5000,
    };
    expect(validateAppConfig(validConfig)).toBe(true);
  });
});

describe('validatePoolConfig', () => {
  it('should return false for non-object pool config', () => {
    expect(validatePoolConfig(null)).toBe(false);
    expect(validatePoolConfig('string')).toBe(false);
  });

  it('should return false for pool config with missing or incorrect properties', () => {
    const invalidPoolConfig = {
      poolAddress: 'pool',
      defaultProfitPct: '1', // Invalid type
      minHealthFactor: 1,
      primaryAsset: 'asset',
      minPrimaryCollateral: '100',
      forceFill: true,
      supportedBid: ['bid'],
      supportedLot: ['lot'],
    };
    expect(validatePoolConfig(invalidPoolConfig)).toBe(false);
  });

  it('should return true for valid filler', () => {
    const validPoolConfig = {
      poolAddress: 'pool',
      defaultProfitPct: 1,
      minHealthFactor: 1,
      primaryAsset: 'asset',
      minPrimaryCollateral: '100',
      forceFill: true,
      supportedBid: ['bid'],
      supportedLot: ['lot'],
    };
    expect(validatePoolConfig(validPoolConfig)).toBe(true);
  });
});

describe('validatePriceSource', () => {
  it('should return false for non-object priceSource', () => {
    expect(validatePriceSource(null)).toBe(false);
    expect(validatePriceSource('string')).toBe(false);
  });

  it('should return false for exchangePriceSource with missing or incorrect properties', () => {
    const invalidPriceSource = {
      assetId: 'asset',
      type: 'invalidType', // Invalid type
      symbol: 'symbol',
    };
    expect(validatePriceSource(invalidPriceSource)).toBe(false);
  });

  it('should return true for valid exchangePriceSource', () => {
    const validPriceSource = {
      assetId: 'asset',
      type: 'binance',
      symbol: 'symbol',
    };
    expect(validatePriceSource(validPriceSource)).toBe(true);
  });

  it('should return false for dexPriceSource with missing or incorrect properties', () => {
    const validPriceSource = {
      assetId: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
      type: 'dex',
      sourceAsset: 'EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
      destAsset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      destAmount: '1000',
    };
    expect(validatePriceSource(validPriceSource)).toBe(false);
  });

  it('should return true for valid dexPriceSource', () => {
    const validPriceSource = {
      assetId: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
      type: 'dex',
      sourceAsset: 'EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
      destAsset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      destAmount: '1000',
    };
    expect(validatePriceSource(validPriceSource)).toBe(true);
  });
});

describe('validateAuctionProfit', () => {
  it('should return false for non-object profits', () => {
    expect(validateAuctionProfit(null)).toBe(false);
    expect(validateAuctionProfit('string')).toBe(false);
  });

  it('should return false for profits with missing or incorrect properties', () => {
    const invalidProfits = {
      profitPct: 1,
      supportedBid: ['asset1', 'asset2'],
      supportedLot: 'asset2', // Invalid type
    };
    expect(validateAuctionProfit(invalidProfits)).toBe(false);
  });

  it('should return true for valid profits', () => {
    const validProfits = {
      profitPct: 1,
      supportedBid: ['asset1', 'asset2'],
      supportedLot: ['asset2'],
    };
    expect(validateAuctionProfit(validProfits)).toBe(true);
  });
});
