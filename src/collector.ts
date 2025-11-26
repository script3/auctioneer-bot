import { poolEventV2FromEventResponse } from '@blend-capital/blend-sdk';
import { rpc } from '@stellar/stellar-sdk';
import { ChildProcess } from 'child_process';
import {
  CheckInterestEvent,
  EventType,
  LedgerEvent,
  LiqScanEvent,
  OracleScanEvent,
  PoolEventEvent,
  PriceUpdateEvent,
  UserRefreshEvent,
} from './events.js';
import { PoolEventHandler } from './pool_event_handler.js';
import { AuctioneerDatabase } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { sendEvent } from './utils/messages.js';
import { Api } from '@stellar/stellar-sdk/rpc';
import { APP_CONFIG, PoolConfig } from './utils/config.js';

let startup_ledger = 0;

export async function runCollector(
  worker: ChildProcess,
  bidder: ChildProcess,
  db: AuctioneerDatabase,
  stellarRpc: rpc.Server,
  poolEventHandler: PoolEventHandler
) {
  const timer = Date.now();
  let statusEntry = db.getStatusEntry('collector');
  if (!statusEntry) {
    statusEntry = { name: 'collector', latest_ledger: 0 };
  }
  const latestLedger = (await stellarRpc.getLatestLedger()).sequence;
  if (latestLedger > statusEntry.latest_ledger) {
    logger.info(`Processing ledger ${latestLedger}`);

    // determine ledgers since bot was started to send long running work events
    // this staggers the events from different bots running on the same pool
    if (startup_ledger === 0) {
      startup_ledger = latestLedger;
    }
    const ledgersProcessed = latestLedger - startup_ledger;

    // new ledger detected
    const ledger_event: LedgerEvent = {
      type: EventType.LEDGER,
      timestamp: Date.now(),
      ledger: latestLedger,
    };
    sendEvent(bidder, ledger_event);

    if (ledgersProcessed % 10 === 0) {
      // approx every minute
      const event: PriceUpdateEvent = {
        type: EventType.PRICE_UPDATE,
        timestamp: Date.now(),
      };
      sendEvent(worker, event);
    }

    // send long running work events to worker
    if (ledgersProcessed % 60 === 0) {
      // approx every 5m
      // send an oracle scan event
      const event: OracleScanEvent = {
        type: EventType.ORACLE_SCAN,
        timestamp: Date.now(),
      };
      sendEvent(worker, event);
    }

    // offset allows for staggered events
    if ((ledgersProcessed + 10) % 1200 === 0) {
      // approx every 2hr
      // send a user update event to update any users that have not been updated in ~2 weeks
      const event: UserRefreshEvent = {
        type: EventType.USER_REFRESH,
        timestamp: Date.now(),
        cutoff: Math.max(latestLedger - 14 * 17280, 0),
      };
      sendEvent(worker, event);
    }

    if ((ledgersProcessed + 5) % 1200 === 0) {
      // approx every 2hr
      // send a liq scan event
      const event: LiqScanEvent = {
        type: EventType.LIQ_SCAN,
        timestamp: Date.now(),
      };
      sendEvent(worker, event);
    }

    if (ledgersProcessed % 7250 === 0) {
      // approx every 12hr
      // send a check interest event
      const event: CheckInterestEvent = {
        type: EventType.CHECK_INTEREST,
        timestamp: Date.now(),
      };
      sendEvent(worker, event);
    }

    // fetch events from last ledger and paging token
    // start from the ledger after the last one we processed
    let start_ledger =
      statusEntry.latest_ledger === 0 ? latestLedger : statusEntry.latest_ledger + 1;
    // if we are too far behind, start from 17270 ledgers ago (default max ledger history is 17280)
    start_ledger = Math.max(start_ledger, latestLedger - 17270);
    let events: rpc.Api.RawGetEventsResponse;
    const filters = createFilter(APP_CONFIG.pools);
    try {
      events = await stellarRpc._getEvents({
        startLedger: start_ledger,
        endLedger: latestLedger + 1,
        filters: filters,
        limit: 100,
      });
    } catch (e: any) {
      // Handles the case where the rpc server is restarted and no longer has events from the start ledger we requested
      if (e.code === -32600) {
        logger.error(
          `Error fetching events at start ledger: ${start_ledger}, retrying with latest ledger ${latestLedger}`,
          e
        );
        events = await stellarRpc._getEvents({
          startLedger: latestLedger,
          endLedger: latestLedger + 1,
          filters: filters,
          limit: 100,
        });
      } else {
        throw e;
      }
    }
    while (events.events.length > 0) {
      for (const raw_event of events.events) {
        let blendPoolEvent = poolEventV2FromEventResponse(raw_event);
        if (blendPoolEvent) {
          // handle pool events immediately
          let poolEvent: PoolEventEvent = {
            type: EventType.POOL_EVENT,
            timestamp: Date.now(),
            event: blendPoolEvent,
          };
          logger.info(`Processing pool event: ${stringify(poolEvent)}`);
          await poolEventHandler.processEventWithRetryAndDeadLetter(poolEvent);
        }
      }
      if (events.cursor != undefined && events.cursor !== '') {
        events = await stellarRpc._getEvents({
          cursor: events.cursor,
          filters: filters,
          limit: 100,
        });
      } else {
        logger.info('No valid cursor detected:', events.cursor);
      }
    }
    statusEntry.latest_ledger = latestLedger;

    // update status entry with processed ledger
    db.setStatusEntry(statusEntry);
    logger.info(`Processed ledger ${latestLedger} in ${Date.now() - timer}ms`);
  }
}

export function createFilter(pools: PoolConfig[]) {
  let filter: Api.EventFilter[] = [];

  let poolIds = pools.map((p) => p.poolAddress);
  for (let i = 0; i < poolIds.length; i += 5) {
    filter.push({
      type: 'contract',
      contractIds: poolIds.slice(i, i + 5),
    });
  }
  return filter;
}
