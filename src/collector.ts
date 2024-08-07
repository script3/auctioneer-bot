import { poolEventFromEventResponse } from '@blend-capital/blend-sdk';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { ChildProcess } from 'child_process';
import {
  EventType,
  LedgerEvent,
  LiqScanEvent,
  PoolEventEvent,
  PriceUpdateEvent,
} from './events.js';
import { PoolEventHandler } from './pool_event_handler.js';
import { AuctioneerDatabase } from './utils/db.js';
import { logger } from './utils/logger.js';
import { sendEvent } from './utils/messages.js';

export async function runCollector(
  worker: ChildProcess,
  bidder: ChildProcess,
  db: AuctioneerDatabase,
  rpc: SorobanRpc.Server,
  poolAddress: string,
  poolEventHandler: PoolEventHandler
) {
  const timer = Date.now();
  let statusEntry = db.getStatusEntry('collector');
  if (!statusEntry) {
    statusEntry = { name: 'collector', latest_ledger: 0 };
  }
  const latestLedger = (await rpc.getLatestLedger()).sequence;
  if (latestLedger > statusEntry.latest_ledger) {
    logger.info(`Processing ledger ${latestLedger}`);
    // new ledger detected
    const ledger_event: LedgerEvent = {
      type: EventType.LEDGER,
      timestamp: Date.now(),
      ledger: latestLedger,
    };
    sendEvent(bidder, ledger_event);

    // send long running work events to worker
    if (latestLedger % 10 === 0) {
      // approx every minute
      const event: PriceUpdateEvent = {
        type: EventType.PRICE_UPDATE,
        timestamp: Date.now(),
      };
      sendEvent(worker, event);
    }
    if (latestLedger % 300 === 0) {
      // approx every 30m
      // send a liq scan event
      const event: LiqScanEvent = {
        type: EventType.LIQ_SCAN,
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
    let events = await rpc._getEvents({
      startLedger: start_ledger,
      filters: [
        {
          type: 'contract',
          contractIds: [poolAddress],
        },
      ],
      limit: 100,
    });
    let cursor = '';
    while (events.events.length > 0) {
      for (const raw_event of events.events) {
        let blendPoolEvent = poolEventFromEventResponse(raw_event);
        if (blendPoolEvent) {
          // handle pool events immediately
          let poolEvent: PoolEventEvent = {
            type: EventType.POOL_EVENT,
            timestamp: Date.now(),
            event: blendPoolEvent,
          };
          await poolEventHandler.processEventWithRetryAndDeadLetter(poolEvent);
        }
      }
      cursor = events.events[events.events.length - 1].pagingToken;
      events = await rpc._getEvents({
        cursor: cursor,
        filters: [
          {
            type: 'contract',
            contractIds: [poolAddress],
          },
        ],
        limit: 100,
      });
    }
    statusEntry.latest_ledger = latestLedger;

    // update status entry with processed ledger
    db.setStatusEntry(statusEntry);
    logger.info(`Processed ledger ${latestLedger} in ${Date.now() - timer}ms`);
  }
}
