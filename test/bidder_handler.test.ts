import { Auction } from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import { AuctionFill, calculateAuctionFill } from '../src/auction';
import { BidderHandler } from '../src/bidder_handler';
import { AuctionBid, BidderSubmissionType, BidderSubmitter } from '../src/bidder_submitter';
import { AppEvent, EventType, LedgerEvent } from '../src/events';
import { APP_CONFIG, AppConfig, PoolConfig } from '../src/utils/config';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from '../src/utils/db';
import { logger } from '../src/utils/logger';
import { sendNotification } from '../src/utils/notifier';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { inMemoryAuctioneerDb } from './helpers/mocks';

jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock('../src/utils/config.js', () => {
  let config: AppConfig = {
    backstopAddress: 'backstopAddress',
    backstopTokenAddress: 'backstopTokenAddress',
    interestFillerAddress: 'filler',
    workerKeypair: Keypair.random(),
    fillerKeypair: Keypair.random(),
    pools: [
      {
        poolAddress: 'pool1',
        primaryAsset: 'USD',
        minPrimaryCollateral: 100n,
        minHealthFactor: 1.1,
        defaultProfitPct: 0.05,
        forceFill: true,
        supportedBid: ['USD', 'BTC', 'LP', 'XLM'],
        supportedLot: ['USD', 'BTC', 'ETH'],
      },
      {
        poolAddress: 'pool2',
        primaryAsset: 'USD',
        minPrimaryCollateral: 100n,
        minHealthFactor: 1.1,
        defaultProfitPct: 0.05,
        forceFill: true,
        supportedBid: ['USD', 'BTC', 'LP', 'XLM'],
        supportedLot: ['USD', 'BTC', 'ETH'],
      },
    ],
  } as AppConfig;
  return {
    APP_CONFIG: config,
  };
});
jest.mock('../src/liquidations');
jest.mock('../src/utils/soroban_helper');
jest.mock('../src/bidder_submitter');
jest.mock('../src/auction');
jest.mock('../src/utils/notifier');

