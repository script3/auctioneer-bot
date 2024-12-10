import { Auction, PoolUser, Positions, Request, RequestType } from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import { AuctionFill, calculateAuctionFill } from '../src/auction';
import {
  AuctionBid,
  BidderSubmissionType,
  BidderSubmitter,
  FillerUnwind,
} from '../src/bidder_submitter';
import { getFillerAvailableBalances, managePositions } from '../src/filler';
import { Filler } from '../src/utils/config';
import { AuctioneerDatabase, AuctionEntry, AuctionType, FilledAuctionEntry } from '../src/utils/db';
import { logger } from '../src/utils/logger';
import { sendSlackNotification } from '../src/utils/slack_notifier';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { inMemoryAuctioneerDb, mockPool, mockPoolOracle } from './helpers/mocks';

// Mock dependencies
jest.mock('../src/utils/db');
jest.mock('../src/utils/soroban_helper');
jest.mock('../src/auction');
jest.mock('../src/utils/slack_notifier');
jest.mock('../src/filler');
jest.mock('../src/utils/soroban_helper');
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 999 }),
      })),
    },
  };
});

jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      rpcURL: 'http://localhost:8000/rpc',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      poolAddress: 'CBP7NO6F7FRDHSOFQBT2L2UWYIZ2PU76JKVRYAQTG3KZSQLYAOKIF2WB',
      backstopAddress: 'CAO3AGAMZVRMHITL36EJ2VZQWKYRPWMQAPDQD5YEOF3GIF7T44U4JAL3',
      backstopTokenAddress: 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM',
      usdcAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      blndAddress: 'CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY',
      keypair: '',
      fillers: [],
    },
  };
});

jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('BidderSubmitter', () => {
  let bidderSubmitter: BidderSubmitter;
  let mockDb: AuctioneerDatabase;
  let mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let mockedSorobanHelperConstructor = SorobanHelper as jest.MockedClass<typeof SorobanHelper>;
  mockedSorobanHelper.network = {
    rpc: 'test-rpc',
    passphrase: 'test-pass',
    opts: { allowHttp: true },
  };
  mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);

  const mockedSendSlackNotif = sendSlackNotification as jest.MockedFunction<
    typeof sendSlackNotification
  >;
  const mockedCalcAuctionFill = calculateAuctionFill as jest.MockedFunction<
    typeof calculateAuctionFill
  >;
  const mockedManagePositions = managePositions as jest.MockedFunction<typeof managePositions>;
  const mockedGetFilledAvailableBalances = getFillerAvailableBalances as jest.MockedFunction<
    typeof getFillerAvailableBalances
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = inMemoryAuctioneerDb();
    bidderSubmitter = new BidderSubmitter(mockDb);
  });

  it('should submit a bid successfully', async () => {
    bidderSubmitter.addSubmission = jest.fn();

    let auction = new Auction(Keypair.random().publicKey(), AuctionType.Liquidation, {
      bid: new Map<string, bigint>([['USD', BigInt(1000)]]),
      lot: new Map<string, bigint>([['USD', BigInt(2000)]]),
      block: 800,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(auction);
    let auction_fill: AuctionFill = {
      percent: 50,
      block: 1000,
      bidValue: 1234,
      lotValue: 2345,
      requests: [
        {
          request_type: RequestType.FillUserLiquidationAuction,
          address: auction.user,
          amount: 50n,
        },
      ],
    };
    mockedCalcAuctionFill.mockResolvedValue(auction_fill);
    let submissionResult: any = {
      ledger: 1000,
      txHash: 'mock-tx-hash',
      latestLedgerCloseTime: Date.now(),
    };
    mockedSorobanHelper.submitTransaction.mockResolvedValue(submissionResult);

    const filler: Filler = {
      name: 'test-filler',
      keypair: Keypair.random(),
      defaultProfitPct: 0,
      minHealthFactor: 0,
      primaryAsset: 'USD',
      minPrimaryCollateral: 0n,
      forceFill: false,
      supportedBid: [],
      supportedLot: [],
    };
    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler,
      auctionEntry: {
        user_id: auction.user,
        auction_type: AuctionType.Liquidation,
        filler: filler.keypair.publicKey(),
        start_block: 900,
        fill_block: 1000,
      } as AuctionEntry,
    };

    const result = await bidderSubmitter.submit(submission);

    const expectedFillEntry: FilledAuctionEntry = {
      tx_hash: 'mock-tx-hash',
      filler: submission.auctionEntry.filler,
      user_id: auction.user,
      auction_type: submission.auctionEntry.auction_type,
      bid: new Map<string, bigint>([['USD', BigInt(500)]]),
      bid_total: auction_fill.bidValue,
      lot: new Map<string, bigint>([['USD', BigInt(1000)]]),
      lot_total: auction_fill.lotValue,
      est_profit: auction_fill.lotValue - auction_fill.bidValue,
      fill_block: submissionResult.ledger,
      timestamp: submissionResult.latestLedgerCloseTime,
    };
    expect(result).toBe(true);
    expect(mockedSorobanHelper.loadAuction).toHaveBeenCalledWith(
      submission.auctionEntry.user_id,
      submission.auctionEntry.auction_type
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(mockDb.setFilledAuctionEntry).toHaveBeenCalledWith(expectedFillEntry);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledWith(
      { type: BidderSubmissionType.UNWIND, filler: submission.filler },
      2
    );
  });

  it('returns true if auction is undefined to return auction entry to handler', async () => {
    bidderSubmitter.addSubmission = jest.fn();
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);
    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: {
        name: 'test-filler',
        keypair: Keypair.random(),
        defaultProfitPct: 0,
        minHealthFactor: 0,
        primaryAsset: 'USD',
        minPrimaryCollateral: 0n,
        forceFill: false,
        supportedBid: [],
        supportedLot: [],
      },
      auctionEntry: {
        user_id: 'test-user',
        auction_type: AuctionType.Liquidation,
      } as AuctionEntry,
    };

    const result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
  });

  it('should manage positions during unwind', async () => {
    const fillerBalance = new Map<string, bigint>([['USD', 123n]]);
    const unwindRequest: Request[] = [
      {
        request_type: RequestType.Repay,
        address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        amount: 123n,
      },
    ];

    bidderSubmitter.addSubmission = jest.fn();
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    mockedSorobanHelper.loadUser.mockResolvedValue(
      new PoolUser('test-user', new Positions(new Map(), new Map(), new Map()), new Map())
    );
    mockedSorobanHelper.loadBalances.mockResolvedValue(fillerBalance);

    mockedManagePositions.mockReturnValue(unwindRequest);

    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      filler: {
        name: 'test-filler',
        keypair: Keypair.random(),
        defaultProfitPct: 0,
        minHealthFactor: 0,
        primaryAsset: 'USD',
        minPrimaryCollateral: 100n,
        forceFill: false,
        supportedBid: ['USD', 'XLM'],
        supportedLot: ['EURC', 'XLM'],
      },
    };
    let result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
      submission.filler,
      ['USD', 'XLM', 'EURC'],
      mockedSorobanHelper
    );
    expect(mockedManagePositions).toHaveBeenCalled();
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledWith(submission, 2);
  });

  it('should stop submitting unwind events when no action is taken', async () => {
    const fillerBalance = new Map<string, bigint>([['USD', 123n]]);
    const unwindRequest: Request[] = [];

    bidderSubmitter.addSubmission = jest.fn();
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    mockedSorobanHelper.loadUser.mockResolvedValue(
      new PoolUser('test-user', new Positions(new Map(), new Map(), new Map()), new Map())
    );
    mockedSorobanHelper.loadBalances.mockResolvedValue(fillerBalance);

    mockedManagePositions.mockReturnValue(unwindRequest);

    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      filler: {
        name: 'test-filler',
        keypair: Keypair.random(),
        defaultProfitPct: 0,
        minHealthFactor: 0,
        primaryAsset: 'USD',
        minPrimaryCollateral: 100n,
        forceFill: false,
        supportedBid: ['USD', 'XLM'],
        supportedLot: ['EURC', 'XLM'],
      },
    };
    let result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
      submission.filler,
      ['USD', 'XLM', 'EURC'],
      mockedSorobanHelper
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalledTimes(0);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledTimes(0);
  });

  it('should return true if auction is in the queue', () => {
    const auctionEntry: AuctionEntry = {
      user_id: 'test-user',
      auction_type: AuctionType.Liquidation,
    } as AuctionEntry;

    bidderSubmitter.addSubmission(
      {
        type: BidderSubmissionType.BID,
        auctionEntry: auctionEntry,
      } as AuctionBid,
      1
    );

    expect(bidderSubmitter.containsAuction(auctionEntry)).toBe(true);
  });

  it('should return false if auction is not in the queue', () => {
    const auctionEntry: AuctionEntry = {
      user_id: 'test-user',
      auction_type: AuctionType.Liquidation,
    } as AuctionEntry;

    bidderSubmitter['submissions'] = [];

    expect(bidderSubmitter.containsAuction(auctionEntry)).toBe(false);
  });

  it('should handle dropped bid', async () => {
    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: {
        name: 'test-filler',
        keypair: Keypair.random(),
        defaultProfitPct: 0,
        minHealthFactor: 0,
        primaryAsset: 'USD',
        minPrimaryCollateral: 0n,
        forceFill: false,
        supportedBid: [],
        supportedLot: [],
      },
      auctionEntry: {
        user_id: 'test-user',
        auction_type: AuctionType.Liquidation,
        start_block: 900,
        fill_block: 1000,
      } as AuctionEntry,
    };

    await bidderSubmitter.onDrop(submission);

    expect(mockDb.deleteAuctionEntry).toHaveBeenCalledTimes(0);
    expect(logger.error).toHaveBeenCalledWith(
      `Dropped auction bid\n` +
        `Type: ${AuctionType[submission.auctionEntry.auction_type]}\n` +
        `User: ${submission.auctionEntry.user_id}\n` +
        `Start Block: ${submission.auctionEntry.start_block}\n` +
        `Fill Block: ${submission.auctionEntry.fill_block}\n` +
        `Filler: ${submission.filler.name}\n`
    );
    expect(mockedSendSlackNotif).toHaveBeenCalledWith(
      `Dropped auction bid\n` +
        `Type: ${AuctionType[submission.auctionEntry.auction_type]}\n` +
        `User: ${submission.auctionEntry.user_id}\n` +
        `Start Block: ${submission.auctionEntry.start_block}\n` +
        `Fill Block: ${submission.auctionEntry.fill_block}\n` +
        `Filler: ${submission.filler.name}\n`
    );
  });

  it('should handle dropped unwind', async () => {
    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      filler: {
        name: 'test-filler',
        keypair: Keypair.random(),
        defaultProfitPct: 0,
        minHealthFactor: 0,
        primaryAsset: 'USD',
        minPrimaryCollateral: 0n,
        forceFill: false,
        supportedBid: [],
        supportedLot: [],
      },
    };

    await bidderSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(
      `Dropped filler unwind\n` + `Filler: ${submission.filler.name}\n`
    );
    expect(mockedSendSlackNotif).toHaveBeenCalledWith(
      `Dropped filler unwind\n` + `Filler: ${submission.filler.name}\n`
    );
  });
});
