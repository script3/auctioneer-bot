import {
  AuctionData,
  BlendContractType,
  FixedMath,
  PoolEventType,
  PoolUser,
  Positions,
  PositionsEstimate,
} from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import { EventType, PoolEventEvent } from '../src/events.js';
import { PoolEventHandler } from '../src/pool_event_handler.js';
import { updateUser } from '../src/user.js';
import { APP_CONFIG, AppConfig } from '../src/utils/config.js';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from '../src/utils/db.js';
import { logger } from '../src/utils/logger.js';
import { deadletterEvent, sendEvent } from '../src/utils/messages.js';
import { SorobanHelper } from '../src/utils/soroban_helper.js';
import { inMemoryAuctioneerDb, mockPool } from './helpers/mocks.js';

jest.mock('../src/user.js');
jest.mock('../src/utils/soroban_helper.js');
jest.mock('../src/utils/notifier');
jest.mock('../src/utils/messages');
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
    pools: ['mockPoolId'],
    fillers: [
      {
        name: 'filler1',
        keypair: Keypair.random(),
        defaultProfitPct: 0.05,
        supportedPools: [
          {
            poolAddress: 'mockPoolId',
            minPrimaryCollateral: FixedMath.toFixed(100, 7),
            primaryAsset: 'USD',
            minHealthFactor: 1.1,
            forceFill: true,
          },
        ],
        supportedBid: ['USD', 'BTC', 'LP'],
        supportedLot: ['USD', 'BTC', 'ETH'],
      },
      {
        name: 'filler2',
        keypair: Keypair.random(),
        defaultProfitPct: 0.08,

        supportedPools: [
          {
            poolAddress: 'mockPoolId',
            minPrimaryCollateral: FixedMath.toFixed(100, 7),
            primaryAsset: 'USD',
            minHealthFactor: 1.1,
            forceFill: true,
          },
        ],
        supportedBid: ['USD', 'ETH', 'XLM'],
        supportedLot: ['USD', 'ETH', 'XLM'],
      },
    ],
  } as AppConfig;
  return {
    APP_CONFIG: config,
  };
});

