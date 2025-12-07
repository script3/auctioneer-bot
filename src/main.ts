import { rpc } from '@stellar/stellar-sdk';
import { fork } from 'child_process';
import { runCollector } from './collector.js';
import { EventType, OracleScanEvent, PriceUpdateEvent, UserRefreshEvent } from './events.js';
import { PoolEventHandler } from './pool_event_handler.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase } from './utils/db.js';
import { logger } from './utils/logger.js';
import { sendEvent } from './utils/messages.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { validateBot } from './validation.js';

async function main() {
  // spawn child processes
  const worker = fork('./lib/worker.js', [], { env: { ...process.env, PROCESS_NAME: 'worker' } });
  const bidder = fork('./lib/bidder.js', [], { env: { ...process.env, PROCESS_NAME: 'bidder' } });
  let shutdownExpected = false;
  let collectorInterval: NodeJS.Timeout | null = null;

  const db = AuctioneerDatabase.connect();
  const stellarRpc = new rpc.Server(APP_CONFIG.rpcURL, { allowHttp: true });

  function shutdown(fromChild: boolean = false) {
    console.log('Shutting down auctioneer...');
    shutdownExpected = true;
    // stop collector
    if (collectorInterval) {
      clearInterval(collectorInterval);
    }
    // wait 7s for worker and bidder to finish processing current events
    // then stop child processes and exit
    setTimeout(() => {
      db.close();
      if (worker) {
        worker.kill();
      }
      if (bidder) {
        bidder.kill();
      }
      console.log('Auctioneer shutdown complete.');
      process.exit(fromChild ? 1 : 0);
    }, 7000);
  }

  worker.on('exit', (code, signal) => {
    if (!shutdownExpected) {
      console.log(`Worker exited with code ${code} and signal ${signal} - shutting down app.`);
      shutdown(true);
    }
  });

  bidder.on('exit', (code, signal) => {
    if (!shutdownExpected) {
      console.log(`Bidder exited with code ${code} and signal ${signal} - shutting down app.`);
      shutdown(true);
    }
  });

  worker.on('error', (error) => {
    if (!shutdownExpected) {
      console.log(`Worker errored with ${error} - shutting down app.`);
      shutdown(true);
    }
  });

  bidder.on('error', (error) => {
    if (!shutdownExpected) {
      console.log(`Bidder errored with ${error} - shutting down app.`);
      shutdown(true);
    }
  });

  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());

  console.log('Auctioneer started successfully.');

  console.log('Validating bot against rpc...');

  await validateBot(new SorobanHelper());

  console.log('Bot validation complete.');

  // update price on startup
  const priceEvent: PriceUpdateEvent = {
    type: EventType.PRICE_UPDATE,
    timestamp: Date.now(),
  };
  sendEvent(worker, priceEvent);

  // update price on startup
  const oracleEvent: OracleScanEvent = {
    type: EventType.ORACLE_SCAN,
    timestamp: Date.now(),
  };
  sendEvent(worker, oracleEvent);
  // pull in new manually added users (updated ledger = 0)
  const userEvent: UserRefreshEvent = {
    type: EventType.USER_REFRESH,
    timestamp: Date.now(),
    cutoff: 0,
  };
  sendEvent(worker, userEvent);

  console.log('Collector polling for events...');
  while (!shutdownExpected) {
    try {
      let sorobanHelper = new SorobanHelper();
      let poolEventHandler = new PoolEventHandler(db, sorobanHelper, worker);
      await runCollector(worker, bidder, db, stellarRpc, poolEventHandler);
    } catch (e: any) {
      logger.error(`Error in collector`, e);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.log('Collector stopped!');
}

main().catch((error) => {
  console.error('Unhandled error in main', error);
  process.exit(1);
});
