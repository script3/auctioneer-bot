import { PoolV2Event } from '@blend-capital/blend-sdk';
export enum EventType {
  VALIDATE_POOLS = 'validate_pools',
  LEDGER = 'ledger',
  PRICE_UPDATE = 'price_update',
  ORACLE_SCAN = 'oracle_scan',
  LIQ_SCAN = 'liq_scan',
  POOL_EVENT = 'pool_event',
  USER_REFRESH = 'user_refresh',
  CHECK_USER = 'check_user',
  CHECK_INTEREST = 'check_interest',
}

// ********* Shared **********

export type AppEvent =
  | ValidatePoolsEvent
  | LedgerEvent
  | PriceUpdateEvent
  | OracleScanEvent
  | LiqScanEvent
  | PoolEventEvent
  | UserRefreshEvent
  | CheckUserEvent
  | CheckInterestEvent;

/**
 * Base interface for all events.
 */
export interface BaseEvent {
  /**
   * The type of event
   */
  type: EventType;
  /**
   * The timestamp the event was created in milliseconds since epoch.
   */
  timestamp: number;
}

/**
 * Event for a ledger
 */
export interface LedgerEvent extends BaseEvent {
  type: EventType.LEDGER;
  ledger: number;
}

/**
 * Event to react to a pool event.
 */
export interface PoolEventEvent extends BaseEvent {
  type: EventType.POOL_EVENT;
  event: PoolV2Event;
}

// ********** Work Queue Only **********

export interface ValidatePoolsEvent extends BaseEvent {
  type: EventType.VALIDATE_POOLS;
  pools: string[];
}

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
}

/**
 * Event to scan for liquidations in tracked pools.
 */
export interface LiqScanEvent extends BaseEvent {
  type: EventType.LIQ_SCAN;
}

/**
 * Event to refresh user old user data.
 */
export interface UserRefreshEvent extends BaseEvent {
  type: EventType.USER_REFRESH;
  /**
   * The cutoff ledger such that any user data older than this will be refreshed.
   */
  cutoff: number;
}

/**
 * Event to check a user for liquidations or bad debt.
 */
export interface CheckUserEvent extends BaseEvent {
  type: EventType.CHECK_USER;
  poolId: string;
  /**
   * The user to check.
   */
  userId: string;
}

/**
 * Event to check for interest auctions.
 */
export interface CheckInterestEvent extends BaseEvent {
  type: EventType.CHECK_INTEREST;
}
