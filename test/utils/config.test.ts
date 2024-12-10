// config.test.ts
import { Keypair } from '@stellar/stellar-sdk';
import {
  validateAppConfig,
  validateAuctionProfit,
  validateFiller,
  validatePriceSource,
} from '../../src/utils/config';

describe('validateAppConfig', () => {
  it('should return false for non-object config', () => {
    expect(validateAppConfig(null)).toBe(false);
    expect(validateAppConfig('string')).toBe(false);
  });

  it('should return false for config with missing or incorrect properties', () => {
    let invalidConfig: any = {
      name: 'App',
      rpcURL: 'http://localhost',
      networkPassphrase: 'Test',
      poolAddress: 'pool',
      backstopAddress: 'backstop',
      backstopTokenAddress: 'token',
      usdcAddress: 'usdc',
      blndAddress: 'blnd',
      keypair: 'secret',
      fillers: [],
      priceSources: [],
      slackWebhook: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
      duneApiKey: 'key',
    };

    // Test each field for incorrect type
    invalidConfig.name = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.name = 'App'; // Reset to valid value

    invalidConfig.rpcURL = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.rpcURL = 'http://localhost';

    invalidConfig.networkPassphrase = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.networkPassphrase = 'Test';

    invalidConfig.poolAddress = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.poolAddress = 'pool';

    invalidConfig.backstopAddress = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.backstopAddress = 'backstop';

    invalidConfig.backstopTokenAddress = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.backstopTokenAddress = 'token';

    invalidConfig.usdcAddress = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.usdcAddress = 'usdc';

    invalidConfig.blndAddress = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.blndAddress = 'blnd';

    invalidConfig.keypair = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.keypair = Keypair.random().secret();

    invalidConfig.fillers = 'not an array';
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.fillers = [];

    invalidConfig.priceSources = 'not an array';
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.priceSources = [];

    invalidConfig.slackWebhook = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.slackWebhook =
      'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX';

    invalidConfig.duneApiKey = 123;
    expect(validateAppConfig(invalidConfig)).toBe(false);
    invalidConfig.duneApiKey = 'key';
  });

  it('should return true for valid config', () => {
    const validConfig = {
      name: 'App',
      rpcURL: 'http://localhost',
      networkPassphrase: 'Test',
      poolAddress: 'pool',
      backstopAddress: 'backstop',
      backstopTokenAddress: 'token',
      usdcAddress: 'usdc',
      blndAddress: 'blnd',
      keypair: Keypair.random().secret(),
      fillers: [
        {
          name: 'filler',
          keypair: Keypair.random().secret(),
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
      duneApiKey: 'key',
    };
    expect(validateAppConfig(validConfig)).toBe(true);
  });
});

describe('validateFiller', () => {
  it('should return false for non-object filler', () => {
    expect(validateFiller(null)).toBe(false);
    expect(validateFiller('string')).toBe(false);
  });

  it('should return false for filler with missing or incorrect properties', () => {
    const invalidFiller = {
      name: 'filler',
      keypair: 'secret',
      defaultProfitPct: 1,
      minHealthFactor: 1,
      primaryAsset: 'asset',
      minPrimaryCollateral: '100',
      forceFill: true,
      supportedBid: ['bid'],
      supportedLot: 123, // Invalid type
    };
    expect(validateFiller(invalidFiller)).toBe(false);
  });

  it('should return true for valid filler', () => {
    const validFiller = {
      name: 'filler',
      keypair: Keypair.random().secret(),
      defaultProfitPct: 1,
      minHealthFactor: 1,
      primaryAsset: 'asset',
      minPrimaryCollateral: '100',
      forceFill: true,
      supportedBid: ['bid'],
      supportedLot: ['lot'],
    };
    expect(validateFiller(validFiller)).toBe(true);
  });
});

describe('validatePriceSource', () => {
  it('should return false for non-object priceSource', () => {
    expect(validatePriceSource(null)).toBe(false);
    expect(validatePriceSource('string')).toBe(false);
  });

  it('should return false for priceSource with missing or incorrect properties', () => {
    const invalidPriceSource = {
      assetId: 'asset',
      type: 'invalidType', // Invalid type
      symbol: 'symbol',
    };
    expect(validatePriceSource(invalidPriceSource)).toBe(false);
  });

  it('should return true for valid priceSource', () => {
    const validPriceSource = {
      assetId: 'asset',
      type: 'binance',
      symbol: 'symbol',
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
