import { poolEventFromEventResponse } from '@blend-capital/blend-sdk';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { Channel, connect } from 'amqplib';
import { config } from 'dotenv';
import { AUCTION_QUEUE_KEY, WORK_QUEUE_KEY } from './constants.js';
import {
  EventType,
  HealthCheckEvent,
  LiqScanEvent,
  PoolEventEvent,
  PriceUpdateEvent,
} from './events.js';
import { AuctioneerDatabase } from './utils/db.js';
import { logger } from './utils/logger.js';
import { sendEvent } from './utils/queue.js';

config();
const RPC_URL = process.env.RPC_URL as string;
const POOL_ADDRESS = process.env.POOL_ADDRESS as string;

async function main() {
  const connection = await connect('amqp://localhost');
  const channel = await connection.createChannel();
  await channel.assertQueue(WORK_QUEUE_KEY, { durable: true });
  await channel.assertQueue(AUCTION_QUEUE_KEY, { durable: true });

  logger.info(`Connected to ${WORK_QUEUE_KEY}`);

  setInterval(async () => {
    let db: AuctioneerDatabase | undefined = undefined;
    try {
      db = AuctioneerDatabase.connect();
      const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
      await runCollector(channel, db, rpc);
    } catch (e: any) {
      logger.error(`Error in collector`, e);
    } finally {
      if (db) {
        db.close();
      }
    }
  }, 1000);
}

main().catch(console.error);

async function runCollector(channel: Channel, db: AuctioneerDatabase, rpc: SorobanRpc.Server) {
  const timer = Date.now();
  let statusEntry = db.getStatusEntry('collector');
  if (!statusEntry) {
    statusEntry = { name: 'collector', latest_ledger: 0 };
  }
  const latestLedger = (await rpc.getLatestLedger()).sequence;
  if (latestLedger > statusEntry.latest_ledger) {
    logger.info(`Processing ledger ${latestLedger}`);
    // new ledger detected
    // send timed events
    if (latestLedger % 10 === 0) {
      // approx every minute
      const event: PriceUpdateEvent = {
        type: EventType.PRICE_UPDATE,
        timestamp: Date.now(),
      };
      sendEvent(channel, WORK_QUEUE_KEY, event);
    }
    if (latestLedger % 100 === 0) {
      // approx every 10 minutes
      const event: HealthCheckEvent = {
        type: EventType.HEALTHCHECK,
        timestamp: Date.now(),
        start_ledger: latestLedger,
      };
      sendEvent(channel, WORK_QUEUE_KEY, event);
      sendEvent(channel, AUCTION_QUEUE_KEY, event);
    }
    if (latestLedger % 600 === 0) {
      // approx every hour
      // send a liq scan event
      const event: LiqScanEvent = {
        type: EventType.LIQ_SCAN,
        timestamp: Date.now(),
      };
      sendEvent(channel, WORK_QUEUE_KEY, event);
    }
    // fetch events from last ledger and paging token
    // start from the ledger after the last one we processed
    let start_ledger =
      statusEntry.latest_ledger === 0 ? latestLedger : statusEntry.latest_ledger + 1;
    let events = await rpc._getEvents({
      startLedger: start_ledger,
      filters: [
        {
          type: 'contract',
          contractIds: [POOL_ADDRESS],
        },
      ],
      limit: 100,
    });
    let cursor = '';
    while (events.events.length > 0) {
      for (const raw_event of events.events) {
        let blendPoolEvent = poolEventFromEventResponse(raw_event);
        if (blendPoolEvent) {
          // send events to work queue
          let poolEvent: PoolEventEvent = {
            type: EventType.POOL_EVENT,
            timestamp: Date.now(),
            event: blendPoolEvent,
          };
          sendEvent(channel, WORK_QUEUE_KEY, poolEvent);
        }
      }
      cursor = events.events[events.events.length - 1].pagingToken;
      events = await rpc._getEvents({
        cursor: cursor,
        filters: [
          {
            type: 'contract',
            contractIds: [POOL_ADDRESS],
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
