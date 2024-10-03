import { AuctionData } from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import { calculateBlockFillAndPercent, FillCalculation } from '../src/auction';
import { BidderHandler } from '../src/bidder_handler';
import { AuctionBid, BidderSubmissionType, BidderSubmitter } from '../src/bidder_submitter';
import { AppEvent, EventType, LedgerEvent } from '../src/events';
import { APP_CONFIG, AppConfig } from '../src/utils/config';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from '../src/utils/db';
import { logger } from '../src/utils/logger';
import { sendSlackNotification } from '../src/utils/slack_notifier';
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
    backstopAddress: Keypair.random().publicKey(),
    fillers: [
      {
        name: 'filler1',
        keypair: Keypair.random(),
        minProfitPct: 0.05,
        minHealthFactor: 1.1,
        forceFill: true,
        supportedBid: ['USD', 'BTC', 'LP'],
        supportedLot: ['USD', 'BTC', 'ETH'],
      },
      {
        name: 'filler2',
        keypair: Keypair.random(),
        minProfitPct: 0.08,
        minHealthFactor: 1.1,
        forceFill: true,
        supportedBid: ['USD', 'ETH', 'XLM'],
        supportedLot: ['USD', 'ETH', 'XLM'],
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
jest.mock('../src/utils/slack_notifier');

describe('BidderHandler', () => {
  let bidderHandler: BidderHandler;
  let db: AuctioneerDatabase;
  let mockedBidderSubmitter: jest.Mocked<BidderSubmitter>;
  let mockedSorobanHelper: jest.Mocked<SorobanHelper> =
    new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let mockedCalcBlockAndFillPercent = calculateBlockFillAndPercent as jest.MockedFunction<
    typeof calculateBlockFillAndPercent
  >;
  let mockedSendSlackNotif = sendSlackNotification as jest.MockedFunction<
    typeof sendSlackNotification
  >;

  beforeEach(() => {
    jest.resetAllMocks();
    db = inMemoryAuctioneerDb();
    mockedBidderSubmitter = new BidderSubmitter(db) as jest.Mocked<BidderSubmitter>;
    bidderHandler = new BidderHandler(db, mockedBidderSubmitter, mockedSorobanHelper);
  });

  it('should update new auction entries on ledger event', async () => {
    let ledger = 1000;
    let auction_1: AuctionEntry = {
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: ledger - 15,
      fill_block: ledger + 180,
      updated: ledger - 14,
    };
    let auction_2: AuctionEntry = {
      user_id: 'user2',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[1].keypair.publicKey(),
      start_block: ledger - 1,
      fill_block: 0,
      updated: 0,
    };
    db.setAuctionEntry(auction_1);
    db.setAuctionEntry(auction_2);
    let auction_data: AuctionData = {
      bid: new Map<string, bigint>([['USD', BigInt(123456)]]),
      lot: new Map<string, bigint>([['BTC', BigInt(456)]]),
      block: ledger - 1,
    };
    mockedSorobanHelper.loadAuction.mockResolvedValue(auction_data);
    let fill_calc: FillCalculation = {
      fillBlock: 1200,
      fillPercent: 50,
    };
    mockedCalcBlockAndFillPercent.mockResolvedValue(fill_calc);

    const appEvent: AppEvent = { type: EventType.LEDGER, ledger } as LedgerEvent;
    await bidderHandler.processEvent(appEvent);

    expect(mockedSorobanHelper.loadAuction).toHaveBeenCalledTimes(1);
    // validate auction 2 is updated
    let new_auction_2 = db.getAuctionEntry(auction_2.user_id, auction_2.auction_type);
    expect(new_auction_2).toBeDefined();
    expect(new_auction_2?.user_id).toEqual(auction_2.user_id);
    expect(new_auction_2?.auction_type).toEqual(auction_2.auction_type);
    expect(new_auction_2?.filler).toEqual(auction_2.filler);
    expect(new_auction_2?.start_block).toEqual(auction_2.start_block);
    expect(new_auction_2?.fill_block).toEqual(fill_calc.fillBlock);
    expect(new_auction_2?.updated).toEqual(ledger);
    expect(mockedSendSlackNotif).toHaveBeenCalledTimes(1);

    // validate auction 1 is not updated
    let new_auction_1 = db.getAuctionEntry(auction_1.user_id, auction_1.auction_type);
    expect(new_auction_1?.fill_block).toEqual(auction_1.fill_block);
    expect(new_auction_1?.updated).toEqual(auction_1.updated);
  });

  it('should update auction entries on the 10th block and less than 5 blocks on ledger event', async () => {
    let ledger = 1000; // nextLedger is 1001
    let auction_1: AuctionEntry = {
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: ledger - 15,
      fill_block: ledger + 1 + 150, // to fill in 150 blocks from next ledger
      updated: ledger - 10,
    };
    let auction_2: AuctionEntry = {
      user_id: 'backstop',
      auction_type: AuctionType.Interest,
      filler: APP_CONFIG.fillers[1].keypair.publicKey(),
      start_block: ledger - 240,
      fill_block: ledger + 5,
      updated: ledger - 5,
    };
    db.setAuctionEntry(auction_1);
    db.setAuctionEntry(auction_2);
    let auction_data: AuctionData = {
      bid: new Map<string, bigint>([['USD', BigInt(123456)]]),
      lot: new Map<string, bigint>([['BTC', BigInt(456)]]),
      block: ledger - 1,
    };
    mockedSorobanHelper.loadAuction.mockResolvedValue(auction_data);
    let fill_calc_1: FillCalculation = {
      fillBlock: 1200,
      fillPercent: 50,
    };
    let fill_calc_2: FillCalculation = {
      fillBlock: 1002,
      fillPercent: 60,
    };
    mockedCalcBlockAndFillPercent
      .mockResolvedValueOnce(fill_calc_1)
      .mockResolvedValueOnce(fill_calc_2);

    const appEvent: AppEvent = { type: EventType.LEDGER, ledger } as LedgerEvent;
    await bidderHandler.processEvent(appEvent);

    // validate auction 1 is updated
    let new_auction_1 = db.getAuctionEntry(auction_1.user_id, auction_1.auction_type);
    expect(new_auction_1?.fill_block).toEqual(fill_calc_1.fillBlock);
    expect(new_auction_1?.updated).toEqual(ledger);

    // validate auction 2 is updated
    let new_auction_2 = db.getAuctionEntry(auction_2.user_id, auction_2.auction_type);
    expect(new_auction_2?.fill_block).toEqual(fill_calc_2.fillBlock);
    expect(new_auction_2?.updated).toEqual(ledger);
  });

  it('should place auction on submitter queue if fill block is reached or past on ledger event', async () => {
    let ledger = 1000; // nextLedger is 1001
    let auction_1: AuctionEntry = {
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: ledger - 150,
      fill_block: ledger + 3,
      updated: ledger - 1,
    };
    let auction_2: AuctionEntry = {
      user_id: 'backstop',
      auction_type: AuctionType.Interest,
      filler: APP_CONFIG.fillers[1].keypair.publicKey(),
      start_block: ledger - 240,
      fill_block: ledger - 5,
      updated: ledger - 2,
    };
    db.setAuctionEntry(auction_1);
    db.setAuctionEntry(auction_2);
    let auction_data: AuctionData = {
      bid: new Map<string, bigint>([['USD', BigInt(123456)]]),
      lot: new Map<string, bigint>([['BTC', BigInt(456)]]),
      block: ledger - 1,
    };
    mockedSorobanHelper.loadAuction.mockResolvedValue(auction_data);
    let fill_calc_1: FillCalculation = {
      fillBlock: 1001,
      fillPercent: 50,
    };
    let fill_calc_2: FillCalculation = {
      fillBlock: 995,
      fillPercent: 60,
    };
    mockedCalcBlockAndFillPercent
      .mockResolvedValueOnce(fill_calc_1)
      .mockResolvedValueOnce(fill_calc_2);

    const appEvent: AppEvent = { type: EventType.LEDGER, ledger } as LedgerEvent;
    await bidderHandler.processEvent(appEvent);

    // validate auction 1 is placed on submission queue
    let new_auction_1 = db.getAuctionEntry(auction_1.user_id, auction_1.auction_type);
    expect(new_auction_1?.fill_block).toEqual(fill_calc_1.fillBlock);
    expect(new_auction_1?.updated).toEqual(ledger);

    let submission_1: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: APP_CONFIG.fillers[0],
      auctionEntry: new_auction_1 as AuctionEntry,
    };
    expect(mockedBidderSubmitter.addSubmission).toHaveBeenCalledWith(submission_1, 10);

    // validate auction 2 is placed on submission queue
    let new_auction_2 = db.getAuctionEntry(auction_2.user_id, auction_2.auction_type);
    expect(new_auction_2?.fill_block).toEqual(fill_calc_2.fillBlock);
    expect(new_auction_2?.updated).toEqual(ledger);

    let submission_2: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: APP_CONFIG.fillers[0],
      auctionEntry: new_auction_1 as AuctionEntry,
    };
    expect(mockedBidderSubmitter.addSubmission).toHaveBeenCalledWith(submission_2, 10);
  });

  it('should skip an auction if it is already on the submission queue on ledger event', async () => {
    let ledger = 1000; // nextLedger is 1001
    let auction_1: AuctionEntry = {
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: ledger - 150,
      fill_block: ledger,
      updated: ledger - 1,
    };
    db.setAuctionEntry(auction_1);
    let auction_data: AuctionData = {
      bid: new Map<string, bigint>([['USD', BigInt(123456)]]),
      lot: new Map<string, bigint>([['BTC', BigInt(456)]]),
      block: ledger - 1,
    };
    mockedSorobanHelper.loadAuction.mockResolvedValue(auction_data);
    let fill_calc_1: FillCalculation = {
      fillBlock: 1001,
      fillPercent: 50,
    };
    mockedCalcBlockAndFillPercent.mockResolvedValue(fill_calc_1);
    mockedBidderSubmitter.containsAuction.mockReturnValue(true);

    const appEvent: AppEvent = { type: EventType.LEDGER, ledger } as LedgerEvent;
    await bidderHandler.processEvent(appEvent);

    // validate auction 1 is not updated
    let new_auction_1 = db.getAuctionEntry(auction_1.user_id, auction_1.auction_type);
    expect(new_auction_1?.fill_block).toEqual(auction_1.fill_block);
    expect(new_auction_1?.updated).toEqual(auction_1.updated);
    expect(mockedBidderSubmitter.addSubmission).toHaveBeenCalledTimes(0);
  });

  it('should skip an auction if processing throws on ledger event', async () => {
    let ledger = 1000; // nextLedger is 1001
    let auction_1: AuctionEntry = {
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: ledger - 15,
      fill_block: ledger + 1 + 150,
      updated: ledger - 10,
    };
    let auction_2: AuctionEntry = {
      user_id: 'backstop',
      auction_type: AuctionType.Interest,
      filler: APP_CONFIG.fillers[1].keypair.publicKey(),
      start_block: ledger - 240,
      fill_block: ledger + 5,
      updated: ledger - 5,
    };
    db.setAuctionEntry(auction_1);
    db.setAuctionEntry(auction_2);
    let auction_data: AuctionData = {
      bid: new Map<string, bigint>([['USD', BigInt(123456)]]),
      lot: new Map<string, bigint>([['BTC', BigInt(456)]]),
      block: ledger - 1,
    };
    mockedSorobanHelper.loadAuction
      .mockRejectedValueOnce(new Error('Teapot'))
      .mockResolvedValueOnce(auction_data);
    let fill_calc_2: FillCalculation = {
      fillBlock: 1002,
      fillPercent: 60,
    };
    mockedCalcBlockAndFillPercent.mockResolvedValue(fill_calc_2);

    const appEvent: AppEvent = { type: EventType.LEDGER, ledger } as LedgerEvent;
    await bidderHandler.processEvent(appEvent);

    // validate auction 1 is not updated (error)
    let new_auction_1 = db.getAuctionEntry(auction_1.user_id, auction_1.auction_type);
    expect(new_auction_1?.fill_block).toEqual(auction_1.fill_block);
    expect(new_auction_1?.updated).toEqual(auction_1.updated);
    expect(logger.error).toHaveBeenCalledTimes(1);

    // validate auction 2 is updated
    let new_auction_2 = db.getAuctionEntry(auction_2.user_id, auction_2.auction_type);
    expect(new_auction_2?.fill_block).toEqual(fill_calc_2.fillBlock);
    expect(new_auction_2?.updated).toEqual(ledger);
  });
});
