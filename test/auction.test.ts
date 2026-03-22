import {
  Auction,
  AuctionType,
  BackstopToken,
  FixedMath,
  PoolUser,
  PositionsEstimate,
  Request,
} from '@blend-capital/blend-sdk';
import { Keypair, xdr } from '@stellar/stellar-sdk';
import { calculateAuctionFill } from '../src/auction.js';
import { getFillerAvailableBalances, getFillerProfitPct } from '../src/filler.js';
import { PoolConfig } from '../src/utils/config.js';
import { AuctioneerDatabase } from '../src/utils/db.js';
import { SorobanHelper } from '../src/utils/soroban_helper.js';
import {
  AQUA,
  BACKSTOP,
  BACKSTOP_TOKEN,
  EURC,
  inMemoryAuctioneerDb,
  MOCK_LEDGER,
  MOCK_TIMESTAMP,
  mockPool,
  mockPoolOracle,
  USDC,
  XLM,
} from './helpers/mocks.js';
import { expectRelApproxEqual } from './helpers/utils.js';

jest.mock('../src/utils/soroban_helper.js');
jest.mock('../src/filler.js');
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
      interestFillerAddress: 'CDMPO7TQH2CJIOARTKAUY2TNZNXMA3BJ2TP3JYUH7HNUMRAZMYUH4FOB',
      fillerKeypair: Keypair.random(),
    },
  };
});

