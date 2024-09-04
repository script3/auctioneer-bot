import { PoolEvent } from '@blend-capital/blend-sdk';

export enum EventType {
  LEDGER = 'ledger',
  PRICE_UPDATE = 'price_update',
  ORACLE_SCAN = 'oracle_scan',
  LIQ_SCAN = 'liq_scan',
  POOL_EVENT = 'pool_event',
}

// ********* Shared **********

export type AppEvent =
  | LedgerEvent
  | PriceUpdateEvent
  | OracleScanEvent
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
 * Check for changes in oracle prices and any potential liquidations due to oracle fluctuations.
 */
export interface OracleScanEvent extends BaseEvent {
  type: EventType.ORACLE_SCAN;
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
