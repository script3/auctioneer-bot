import {
  BidderSubmitter,
  BidderSubmissionType,
  AuctionBid,
  FillerUnwind,
} from '../src/bidder_submitter';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from '../src/utils/db';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { inMemoryAuctioneerDb } from './helpers/mocks';
import { logger } from '../src/utils/logger';
import {
  buildFillRequests,
  calculateAuctionValue,
  calculateBlockFillAndPercent,
  scaleAuction,
} from '../src/auction';
import { Keypair } from '@stellar/stellar-sdk';
import { RequestType } from '@blend-capital/blend-sdk';
import { sendSlackNotification } from '../src/utils/slack_notifier';

// Mock dependencies
jest.mock('../src/utils/db');
jest.mock('../src/utils/soroban_helper');
jest.mock('../src/auction');
jest.mock('../src/utils/slack_notifier');
jest.mock('@blend-capital/blend-sdk');
jest.mock('../src/utils/soroban_helper');
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
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
  mockedSorobanHelper.loadAuction.mockResolvedValue({
    bid: new Map<string, bigint>([['USD', BigInt(123)]]),
    lot: new Map<string, bigint>([['USD', BigInt(456)]]),
    block: 500,
  });
  mockedSorobanHelper.submitTransaction.mockResolvedValue({
    ledger: 1000,
    txHash: 'mock-tx-hash',
    latestLedgerCloseTime: 123,
  } as any);
  mockedSorobanHelper.network = {
    rpc: 'test-rpc',
    passphrase: 'test-pass',
    opts: { allowHttp: true },
  };
  mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);

  const mockedSendSlackNotif = sendSlackNotification as jest.MockedFunction<
    typeof sendSlackNotification
  >;
  let mockCalculateBlockFillAndPercent = calculateBlockFillAndPercent as jest.MockedFunction<
    typeof calculateBlockFillAndPercent
  >;
  let mockScaleAuction = scaleAuction as jest.MockedFunction<typeof scaleAuction>;
  let mockBuildFillRequests = buildFillRequests as jest.MockedFunction<typeof buildFillRequests>;
  let mockCalculateAuctionValue = calculateAuctionValue as jest.MockedFunction<
    typeof calculateAuctionValue
  >;
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = inMemoryAuctioneerDb();
    bidderSubmitter = new BidderSubmitter(mockDb);
  });

  it('should submit a bid successfully', async () => {
    mockCalculateBlockFillAndPercent.mockResolvedValue({ fillBlock: 1000, fillPercent: 50 });
    mockScaleAuction.mockReturnValue({
      bid: new Map<string, bigint>([['USD', BigInt(12)]]),
      lot: new Map<string, bigint>([['USD', BigInt(34)]]),
      block: 500,
    });
    mockBuildFillRequests.mockResolvedValue([
      {
        request_type: RequestType.FillUserLiquidationAuction,
        address: '',
        amount: 0n,
      },
    ]);
    mockCalculateAuctionValue.mockResolvedValue({
      bidValue: 123,
      effectiveLiabilities: 456,
      lotValue: 987,
      effectiveCollateral: 654,
    });

    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: {
        name: 'test-filler',
        keypair: Keypair.random(),
        minProfitPct: 0,
        minHealthFactor: 0,
        forceFill: false,
        supportedBid: [],
        supportedLot: [],
      },
      auctionEntry: {
        user_id: 'test-user',
        auction_type: AuctionType.Liquidation,
        filler: 'test-filler',
        start_block: 900,
        fill_block: 1000,
      } as AuctionEntry,
    };

    const result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedSorobanHelper.loadAuction).toHaveBeenCalledWith(
      'test-user',
      AuctionType.Liquidation
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(mockDb.setFilledAuctionEntry).toHaveBeenCalled();
  });

  it('should handle auction already filled', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);
    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: {
        name: 'test-filler',
        keypair: Keypair.random(),
        minProfitPct: 0,
        minHealthFactor: 0,
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
    expect(mockDb.deleteAuctionEntry).toHaveBeenCalledWith('test-user', AuctionType.Liquidation);
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
        minProfitPct: 0,
        minHealthFactor: 0,
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

    expect(mockDb.deleteAuctionEntry).toHaveBeenCalledWith('test-user', AuctionType.Liquidation);
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
        minProfitPct: 0,
        minHealthFactor: 0,
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
