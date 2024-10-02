// config.test.ts
import { Keypair } from '@stellar/stellar-sdk';
import { validateAppConfig, validateFiller, validatePriceSource } from '../../src/utils/config';

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
      poolAddress: 'pool',
      backstopAddress: 'backstop',
      backstopTokenAddress: 'token',
      usdcAddress: 'usdc',
      blndAddress: 'blnd',
      keypair: 'secret',
      fillers: [],
      priceSources: [],
      slackWebhook: 123, // Invalid type
    };
    expect(validateAppConfig(invalidConfig)).toBe(false);
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
          minProfitPct: 1,
          minHealthFactor: 1,
          forceFill: true,
          supportedBid: ['bid'],
          supportedLot: ['lot'],
        },
      ],
      priceSources: [{ assetId: 'asset', type: 'binance', symbol: 'symbol' }],
      slackWebhook: 'http://webhook',
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
      minProfitPct: 1,
      minHealthFactor: 1,
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
      minProfitPct: 1,
      minHealthFactor: 1,
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