describe('BidderHandler', () => {
  let bidderHandler: BidderHandler;
  let db: AuctioneerDatabase;
  let mockedBidderSubmitter: jest.Mocked<BidderSubmitter>;
  let mockedSorobanHelper: jest.Mocked<SorobanHelper> =
    new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let mockedCalcAuctionFill = calculateAuctionFill as jest.MockedFunction<
    typeof calculateAuctionFill
  >;
  let mockedSendSlackNotif = sendNotification as jest.MockedFunction<typeof sendNotification>;

  beforeEach(() => {
    jest.resetAllMocks();
    db = inMemoryAuctioneerDb();
    mockedBidderSubmitter = new BidderSubmitter(db) as jest.Mocked<BidderSubmitter>;
    bidderHandler = new BidderHandler(db, mockedBidderSubmitter, mockedSorobanHelper);
  });

  it('should update new auction entries on ledger event', async () => {
    let ledger = 1000;
    let auction_1: AuctionEntry = {
      pool_id: 'pool1',
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillerKeypair.publicKey(),
      start_block: ledger - 15,
      fill_block: ledger + 180,
      updated: ledger - 14,
    };
    let auction_2: AuctionEntry = {
      pool_id: 'pool2',
      user_id: 'user2',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillerKeypair.publicKey(),
      start_block: ledger - 1,
      fill_block: 0,
      updated: 0,
    };
    db.setAuctionEntry(auction_1);
    db.setAuctionEntry(auction_2);
    mockedSorobanHelper.loadAuction.mockResolvedValue(
      new Auction('teapot', AuctionType.Liquidation, {
        bid: new Map<string, bigint>(),
        lot: new Map<string, bigint>(),
        block: ledger - 1,
      })
    );
    let fill_calc: AuctionFill = {
      block: 1200,
      percent: 50,
      lotValue: 1000,
      bidValue: 900,
      requests: [],
    };
    mockedCalcAuctionFill.mockResolvedValue(fill_calc);

    const Pool1AppEvent: AppEvent = {
      type: EventType.LEDGER,
      ledger,
    } as LedgerEvent;
    await bidderHandler.processEvent(Pool1AppEvent);
    const Pool2AppEvent: AppEvent = {
      type: EventType.LEDGER,
      ledger,
    } as LedgerEvent;
    await bidderHandler.processEvent(Pool2AppEvent);

    expect(mockedSorobanHelper.loadAuction).toHaveBeenCalledTimes(1);
    // validate auction 2 is updated
    let new_auction_2 = db.getAuctionEntry(
      auction_2.pool_id,
      auction_2.user_id,
      auction_2.auction_type
    );
    expect(new_auction_2).toBeDefined();
    expect(new_auction_2?.user_id).toEqual(auction_2.user_id);
    expect(new_auction_2?.auction_type).toEqual(auction_2.auction_type);
    expect(new_auction_2?.filler).toEqual(auction_2.filler);
    expect(new_auction_2?.start_block).toEqual(auction_2.start_block);
    expect(new_auction_2?.fill_block).toEqual(fill_calc.block);
    expect(new_auction_2?.updated).toEqual(ledger);
    expect(mockedSendSlackNotif).toHaveBeenCalledTimes(1);

    // validate auction 1 is not updated
    let new_auction_1 = db.getAuctionEntry(
      auction_1.pool_id,
      auction_1.user_id,
      auction_1.auction_type
    );
    expect(new_auction_1?.fill_block).toEqual(auction_1.fill_block);
    expect(new_auction_1?.updated).toEqual(auction_1.updated);
  });

  it('should update auction entries on the 10th block and less than 5 blocks on ledger event', async () => {
    let ledger = 1000; // nextLedger is 1001
    let auction_1: AuctionEntry = {
      pool_id: 'pool1',
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillerKeypair.publicKey(),
      start_block: ledger - 15,
      fill_block: ledger + 1 + 150, // to fill in 150 blocks from next ledger
      updated: ledger - 10,
    };
    let auction_2: AuctionEntry = {
      pool_id: 'pool1',
      user_id: 'backstop',
      auction_type: AuctionType.Interest,
      filler: APP_CONFIG.fillerKeypair.publicKey(),
      start_block: ledger - 240,
      fill_block: ledger + 5,
      updated: ledger - 5,
    };
    db.setAuctionEntry(auction_1);
    db.setAuctionEntry(auction_2);
    mockedSorobanHelper.loadAuction.mockResolvedValue(
      new Auction('teapot', AuctionType.Liquidation, {
        bid: new Map<string, bigint>(),
        lot: new Map<string, bigint>(),
        block: ledger - 1,
      })
    );
    let fill_calc_1: AuctionFill = {
      block: 1200,
      percent: 50,
      lotValue: 1000,
      bidValue: 900,
      requests: [],
    };
    let fill_calc_2: AuctionFill = {
      block: 1002,
      percent: 60,
      lotValue: 1000,
      bidValue: 900,
      requests: [],
    };
    mockedCalcAuctionFill.mockResolvedValueOnce(fill_calc_1).mockResolvedValueOnce(fill_calc_2);

    const appEvent: AppEvent = {
      type: EventType.LEDGER,
      ledger,
    } as LedgerEvent;
    await bidderHandler.processEvent(appEvent);

    // validate auction 1 is updated
    let new_auction_1 = db.getAuctionEntry(
      auction_1.pool_id,
      auction_1.user_id,
      auction_1.auction_type
    );
    expect(new_auction_1?.fill_block).toEqual(fill_calc_1.block);
    expect(new_auction_1?.updated).toEqual(ledger);

    // validate auction 2 is updated
    let new_auction_2 = db.getAuctionEntry(
      auction_2.pool_id,
      auction_2.user_id,
      auction_2.auction_type
    );
    expect(new_auction_2?.fill_block).toEqual(fill_calc_2.block);
    expect(new_auction_2?.updated).toEqual(ledger);
  });

  it('should place auction on submitter queue if fill block is reached or past on ledger event', async () => {
    let ledger = 1000; // nextLedger is 1001
    let auction_1: AuctionEntry = {
      pool_id: 'pool1',
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillerKeypair.publicKey(),
      start_block: ledger - 150,
      fill_block: ledger + 3,
      updated: ledger - 1,
    };
    let auction_2: AuctionEntry = {
      pool_id: 'pool1',
      user_id: 'backstop',
      auction_type: AuctionType.Interest,
      filler: APP_CONFIG.fillerKeypair.publicKey(),
      start_block: ledger - 240,
      fill_block: ledger - 5,
      updated: ledger - 2,
    };
    db.setAuctionEntry(auction_1);
    db.setAuctionEntry(auction_2);
    mockedSorobanHelper.loadAuction.mockResolvedValue(
      new Auction('teapot', AuctionType.Liquidation, {
        bid: new Map<string, bigint>(),
        lot: new Map<string, bigint>(),
        block: ledger - 1,
      })
    );
    let fill_calc_1: AuctionFill = {
      block: 1001,
      percent: 50,
      lotValue: 1000,
      bidValue: 900,
      requests: [],
    };

    let fill_calc_2: AuctionFill = {
      block: 995,
      percent: 60,
      lotValue: 1000,
      bidValue: 900,
      requests: [],
    };
    mockedCalcAuctionFill.mockResolvedValueOnce(fill_calc_1).mockResolvedValueOnce(fill_calc_2);

    const appEvent: AppEvent = {
      type: EventType.LEDGER,
      ledger,
    } as LedgerEvent;
    await bidderHandler.processEvent(appEvent);

    // validate auction 1 is placed on submission queue
    let new_auction_1 = db.getAuctionEntry(
      auction_1.pool_id,
      auction_1.user_id,
      auction_1.auction_type
    );
    expect(new_auction_1?.fill_block).toEqual(fill_calc_1.block);
    expect(new_auction_1?.updated).toEqual(ledger);

    let submission_1: AuctionBid = {
      type: BidderSubmissionType.BID,
      auctionEntry: new_auction_1 as AuctionEntry,
    };
    expect(mockedBidderSubmitter.addSubmission).toHaveBeenCalledWith(submission_1, 10);

    // validate auction 2 is placed on submission queue
    let new_auction_2 = db.getAuctionEntry(
      auction_2.pool_id,
      auction_2.user_id,
      auction_2.auction_type
    );
    expect(new_auction_2?.fill_block).toEqual(fill_calc_2.block);
    expect(new_auction_2?.updated).toEqual(ledger);

    let submission_2: AuctionBid = {
      type: BidderSubmissionType.BID,
      auctionEntry: new_auction_1 as AuctionEntry,
    };
    expect(mockedBidderSubmitter.addSubmission).toHaveBeenCalledWith(submission_2, 10);
  });

  it('should skip an auction if it is already on the submission queue on ledger event', async () => {
    let ledger = 1000; // nextLedger is 1001
    let auction_1: AuctionEntry = {
      pool_id: 'pool1',
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillerKeypair.publicKey(),
      start_block: ledger - 150,
      fill_block: ledger,
      updated: ledger - 1,
    };
    db.setAuctionEntry(auction_1);
    mockedSorobanHelper.loadAuction.mockResolvedValue(
      new Auction('teapot', AuctionType.Liquidation, {
        bid: new Map<string, bigint>(),
        lot: new Map<string, bigint>(),
        block: ledger - 1,
      })
    );
    let fill_calc_1: AuctionFill = {
      block: 1001,
      percent: 50,
      lotValue: 1000,
      bidValue: 900,
      requests: [],
    };
    mockedCalcAuctionFill.mockResolvedValue(fill_calc_1);
    mockedBidderSubmitter.containsAuction.mockReturnValue(true);

    const appEvent: AppEvent = { type: EventType.LEDGER, ledger } as LedgerEvent;
    await bidderHandler.processEvent(appEvent);

    // validate auction 1 is not updated
    let new_auction_1 = db.getAuctionEntry(
      auction_1.pool_id,
      auction_1.user_id,
      auction_1.auction_type
    );
    expect(new_auction_1?.fill_block).toEqual(auction_1.fill_block);
    expect(new_auction_1?.updated).toEqual(auction_1.updated);
    expect(mockedBidderSubmitter.addSubmission).toHaveBeenCalledTimes(0);
  });

  it('should skip an auction if processing throws on ledger event', async () => {
    let ledger = 1000; // nextLedger is 1001
    let auction_1: AuctionEntry = {
      pool_id: 'pool1',
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillerKeypair.publicKey(),
      start_block: ledger - 15,
      fill_block: ledger + 1 + 150,
      updated: ledger - 10,
    };
    let auction_2: AuctionEntry = {
      pool_id: 'pool1',
      user_id: 'backstop',
      auction_type: AuctionType.Interest,
      filler: APP_CONFIG.fillerKeypair.publicKey(),
      start_block: ledger - 240,
      fill_block: ledger + 5,
      updated: ledger - 5,
    };
    db.setAuctionEntry(auction_1);
    db.setAuctionEntry(auction_2);
    mockedSorobanHelper.loadAuction
      .mockRejectedValueOnce(new Error('teapot'))
      .mockResolvedValueOnce(
        new Auction('teapot', AuctionType.Liquidation, {
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
          block: ledger - 1,
        })
      );
    let fill_calc_2: AuctionFill = {
      block: 1002,
      percent: 60,
      lotValue: 1000,
      bidValue: 900,
      requests: [],
    };
    mockedCalcAuctionFill.mockResolvedValue(fill_calc_2);

    const appEvent1: AppEvent = {
      type: EventType.LEDGER,
      ledger,
    } as LedgerEvent;
    await bidderHandler.processEvent(appEvent1);

    // validate auction 1 is not updated (error)
    let new_auction_1 = db.getAuctionEntry(
      auction_1.pool_id,
      auction_1.user_id,
      auction_1.auction_type
    );
    expect(new_auction_1?.fill_block).toEqual(auction_1.fill_block);
    expect(new_auction_1?.updated).toEqual(auction_1.updated);
    expect(logger.error).toHaveBeenCalledTimes(1);

    // validate auction 2 is updated
    let new_auction_2 = db.getAuctionEntry(
      auction_2.pool_id,
      auction_2.user_id,
      auction_2.auction_type
    );
    expect(new_auction_2?.fill_block).toEqual(fill_calc_2.block);
    expect(new_auction_2?.updated).toEqual(ledger);
  });

  it('should delete an auction if unable to find pool config', async () => {
    let ledger = 1000; // nextLedger is 1001
    let auction_1: AuctionEntry = {
      pool_id: 'pool3',
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: Keypair.random().publicKey(),
      start_block: ledger - 150,
      fill_block: ledger + 5,
      updated: ledger - 5,
    };

    db.setAuctionEntry(auction_1);
    mockedSorobanHelper.loadAuction.mockResolvedValueOnce(
      new Auction('teapot', AuctionType.Liquidation, {
        bid: new Map<string, bigint>(),
        lot: new Map<string, bigint>(),
        block: ledger - 1,
      })
    );

    const appEvent1: AppEvent = {
      type: EventType.LEDGER,
      ledger,
    } as LedgerEvent;
    await bidderHandler.processEvent(appEvent1);

    // validate auction 1 is not updated (error)
    let new_auction_1 = db.getAuctionEntry(
      auction_1.pool_id,
      auction_1.user_id,
      auction_1.auction_type
    );
    expect(new_auction_1).toBe(undefined);
  });
});