describe('auctions', () => {
  let poolConfig: PoolConfig;
  const mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let db: AuctioneerDatabase;
  let positionEstimate: PositionsEstimate;

  const mockedGetFilledAvailableBalances = getFillerAvailableBalances as jest.MockedFunction<
    typeof getFillerAvailableBalances
  >;
  const mockedGetFillerProfitPct = getFillerProfitPct as jest.MockedFunction<
    typeof getFillerProfitPct
  >;

  beforeEach(() => {
    jest.resetAllMocks();
    db = inMemoryAuctioneerDb();
    poolConfig = {
      defaultProfitPct: 0.1,
      poolAddress: mockPool.id,
      primaryAsset: USDC,
      minPrimaryCollateral: 100n,
      minHealthFactor: 1.2,
      forceFill: true,
      supportedBid: [],
      supportedLot: [],
    };
    positionEstimate = {
      totalBorrowed: 0,
      totalSupplied: 0,
      // only effective numbers used
      totalEffectiveLiabilities: 0,
      totalEffectiveCollateral: 4750,
      borrowCap: 0,
      borrowLimit: 0,
      netApy: 0,
      supplyApy: 0,
      borrowApy: 0,
    };
    mockPool.metadata.status = 1; // active
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: positionEstimate,
      user: {} as PoolUser,
    });
    mockedSorobanHelper.simLPTokensToUSDC.mockImplementation((number: bigint) => {
      // 0.50 USDC out per LP token in
      return Promise.resolve((number * 5000000n) / 10000000n);
    });
    mockedSorobanHelper.simLPTokensGetUSDCIn.mockImplementation((number: bigint) => {
      // 0.55 USDC in per LP token out
      return Promise.resolve((number * 5500000n) / 10000000n);
    });
  });

  describe('calcAuctionFill', () => {
    // *** Interest Auctions ***
    it('calcs fill for interest auction happy path', async () => {
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(728.01456)]]),
        block: MOCK_LEDGER,
      });

      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[USDC, FixedMath.toFixed(1000)]])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 283);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 260.5722, 0.005);
      expectRelApproxEqual(fill.bidValue, 234.2387, 0.005);

      expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith([USDC], mockedSorobanHelper);
    });

    it('calcs fill for interest auction and delays block to fully fill', async () => {
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(728.01456)]]),
        block: MOCK_LEDGER,
      });

      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[USDC, FixedMath.toFixed(200)]])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 283 + 19);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 260.5722, 0.005);
      expectRelApproxEqual(fill.bidValue, 196.1999, 0.005);
    });

    it('calcs fill for interest auction and delays tell block 400 if no usdc', async () => {
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(728.01456)]]),
        block: MOCK_LEDGER,
      });

      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[USDC, FixedMath.toFixed(0)]])
      );

      poolConfig.forceFill = true;
      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 400);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 260.5722, 0.005);
      expect(fill.bidValue).toEqual(0);

      expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith([USDC], mockedSorobanHelper);
    });

    it('calcs fill for interest auction at next ledger if past target block', async () => {
      let nextLedger = MOCK_LEDGER + 290;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(728.01456)]]),
        block: MOCK_LEDGER,
      });

      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[USDC, FixedMath.toFixed(1000)]])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(nextLedger);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 260.5722, 0.005);
      expectRelApproxEqual(fill.bidValue, 220.2244, 0.005);
    });

    it('calcs fill for interest auction uses db prices when possible', async () => {
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(728.01456)]]),
        block: MOCK_LEDGER,
      });

      db.setPriceEntries([
        {
          asset_id: XLM,
          price: 0.3,
          timestamp: MOCK_TIMESTAMP - 100,
        },
      ]);

      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[USDC, FixedMath.toFixed(1000)]])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 273);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 284.6922, 0.005);
      expectRelApproxEqual(fill.bidValue, 254.2590851, 0.005);
    });

    it('calcs fill for interest auction respects force fill setting', async () => {
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(BACKSTOP, AuctionType.Interest, {
        lot: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(120)],
          [USDC, FixedMath.toFixed(210)],
          [EURC, FixedMath.toFixed(34)],
          [AQUA, FixedMath.toFixed(2500)],
        ]),
        bid: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(2500)]]),
        block: MOCK_LEDGER,
      });

      mockedGetFillerProfitPct.mockReturnValue(0.2);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[USDC, FixedMath.toFixed(1000)]])
      );

      poolConfig.forceFill = true;
      let fill_force = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      poolConfig.forceFill = false;
      let fill_no_force = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 8,
          address: BACKSTOP,
          amount: 100n,
        },
      ];
      expect(fill_force.block).toEqual(MOCK_LEDGER + 350);
      expect(fill_force.percent).toEqual(100);
      expect(fill_force.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill_force.lotValue, 260.5722, 0.005);
      expectRelApproxEqual(fill_force.bidValue, 343.75, 0.005);

      expect(fill_no_force.block).toEqual(MOCK_LEDGER + 370);
      expect(fill_no_force.percent).toEqual(100);
      expect(fill_no_force.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill_no_force.lotValue, 260.5722, 0.005);
      expectRelApproxEqual(fill_no_force.bidValue, 206.25, 0.005);
    });

    // *** Liquidation Auctions ***

    it('calcs fill for liquidation auction', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([
          [USDC, FixedMath.toFixed(15.93)],
          [EURC, FixedMath.toFixed(16.211)],
        ]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(300.21)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[USDC, FixedMath.toFixed(100)]])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 194);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 32.8213, 0.005);
      expectRelApproxEqual(fill.bidValue, 29.73769976, 0.005);

      expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
        [USDC, EURC, XLM],
        mockedSorobanHelper
      );
    });

    it('calcs fill for liquidation auction and repays incoming liabilities and withdraws 0 CF collateral', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([
          [USDC, FixedMath.toFixed(15.93)],
          [EURC, FixedMath.toFixed(16.211)],
          [AQUA, FixedMath.toFixed(750)],
        ]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(300.21)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [USDC, FixedMath.toFixed(100)],
          [XLM, FixedMath.toFixed(500)],
        ])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 100n,
        },
        {
          request_type: 5,
          address: XLM,
          amount: 3003808157n,
        },
        {
          request_type: 3,
          address: AQUA,
          amount: BigInt('9223372036854775807'),
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 191);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 32.7722, 0.005);
      expectRelApproxEqual(fill.bidValue, 29.73769976, 0.005);
    });

    it('calcs fill for liquidation auction no existing positions and repays incoming liabilities and withdraws 0 CF collateral', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([
          [USDC, FixedMath.toFixed(15.93)],
          [EURC, FixedMath.toFixed(16.211)],
          [AQUA, FixedMath.toFixed(750)],
        ]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(300.21)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 0;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [USDC, FixedMath.toFixed(100)],
          [XLM, FixedMath.toFixed(500)],
        ])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 100n,
        },
        {
          request_type: 5,
          address: XLM,
          amount: 3003808157n,
        },
        {
          request_type: 3,
          address: AQUA,
          amount: BigInt('9223372036854775807'),
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 191);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 32.7722, 0.005);
      expectRelApproxEqual(fill.bidValue, 29.73769976, 0.005);
    });

    it('calcs fill for liquidation auction adds primary collateral', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 186;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[XLM, FixedMath.toFixed(100000)]]),
        bid: new Map<string, bigint>([
          [USDC, FixedMath.toFixed(100)],
          [EURC, FixedMath.toFixed(7500)],
        ]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [USDC, FixedMath.toFixed(5000)],
          [XLM, FixedMath.toFixed(500)],
        ])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 100n,
        },
        // repays any incoming primary liabilities first
        {
          request_type: 5,
          address: USDC,
          amount: 101_0182653n,
        },
        // adds additional primary collateral to reach min HF
        {
          request_type: 2,
          address: USDC,
          amount: FixedMath.toFixed(4420),
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 187);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 9257.3115, 0.005);
      expectRelApproxEqual(fill.bidValue, 8378.033243, 0.005);
    });

    it('calcs fill for liquidation auction scales and does not add collateral when pool frozen', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 186;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[XLM, FixedMath.toFixed(100000)]]),
        bid: new Map<string, bigint>([
          [USDC, FixedMath.toFixed(100)],
          [EURC, FixedMath.toFixed(7500)],
        ]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;
      mockPool.metadata.status = 4; // frozen

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [USDC, FixedMath.toFixed(5000)],
          [XLM, FixedMath.toFixed(500)],
        ])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 19n,
        },
        // repays any incoming primary liabilities first
        {
          request_type: 5,
          address: USDC,
          amount: 19_1934786n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 187);
      expect(fill.percent).toEqual(19);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 1758.8892, 0.005);
      expectRelApproxEqual(fill.bidValue, 1591.826316, 0.005);
    });

    it('calcs fill for liquidation auction scales fill percent down', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 188;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[XLM, FixedMath.toFixed(100000)]]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(85000)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(new Map<string, bigint>([]));

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 12n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 188);
      expect(fill.percent).toEqual(12);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 1116.8179, 0.005);
      expectRelApproxEqual(fill.bidValue, 1010.37453, 0.005);
    });

    it('calcs fill for liquidation auction delays fill block if filler not healthy', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 123;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[XLM, FixedMath.toFixed(100000)]]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(85000)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 750;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(new Map<string, bigint>([]));

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 300);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 9900.8679, 0.005);
      expectRelApproxEqual(fill.bidValue, 4209.893874, 0.005);
    });

    it('calcs fill for liquidation auction delays fill block if filler not healthy and pool frozen', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 123;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[XLM, FixedMath.toFixed(100000)]]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(85000)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 750;
      positionEstimate.totalEffectiveCollateral = 1000;
      mockPool.metadata.status = 4; // frozen

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      // can't be used as pool is frozen
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([[USDC, FixedMath.toFixed(5000)]])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 100n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 300);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 9900.8679, 0.005);
      expectRelApproxEqual(fill.bidValue, 4209.893874, 0.005);
    });

    it('calcs fill for liquidation auction with repayment, additional collateral, and scaling minor', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 123;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[XLM, FixedMath.toFixed(100000)]]),
        bid: new Map<string, bigint>([[XLM, FixedMath.toFixed(85000)]]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;
      mockPool.metadata.status = 3; // on-ice, can still supply

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [XLM, FixedMath.toFixed(15000)],
          [USDC, FixedMath.toFixed(4000)],
        ])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 94n,
        },
        {
          request_type: 5,
          address: XLM,
          amount: FixedMath.toFixed(15000),
        },
        {
          request_type: 2,
          address: USDC,
          amount: FixedMath.toFixed(3954),
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 188);
      expect(fill.percent).toEqual(94);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 8748.4069, 0.005);
      expectRelApproxEqual(fill.bidValue, 7914.600483, 0.005);
    });

    it('calcs fill for liquidation auction with repayment, additional collateral, and scaling large', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(user, AuctionType.Liquidation, {
        lot: new Map<string, bigint>([[EURC, FixedMath.toFixed(9100)]]),
        bid: new Map<string, bigint>([
          [USDC, FixedMath.toFixed(500)],
          [XLM, FixedMath.toFixed(85000)],
        ]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 700;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [XLM, FixedMath.toFixed(2000)],
          [USDC, FixedMath.toFixed(600)],
        ])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 6,
          address: user,
          amount: 15n,
        },
        {
          request_type: 5,
          address: USDC,
          amount: 757637015n,
        },
        {
          request_type: 5,
          address: XLM,
          amount: FixedMath.toFixed(2000),
        },
        {
          request_type: 2,
          address: USDC,
          amount: FixedMath.toFixed(495),
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 197);
      expect(fill.percent).toEqual(15);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 1476.3058, 0.005);
      expectRelApproxEqual(fill.bidValue, 1338.709125, 0.005);
    });

    // *** Bad Debt Auctions ***

    it('calcs fill for bad debt auction', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(user, AuctionType.BadDebt, {
        lot: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(4200)]]),
        bid: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(10000)],
          [USDC, FixedMath.toFixed(500)],
        ]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 1000;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [USDC, FixedMath.toFixed(4200)],
          [XLM, FixedMath.toFixed(5000)],
        ])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 7,
          address: user,
          amount: 100n,
        },
        {
          request_type: 5,
          address: XLM,
          amount: FixedMath.toFixed(5000),
        },
        {
          request_type: 5,
          address: USDC,
          amount: 5050912865n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 157);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 1648.5, 0.005);
      expectRelApproxEqual(fill.bidValue, 1495.503014, 0.005);

      expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
        [XLM, USDC],
        mockedSorobanHelper
      );
    });

    it('calcs fill for bad debt auction with no collateral', async () => {
      let user = Keypair.random().publicKey();
      let nextLedger = MOCK_LEDGER + 1;
      let auction = new Auction(user, AuctionType.BadDebt, {
        lot: new Map<string, bigint>([[BACKSTOP_TOKEN, FixedMath.toFixed(4200)]]),
        bid: new Map<string, bigint>([
          [XLM, FixedMath.toFixed(10000)],
          [USDC, FixedMath.toFixed(500)],
        ]),
        block: MOCK_LEDGER,
      });
      positionEstimate.totalEffectiveLiabilities = 0;
      positionEstimate.totalEffectiveCollateral = 0;

      mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
        user: {} as PoolUser,
        estimate: positionEstimate,
      });
      mockedGetFillerProfitPct.mockReturnValue(0.1);
      mockedGetFilledAvailableBalances.mockResolvedValue(
        new Map<string, bigint>([
          [USDC, FixedMath.toFixed(4200)],
          [XLM, FixedMath.toFixed(20000)],
          [EURC, FixedMath.toFixed(10000)],
        ])
      );

      let fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        mockedSorobanHelper,
        db
      );

      let expectedRequests: Request[] = [
        {
          request_type: 7,
          address: user,
          amount: 100n,
        },
        {
          request_type: 5,
          address: XLM,
          amount: 100056895500n,
        },
        {
          request_type: 5,
          address: USDC,
          amount: 5050912865n,
        },
      ];
      expect(fill.block).toEqual(MOCK_LEDGER + 157);
      expect(fill.percent).toEqual(100);
      expect(fill.requests).toEqual(expectedRequests);
      expectRelApproxEqual(fill.lotValue, 1648.5, 0.005);
      expectRelApproxEqual(fill.bidValue, 1495.503014, 0.005);

      expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
        [XLM, USDC],
        mockedSorobanHelper
      );
    });
  });
});
