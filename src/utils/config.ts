import { Keypair } from '@stellar/stellar-sdk';
import { readFileSync } from 'fs';
import { parse } from './json.js';

export interface Filler {
  name: string;
  keypair: Keypair;
  defaultProfitPct: number;
  supportedPools: PoolFillerConfig[];
  supportedBid: string[];
  supportedLot: string[];
}

export enum PriceSourceType {
  BINANCE = 'binance',
  COINBASE = 'coinbase',
  DEX = 'dex',
}

export interface PriceSourceBase {
  assetId: string;
  type: PriceSourceType;
}

export interface ExchangePriceSource extends PriceSourceBase {
  type: PriceSourceType.BINANCE | PriceSourceType.COINBASE;
  symbol: string;
}

export interface DexPriceSource extends PriceSourceBase {
  type: PriceSourceType.DEX;
  sourceAsset: string;
  destAsset: string;
  destAmount: string;
}

export type PriceSource = ExchangePriceSource | DexPriceSource;

export interface AuctionProfit {
  profitPct: number;
  supportedBid: string[];
  supportedLot: string[];
}

export interface PoolFillerConfig {
  poolAddress: string;
  minPrimaryCollateral: bigint;
  primaryAsset: string;
  minHealthFactor: number;
  forceFill: boolean;
}

export interface AppConfig {
  name: string;
  rpcURL: string;
  networkPassphrase: string;
  backstopTokenAddress: string;
  backstopAddress: string;
  usdcAddress: string;
  blndAddress: string;
  keypair: Keypair;
  fillers: Filler[];
  pools: string[];
  horizonURL: string | undefined;
  priceSources: PriceSource[] | undefined;
  profits: AuctionProfit[] | undefined;
  slackWebhook: string | undefined;
  discordWebhook: string | undefined;
  highBaseFee: number | undefined;
  baseFee: number | undefined;
}

let APP_CONFIG: AppConfig;
if (process.env.NODE_ENV !== 'test') {
  APP_CONFIG = parse<AppConfig>(readFileSync('./data/config.json', 'utf-8'));
  let isValid = validateAppConfig(APP_CONFIG);
  if (!isValid) {
    throw new Error('Invalid config file');
  }
}
export { APP_CONFIG };

export function validateAppConfig(config: any): boolean {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  if (
    typeof config.name !== 'string' ||
    typeof config.rpcURL !== 'string' ||
    typeof config.networkPassphrase !== 'string' ||
    typeof config.backstopAddress !== 'string' ||
    typeof config.backstopTokenAddress !== 'string' ||
    typeof config.usdcAddress !== 'string' ||
    typeof config.blndAddress !== 'string' ||
    typeof config.keypair !== 'string' ||
    !Array.isArray(config.fillers) ||
    !Array.isArray(config.pools) ||
    (config.horizonURL !== undefined && typeof config.horizonURL !== 'string') ||
    (config.priceSources !== undefined && !Array.isArray(config.priceSources)) ||
    (config.profits !== undefined && !Array.isArray(config.profits)) ||
    (config.slackWebhook !== undefined && typeof config.slackWebhook !== 'string') ||
    (config.discordWebhook !== undefined && typeof config.discordWebhook !== 'string') ||
    (config.highBaseFee !== undefined && typeof config.highBaseFee !== 'number') ||
    (config.baseFee !== undefined && typeof config.baseFee !== 'number')
  ) {
    console.log('Invalid app config');
    return false;
  }

  config.keypair = Keypair.fromSecret(config.keypair);

  return (
    config.fillers.every(validateFiller) &&
    config.pools.every((item: any) => typeof item === 'string') &&
    (config.priceSources === undefined || config.priceSources.every(validatePriceSource)) &&
    (config.profits === undefined || config.profits.every(validateAuctionProfit))
  );
}

export function validateFiller(filler: any): boolean {
  if (typeof filler !== 'object' || filler === null) {
    return false;
  }

  if (
    typeof filler.name === 'string' &&
    typeof filler.keypair === 'string' &&
    typeof filler.defaultProfitPct === 'number' &&
    Array.isArray(filler.supportedPools) &&
    filler.supportedPools.every(validatePoolFillerConfig) &&
    Array.isArray(filler.supportedBid) &&
    filler.supportedBid.every((item: any) => typeof item === 'string') &&
    Array.isArray(filler.supportedLot) &&
    filler.supportedLot.every((item: any) => typeof item === 'string')
  ) {
    filler.keypair = Keypair.fromSecret(filler.keypair);
    return true;
  }
  console.log('Invalid filler', filler);
  return false;
}

export function validatePriceSource(priceSource: any): boolean {
  if (
    typeof priceSource !== 'object' ||
    priceSource === null ||
    priceSource.type === undefined ||
    typeof priceSource.assetId !== 'string'
  ) {
    return false;
  }

  switch (priceSource.type) {
    case PriceSourceType.BINANCE:
    case PriceSourceType.COINBASE:
      if (typeof priceSource.symbol === 'string') {
        return true;
      }
      break;
    case PriceSourceType.DEX:
      if (
        typeof priceSource.sourceAsset === 'string' &&
        priceSource.sourceAsset.includes(':') &&
        typeof priceSource.destAsset === 'string' &&
        priceSource.destAsset.includes(':') &&
        typeof priceSource.destAmount === 'string'
      ) {
        return true;
      }
      break;
    default:
      console.log('Invalid price source (unkown type)', priceSource);
      return false;
  }

  console.log('Invalid price source', priceSource);
  return false;
}

export function validateAuctionProfit(profits: any): boolean {
  if (typeof profits !== 'object' || profits === null) {
    return false;
  }

  if (
    typeof profits.profitPct === 'number' &&
    Array.isArray(profits.supportedBid) &&
    profits.supportedBid.every((item: any) => typeof item === 'string') &&
    Array.isArray(profits.supportedLot) &&
    profits.supportedLot.every((item: any) => typeof item === 'string')
  ) {
    return true;
  }

  console.log('Invalid profit', profits);
  return false;
}

export function validatePoolFillerConfig(config: any): boolean {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  if (
    typeof config.poolAddress !== 'string' ||
    typeof config.minPrimaryCollateral !== 'string' ||
    typeof config.primaryAsset !== 'string' ||
    typeof config.minHealthFactor !== 'number' ||
    typeof config.forceFill !== 'boolean'
  ) {
    return false;
  }
  config.minPrimaryCollateral = BigInt(config.minPrimaryCollateral);
  return true;
}
