import { PoolEvent } from '@blend-capital/blend-sdk';

export enum EventType {
  LEDGER = 'ledger',
  PRICE_UPDATE = 'price_update',
  PRICE_SPIKE = 'price_spike',
  LIQ_SCAN = 'liq_scan',
  POOL_EVENT = 'pool_event',
}

// ********* Shared **********

export type AppEvent =
  | LedgerEvent
  | PriceUpdateEvent
  | PriceSpikeEvent
  | LiqScanEvent
  | PoolEventEvent;

/**
 * Base interface for all events.
 */
export interface BaseEvent {
  type: EventType;
  timestamp: number;
}

/**
 * Event for a ledger
 */
export interface LedgerEvent extends BaseEvent {
  type: EventType.LEDGER;
  ledger: number;
}

// ********** Work Queue Only **********

/**
 * Event to update the stored price of all pool assets.
 */
export interface PriceUpdateEvent extends BaseEvent {
  type: EventType.PRICE_UPDATE;
}

/**
 * Event to react to a price spike of a pool asset.
 */
export interface PriceSpikeEvent extends BaseEvent {
  type: EventType.PRICE_SPIKE;
  asset: string;
}

/**
 * Event to scan for liquidations for the given pool.
 */
export interface LiqScanEvent extends BaseEvent {
  type: EventType.LIQ_SCAN;
}

/**
 * Event to react to a pool event.
 */
export interface PoolEventEvent extends BaseEvent {
  type: EventType.POOL_EVENT;
  event: PoolEvent;
}
