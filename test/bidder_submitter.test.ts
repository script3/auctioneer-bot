import {
  Auction,
  FixedMath,
  PoolUser,
  Positions,
  Request,
  RequestType,
  ScaledAuction,
} from '@blend-capital/blend-sdk';
import { Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { AuctionFill, calculateAuctionFill } from '../src/auction';
import {
  AuctionBid,
  BidderSubmissionType,
  BidderSubmitter,
  FillerUnwind,
} from '../src/bidder_submitter';
import { getFillerAvailableBalances, managePositions } from '../src/filler';
import { AuctioneerDatabase, AuctionEntry, AuctionType, FilledAuctionEntry } from '../src/utils/db';
import { logger } from '../src/utils/logger';
import { sendNotification } from '../src/utils/notifier';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { inMemoryAuctioneerDb, mockPool, mockPoolOracle } from './helpers/mocks';
import { stringify } from '../src/utils/json';
import { Api } from '@stellar/stellar-sdk/rpc';

// Mock dependencies

jest.mock('../src/utils/db');
jest.mock('../src/utils/soroban_helper');
jest.mock('../src/auction');
jest.mock('../src/utils/notifier');
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

const fillerPubkey = 'GDMDYVZ7CQC2HLP3VONMAXQPGIQDNDQHQWLJZ7YTDGXUM32DVKOQHYGT';
jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      rpcURL: 'http://localhost:8000/rpc',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      backstopTokenAddress: 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM',
      backstopAddress: 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM',
      usdcAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      blndAddress: 'CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY',
      interestFillerAddress: 'CDMPO7TQH2CJIOARTKAUY2TNZNXMA3BJ2TP3JYUH7HNUMRAZMYUH4FOB',
      fillerKeypair: Keypair.fromPublicKey(
        'GDMDYVZ7CQC2HLP3VONMAXQPGIQDNDQHQWLJZ7YTDGXUM32DVKOQHYGT'
      ),
      pools: [
        {
          poolAddress: 'CBP7NO6F7FRDHSOFQBT2L2UWYIZ2PU76JKVRYAQTG3KZSQLYAOKIF2WB', // mockPool.id
          primaryAsset: 'USD',
          minPrimaryCollateral: FixedMath.toFixed(100, 7),
          minHealthFactor: 1.1,
          defaultProfitPct: 0.05,
          forceFill: true,
          supportedBid: ['*'],
          supportedLot: ['*'],
        },
      ],
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

  const mockedSendSlackNotif = sendNotification as jest.MockedFunction<typeof sendNotification>;
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
      bidValue: 1.234,
      lotValue: 2.345,
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

    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      auctionEntry: {
        pool_id: mockPool.id,
        user_id: auction.user,
        auction_type: AuctionType.Liquidation,
        filler: fillerPubkey,
        start_block: 800,
        fill_block: 1000,
      } as AuctionEntry,
    };

    const result = await bidderSubmitter.submit(submission);

    const expectedFillEntry: FilledAuctionEntry = {
      tx_hash: 'mock-tx-hash',
      pool_id: mockPool.id,
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
      mockPool.id,
      submission.auctionEntry.user_id,
      submission.auctionEntry.auction_type
    );
    expect(mockedSorobanHelper.setFeeLevel).toHaveBeenCalledTimes(0);
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(mockDb.setFilledAuctionEntry).toHaveBeenCalledWith(expectedFillEntry);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledWith(
      {
        type: BidderSubmissionType.UNWIND,
        poolId: mockPool.id,
        filledAuction: {
          type: submission.auctionEntry.auction_type,
          user: submission.auctionEntry.user_id,
          scaleBlock: auction_fill.block,
          filled: false,
          fillHash: undefined,
          data: {
            bid: expectedFillEntry.bid,
            lot: expectedFillEntry.lot,
            block: submission.auctionEntry.start_block,
          },
        } as ScaledAuction,
      },
      2
    );
  });

  it('should submit a high includsion fee bid with high profit', async () => {
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
      bidValue: 12.34,
      lotValue: 23.45,
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

    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      auctionEntry: {
        pool_id: mockPool.id,
        user_id: auction.user,
        auction_type: AuctionType.Liquidation,
        filler: fillerPubkey,
        start_block: 800,
        fill_block: 1000,
      } as AuctionEntry,
    };

    const result = await bidderSubmitter.submit(submission);

    const expectedFillEntry: FilledAuctionEntry = {
      tx_hash: 'mock-tx-hash',
      pool_id: mockPool.id,
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
      mockPool.id,
      submission.auctionEntry.user_id,
      submission.auctionEntry.auction_type
    );
    expect(mockedSorobanHelper.setFeeLevel).toHaveBeenCalledWith('high');
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(mockDb.setFilledAuctionEntry).toHaveBeenCalledWith(expectedFillEntry);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledWith(
      {
        type: BidderSubmissionType.UNWIND,
        poolId: mockPool.id,
        filledAuction: {
          type: submission.auctionEntry.auction_type,
          user: submission.auctionEntry.user_id,
          scaleBlock: auction_fill.block,
          filled: false,
          fillHash: undefined,
          data: {
            bid: expectedFillEntry.bid,
            lot: expectedFillEntry.lot,
            block: submission.auctionEntry.start_block,
          },
        } as ScaledAuction,
      },
      2
    );
  });

  it('returns true if auction is undefined to return auction entry to handler', async () => {
    bidderSubmitter.addSubmission = jest.fn();
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);
    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      auctionEntry: {
        pool_id: mockPool.id,
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
    mockedSorobanHelper.submitTransaction.mockResolvedValue({
      ledger: 12345,
      txHash: 'mock-tx-hash',
    } as Api.GetSuccessfulTransactionResponse);
    mockedGetFilledAvailableBalances.mockResolvedValue(fillerBalance);

    mockedManagePositions.mockReturnValue(unwindRequest);

    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      poolId: mockPool.id,
      filledAuction: {
        type: AuctionType.Liquidation,
        user: Keypair.random().publicKey(),
        data: {
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
          block: 0,
        },
        scaleBlock: 0,
        filled: true,
        fillHash: 'hash',
      },
    };
    let result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
      ['USD', ...Array.from(mockPool.reserves.keys())],
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
    mockedGetFilledAvailableBalances.mockResolvedValue(fillerBalance);

    mockedManagePositions.mockReturnValue(unwindRequest);

    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      poolId: mockPool.id,
      filledAuction: {
        type: AuctionType.BadDebt,
        user: Keypair.random().publicKey(),
        data: {
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
          block: 0,
        },
        scaleBlock: 0,
        filled: true,
        fillHash: 'hash',
      },
    };
    let result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
      ['USD', ...Array.from(mockPool.reserves.keys())],
      mockedSorobanHelper
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalledTimes(0);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledTimes(0);
  });

  it('should stop submitting unwind events and send slack notification when liabilities remain', async () => {
    const fillerBalance = new Map<string, bigint>([['USD', 123n]]);
    const unwindRequest: Request[] = [];
    const fillerPositions = new Positions(new Map([[0, 123n]]), new Map([[1, 123n]]), new Map());

    bidderSubmitter.addSubmission = jest.fn();
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    mockedSorobanHelper.loadUser.mockResolvedValue(
      new PoolUser('test-user', fillerPositions, new Map())
    );
    mockedGetFilledAvailableBalances.mockResolvedValue(fillerBalance);

    mockedManagePositions.mockReturnValue(unwindRequest);

    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      poolId: mockPool.id,
      filledAuction: {
        type: AuctionType.Liquidation,
        user: Keypair.random().publicKey(),
        data: {
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
          block: 0,
        },
        scaleBlock: 0,
        filled: true,
        fillHash: 'hash',
      },
    };
    let result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
      ['USD', ...Array.from(mockPool.reserves.keys())],
      mockedSorobanHelper
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalledTimes(0);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledTimes(0);
    expect(mockedSendSlackNotif).toHaveBeenCalledWith(
      `Filler has liabilities that cannot be removed\n` +
        `Filler: ${fillerPubkey}\n` +
        `Pool: ${submission.poolId}\n` +
        `Positions: ${stringify(fillerPositions, 2)}`,
      'high'
    );
  });

  it('should invoke claim for unwind events from interest auctions', async () => {
    bidderSubmitter.addSubmission = jest.fn();
    mockedSorobanHelper.submitTransaction.mockResolvedValue({
      ledger: 12345,
      txHash: 'mock-tx-hash',
      returnValue: nativeToScVal(12345n),
    } as Api.GetSuccessfulTransactionResponse);

    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      poolId: mockPool.id,
      filledAuction: {
        type: AuctionType.Interest,
        user: fillerPubkey,
        data: {
          bid: new Map<string, bigint>([
            ['CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM', BigInt(100e7)],
          ]),
          lot: new Map<string, bigint>([
            ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', BigInt(2000)],
            ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', BigInt(0)],
            [
              'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
              BigInt('500000000000000000000000000000'),
            ],
          ]),
          block: 0,
        },
        scaleBlock: 0,
        filled: true,
        fillHash: 'hash',
      },
    };
    let result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalledWith(
      'AAAAAAAAABgAAAAAAAAAAdj3fnA+hJQ4EZqBTGpty27AbCnU37Tih/nbRkQZZih+AAAABWNsYWltAAAAAAAAAgAAABIAAAAAAAAAANg8Vz8UBaOt+6uawF4PMiA2jgeFlpz/ExmvRm9Dqp0DAAAAEAAAAAEAAAADAAAAEgAAAAEltPzYWa7C+mNIQ4xImzw8EMmLbSG+T9PLMMtolT75dwAAABIAAAABre/OWa7lKWj3YGHUlMJSW3Vln6QpamX0me8p5WR35JYAAAASAAAAAean2et1IwBqRpqnSDrREHJHRDwNguYnY95nCEjE6XyQAAAAAA==',
      Keypair.fromPublicKey(fillerPubkey)
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalledTimes(1);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledTimes(0);
  });

  it('should return true if auction is in the queue', () => {
    const auctionEntry: AuctionEntry = {
      pool_id: mockPool.id,
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
      pool_id: mockPool.id,
      user_id: 'test-user',
      auction_type: AuctionType.Liquidation,
    } as AuctionEntry;

    bidderSubmitter['submissions'] = [];

    expect(bidderSubmitter.containsAuction(auctionEntry)).toBe(false);
  });

  it('should handle dropped bid', async () => {
    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      auctionEntry: {
        user_id: 'test-user',
        pool_id: mockPool.id,
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
        `Pool: ${mockPool.id}\n` +
        `User: ${submission.auctionEntry.user_id}\n` +
        `Start Block: ${submission.auctionEntry.start_block}\n` +
        `Fill Block: ${submission.auctionEntry.fill_block}\n` +
        `Filler: ${fillerPubkey}\n`
    );
    expect(mockedSendSlackNotif).toHaveBeenCalledWith(
      `Dropped auction bid\n` +
        `Type: ${AuctionType[submission.auctionEntry.auction_type]}\n` +
        `Pool: ${mockPool.id}\n` +
        `User: ${submission.auctionEntry.user_id}\n` +
        `Start Block: ${submission.auctionEntry.start_block}\n` +
        `Fill Block: ${submission.auctionEntry.fill_block}\n` +
        `Filler: ${fillerPubkey}\n`,
      'high'
    );
  });

  it('should handle dropped unwind', async () => {
    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      poolId: mockPool.id,
      filledAuction: {
        type: AuctionType.Liquidation,
        user: fillerPubkey,
        data: {
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
          block: 0,
        },
        scaleBlock: 0,
        filled: true,
        fillHash: 'hash',
      },
    };

    await bidderSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(
      `Dropped filler unwind\n` + `Filler: ${fillerPubkey}\n` + `Pool: ${mockPool.id}`
    );
    expect(mockedSendSlackNotif).toHaveBeenCalledWith(
      `Dropped filler unwind\n` + `Filler: ${fillerPubkey}\n` + `Pool: ${mockPool.id}`,
      'high'
    );
  });
});