describe('poolEventHandler', () => {
  let db: AuctioneerDatabase;
  let poolEventHandler: PoolEventHandler;
  let mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let mockedUpdateUser = updateUser as jest.MockedFunction<typeof updateUser>;
  let mockedSendEvent = sendEvent as jest.MockedFunction<typeof sendEvent>;
  let mockedAppConfig = APP_CONFIG as jest.Mocked<AppConfig>;
  let pool_user: string;
  let estimate: PositionsEstimate;
  let user: PoolUser;

  const mockedWorkerProcess = { name: 'worker' } as any;
  beforeEach(() => {
    jest.clearAllMocks();
    db = inMemoryAuctioneerDb();
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    poolEventHandler = new PoolEventHandler(db, mockedSorobanHelper, mockedWorkerProcess);
    const fixedTimestamp = 1609459200000;
    Date.now = jest.fn(() => fixedTimestamp);
    pool_user = Keypair.random().publicKey();
    estimate = {
      totalEffectiveCollateral: 2000,
      totalEffectiveLiabilities: 1000,
    } as PositionsEstimate;
    user = new PoolUser(
      pool_user,
      new Positions(
        new Map([
          [0, BigInt(12345)],
          [1, BigInt(54321)],
        ]),
        new Map([[3, BigInt(789)]]),
        new Map()
      ),
      new Map()
    );
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: estimate,
      user,
    });

    mockedAppConfig;
  });

  it('should process event successfully without retries', async () => {
    const poolEvent: PoolEventEvent = {
      timestamp: 999,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12350,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.NewAuction,
        auctionType: AuctionType.Interest,
        auctionData: {
          block: 12345,
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
        },
        user: APP_CONFIG.backstopAddress,
        percent: 100,
      },
    };
    await poolEventHandler.processEventWithRetryAndDeadLetter(poolEvent);
    expect(logger.info).toHaveBeenCalledWith(`Successfully processed event. ${poolEvent.event.id}`);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should retry processing event and succeed', async () => {
    const poolEvent: PoolEventEvent = {
      timestamp: 999,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12350,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.NewAuction,
        auctionType: AuctionType.Interest,
        auctionData: {
          block: 12345,
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
        },
        user: APP_CONFIG.backstopAddress,
        percent: 100,
      },
    };
    let error = new Error('Temporary error');
    mockedSorobanHelper.loadPool.mockRejectedValueOnce(error).mockResolvedValue(mockPool);
    await poolEventHandler.processEventWithRetryAndDeadLetter(poolEvent);

    expect(mockedSorobanHelper.loadPool).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      `Error processing event. ${poolEvent.event.id}.`,
      error
    );
    expect(logger.info).toHaveBeenCalledWith(`Successfully processed event. ${poolEvent.event.id}`);
  });

  it('should send event to dead letter queue after max retries', async () => {
    const poolEvent: PoolEventEvent = {
      timestamp: 999,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12350,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.NewAuction,
        auctionType: AuctionType.Interest,
        auctionData: {
          block: 12345,
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
        },
        user: APP_CONFIG.backstopAddress,
        percent: 100,
      },
    };
    mockedSorobanHelper.loadPool.mockRejectedValue(new Error('Permanent error'));
    await poolEventHandler.processEventWithRetryAndDeadLetter(poolEvent);

    expect(mockedSorobanHelper.loadPool).toHaveBeenCalledTimes(2);
    expect(deadletterEvent).toHaveBeenCalledWith(poolEvent);
  });

  it('should log error if deadLetterEvent fails after max retries', async () => {
    const poolEvent: PoolEventEvent = {
      timestamp: 999,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12350,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.NewAuction,
        auctionType: AuctionType.Interest,
        auctionData: {
          block: 12345,
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
        },
        user: APP_CONFIG.backstopAddress,
        percent: 100,
      },
    };

    let error = new Error('Permanent error');
    mockedSorobanHelper.loadPool.mockRejectedValue(error);
    let mocked_error = new Error('Mocked error');
    const mockDeadLetterEvent = deadletterEvent as jest.MockedFunction<typeof deadletterEvent>;
    mockDeadLetterEvent.mockRejectedValue(mocked_error);

    await poolEventHandler.processEventWithRetryAndDeadLetter(poolEvent);

    expect(mockedSorobanHelper.loadPool).toHaveBeenCalledTimes(2);
    expect(deadletterEvent).toHaveBeenCalledWith(poolEvent);
    expect(logger.error).toHaveBeenNthCalledWith(
      1,
      `Error sending event to dead letter queue.`,
      mocked_error
    );
  });

  it('updates user data for supply collateral event', async () => {
    let ledger = 12345;
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.SupplyCollateral,
        assetId: mockPool.metadata.reserveList[0],
        from: pool_user,
        amount: BigInt(1000),
        bTokensMinted: BigInt(900),
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    expect(mockedUpdateUser).toHaveBeenCalledWith(db, mockPool, user, estimate, ledger);
  });

  it('updates user data for withdraw collateral event', async () => {
    let ledger = 12345;
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.WithdrawCollateral,
        assetId: mockPool.metadata.reserveList[0],
        from: pool_user,
        amount: BigInt(1000),
        bTokensBurned: BigInt(900),
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    expect(mockedUpdateUser).toHaveBeenCalledWith(db, mockPool, user, estimate, ledger);
  });

  it('updates user data for borrow event', async () => {
    let ledger = 12345;
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.Borrow,
        assetId: mockPool.metadata.reserveList[0],
        from: pool_user,
        amount: BigInt(1000),
        dTokensMinted: BigInt(900),
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    expect(mockedUpdateUser).toHaveBeenCalledWith(db, mockPool, user, estimate, ledger);
  });

  it('updates user data for repay event', async () => {
    let ledger = 12345;
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.Repay,
        assetId: mockPool.metadata.reserveList[0],
        from: pool_user,
        amount: BigInt(1000),
        dTokensBurned: BigInt(900),
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    expect(mockedUpdateUser).toHaveBeenCalledWith(db, mockPool, user, estimate, ledger);
  });

  it('finds filler and tracks auction for new liquidation event', async () => {
    let user = Keypair.random().publicKey();
    let ledger = 12345;
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.NewAuction,
        auctionData: {
          bid: new Map<string, bigint>([['ETH', BigInt(123)]]),
          lot: new Map<string, bigint>([['XLM', BigInt(456)]]),
          block: 500,
        },
        user: user,
        auctionType: AuctionType.Liquidation,
        percent: 100,
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    let auctionEntry = db.getAuctionEntry('mockPoolId', user, AuctionType.Liquidation);
    if (auctionEntry === undefined) {
      fail('Auction entry not inserted');
    }
    expect(auctionEntry.user_id).toEqual(user);
    expect(auctionEntry.auction_type).toEqual(AuctionType.Liquidation);
    expect(auctionEntry.filler).toEqual(APP_CONFIG.fillers[1].keypair.publicKey());
    expect(auctionEntry.start_block).toEqual(500);
    expect(auctionEntry.fill_block).toEqual(0);
    expect(auctionEntry.updated).toEqual(ledger);
  });

  it('finds filler and tracks auction for new interest auction event', async () => {
    let ledger = 12345;
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.NewAuction,
        auctionData: {
          bid: new Map<string, bigint>([['LP', BigInt(123)]]),
          lot: new Map<string, bigint>([['USD', BigInt(456)]]),
          block: 500,
        },
        auctionType: AuctionType.Interest,
        user: APP_CONFIG.backstopAddress,
        percent: 100,
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    let auctionEntry = db.getAuctionEntry(
      'mockPoolId',
      APP_CONFIG.backstopAddress,
      AuctionType.Interest
    );
    if (auctionEntry === undefined) {
      fail('Auction entry not inserted');
    }
    expect(auctionEntry.user_id).toEqual(APP_CONFIG.backstopAddress);
    expect(auctionEntry.auction_type).toEqual(AuctionType.Interest);
    expect(auctionEntry.filler).toEqual(APP_CONFIG.fillers[0].keypair.publicKey());
    expect(auctionEntry.start_block).toEqual(500);
    expect(auctionEntry.fill_block).toEqual(0);
    expect(auctionEntry.updated).toEqual(ledger);
  });

  it('finds filler and tracks auction for new bad debt auction event', async () => {
    let ledger = 12345;
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.NewAuction,
        auctionData: {
          bid: new Map<string, bigint>([['USD', BigInt(123)]]),
          lot: new Map<string, bigint>([['USD', BigInt(456)]]),
          block: 500,
        },
        auctionType: AuctionType.BadDebt,
        user: APP_CONFIG.backstopAddress,
        percent: 100,
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    let auctionEntry = db.getAuctionEntry(
      'mockPoolId',
      APP_CONFIG.backstopAddress,
      AuctionType.BadDebt
    );
    if (auctionEntry === undefined) {
      fail('Auction entry not inserted');
    }
    expect(auctionEntry.user_id).toEqual(APP_CONFIG.backstopAddress);
    expect(auctionEntry.auction_type).toEqual(AuctionType.BadDebt);
    // prioritize the first filler
    expect(auctionEntry.filler).toEqual(APP_CONFIG.fillers[0].keypair.publicKey());
    expect(auctionEntry.start_block).toEqual(500);
    expect(auctionEntry.fill_block).toEqual(0);
    expect(auctionEntry.updated).toEqual(ledger);
  });

  it('ignores new auction event if no eligible filler is found', async () => {
    let user = Keypair.random().publicKey();
    let ledger = 12345;
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.NewAuction,
        auctionData: {
          bid: new Map<string, bigint>([['ETH', BigInt(123)]]),
          lot: new Map<string, bigint>([['BTC', BigInt(456)]]),
          block: 500,
        },
        user: user,
        auctionType: AuctionType.Liquidation,
        percent: 100,
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    let auctionEntries = db.getAllAuctionEntries();
    expect(auctionEntries.length).toEqual(0);
  });

  it('deletes ongoing auction for delete liquidation auction event', async () => {
    let other_user = Keypair.random().publicKey();
    let user = Keypair.random().publicKey();
    let auction: AuctionEntry = {
      pool_id: 'mockPoolId',
      user_id: other_user,
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: 500,
      fill_block: 650,
      updated: 12345,
    };
    let auction_to_be_deleted: AuctionEntry = {
      pool_id: 'mockPoolId',
      user_id: user,
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: 600,
      fill_block: 800,
      updated: 12344,
    };
    db.setAuctionEntry(auction);
    db.setAuctionEntry(auction_to_be_deleted);

    let preEventEntries = db.getAllAuctionEntries();
    expect(preEventEntries.length).toEqual(2);

    let ledger = 12345;
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.DeleteLiquidationAuction,
        user: user,
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    let auctionEntries = db.getAllAuctionEntries();
    expect(auctionEntries.length).toEqual(1);
    let deletedAuction = db.getAuctionEntry('mockPoolId', user, AuctionType.Liquidation);
    expect(deletedAuction).toBeUndefined();
  });

  it('deletes fill auction and updates user safely for liquidation fill auction event', async () => {
    let other_user = Keypair.random().publicKey();
    let other_auction: AuctionEntry = {
      pool_id: 'mockPoolId',
      user_id: other_user,
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: 700,
      fill_block: 850,
      updated: 12345,
    };
    let auction_to_be_filled: AuctionEntry = {
      pool_id: 'mockPoolId',
      user_id: pool_user,
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: 600,
      fill_block: 800,
      updated: 12344,
    };
    db.setAuctionEntry(other_auction);
    db.setAuctionEntry(auction_to_be_filled);

    let preEventEntries = db.getAllAuctionEntries();
    expect(preEventEntries.length).toEqual(2);

    let poolEventPartial: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12345,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.FillAuction,
        user: pool_user,
        auctionType: AuctionType.Liquidation,
        fillAmount: BigInt(99),
        filler: Keypair.random().publicKey(),
        filledAuctionData: new AuctionData(new Map(), 1, new Map()),
      },
    };

    await poolEventHandler.handlePoolEvent(poolEventPartial);

    let partialEntries = db.getAllAuctionEntries();
    expect(partialEntries.length).toEqual(2);

    let poolEventFull: PoolEventEvent = {
      timestamp: 999,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12350,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.FillAuction,
        user: pool_user,
        auctionType: AuctionType.Liquidation,
        fillAmount: BigInt(100),
        filler: Keypair.random().publicKey(),
        filledAuctionData: new AuctionData(new Map(), 1, new Map()),
      },
    };

    await poolEventHandler.handlePoolEvent(poolEventFull);

    let entries = db.getAllAuctionEntries();
    expect(entries.length).toEqual(1);
    let deletedAuction = db.getAuctionEntry('mockPoolId', pool_user, AuctionType.Liquidation);
    expect(deletedAuction).toBeUndefined();
    expect(mockedUpdateUser).toHaveBeenCalledWith(db, mockPool, user, estimate, 12350);
  });

  it('deletes fill auction for other fill auction event', async () => {
    let other_user = Keypair.random().publicKey();
    let other_auction: AuctionEntry = {
      pool_id: 'mockPoolId',
      user_id: other_user,
      auction_type: AuctionType.Liquidation,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: 700,
      fill_block: 850,
      updated: 12345,
    };
    let auction_to_be_filled: AuctionEntry = {
      pool_id: 'mockPoolId',
      user_id: APP_CONFIG.backstopAddress,
      auction_type: AuctionType.Interest,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: 600,
      fill_block: 800,
      updated: 12344,
    };
    db.setAuctionEntry(other_auction);
    db.setAuctionEntry(auction_to_be_filled);

    let preEventEntries = db.getAllAuctionEntries();
    expect(preEventEntries.length).toEqual(2);

    let poolEventFull: PoolEventEvent = {
      timestamp: 999,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12350,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.FillAuction,
        user: APP_CONFIG.backstopAddress,
        auctionType: AuctionType.Interest,
        fillAmount: BigInt(100),
        filler: Keypair.random().publicKey(),
        filledAuctionData: new AuctionData(new Map(), 1, new Map()),
      },
    };

    await poolEventHandler.handlePoolEvent(poolEventFull);

    let entries = db.getAllAuctionEntries();
    expect(entries.length).toEqual(1);
    let deletedAuction = db.getAuctionEntry(
      'mockPoolId',
      APP_CONFIG.backstopAddress,
      AuctionType.Interest
    );
    expect(deletedAuction).toBeUndefined();
    expect(mockedUpdateUser).toHaveBeenCalledTimes(0);
  });

  it('should log an error for unhandled event types', async () => {
    let poolEvent: PoolEventEvent = {
      timestamp: 999,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12350,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: 'UNHANDLED_EVENT_TYPE' as any, // This is an unhandled event type
        user: APP_CONFIG.backstopAddress,
        auctionType: AuctionType.Interest,
        fillAmount: BigInt(100),
        from: Keypair.random().publicKey(),
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    expect(logger.error).toHaveBeenCalledWith('Unhandled event type: UNHANDLED_EVENT_TYPE');
  });

  it('Sends check user event for backstop on bad debt fills', async () => {
    let auction_to_be_filled: AuctionEntry = {
      pool_id: 'mockPoolId',
      user_id: APP_CONFIG.backstopAddress,
      auction_type: AuctionType.BadDebt,
      filler: APP_CONFIG.fillers[0].keypair.publicKey(),
      start_block: 600,
      fill_block: 800,
      updated: 12344,
    };
    db.setAuctionEntry(auction_to_be_filled);

    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12345,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.FillAuction,
        user: APP_CONFIG.backstopAddress,
        auctionType: AuctionType.BadDebt,
        fillAmount: BigInt(100),
        filler: Keypair.random().publicKey(),
        filledAuctionData: new AuctionData(new Map(), 1, new Map()),
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    expect(mockedSendEvent).toHaveBeenCalledWith(mockedWorkerProcess, {
      type: EventType.CHECK_USER,
      timestamp: Date.now(),
      poolId: 'mockPoolId',
      userId: APP_CONFIG.backstopAddress,
    });
  });

  it('Sends check user event for backstop on bad debt transfers', async () => {
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'mockPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12345,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.BadDebt,
        user: APP_CONFIG.backstopAddress,
        dTokens: BigInt(1234),
        assetId: 'USD',
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    expect(mockedSendEvent).toHaveBeenCalledWith(mockedWorkerProcess, {
      type: EventType.CHECK_USER,
      timestamp: Date.now(),
      poolId: 'mockPoolId',
      userId: APP_CONFIG.backstopAddress,
    });
  });

  it('Short circuits when pool id is not found in config pools', async () => {
    let poolEvent: PoolEventEvent = {
      timestamp: 777,
      type: EventType.POOL_EVENT,
      event: {
        id: '1',
        contractId: 'unknownPoolId',
        contractType: BlendContractType.Pool,
        ledger: 12345,
        ledgerClosedAt: '2021-10-01T00:00:00Z',
        txHash: '0x123',
        eventType: PoolEventType.BadDebt,
        user: APP_CONFIG.backstopAddress,
        dTokens: BigInt(1234),
        assetId: 'USD',
      },
    };

    await poolEventHandler.handlePoolEvent(poolEvent);

    expect(logger.error).toHaveBeenCalled();
    expect(mockedSorobanHelper.loadPool).not.toHaveBeenCalled();
  });
});
