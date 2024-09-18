import { Request, RequestType } from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import {
  buildFillRequests,
  calculateAuctionValue,
  calculateBlockFillAndPercent,
  scaleAuction,
} from '../src/auction.js';
import { AuctionBid, BidderSubmissionType } from '../src/bidder_submitter.js';
import { Filler } from '../src/utils/config.js';
import { AuctioneerDatabase, AuctionType } from '../src/utils/db.js';
import { SorobanHelper } from '../src/utils/soroban_helper.js';
import {
  inMemoryAuctioneerDb,
  mockPoolOracle,
  mockPoolUser,
  mockPoolUserEstimate,
  mockedPool,
} from './helpers/mocks.js';

jest.mock('../src/utils/soroban_helper.js', () => {
  return {
    SorobanHelper: jest.fn().mockImplementation(() => {
      return {
        loadPool: jest.fn().mockReturnValue(mockedPool),
        loadUser: jest.fn().mockReturnValue(mockPoolUser),
        loadUserPositionEstimate: jest
          .fn()
          .mockReturnValue({ estimate: mockPoolUserEstimate, user: mockPoolUser }),
        simLPTokenToUSDC: jest.fn().mockImplementation((number: bigint) => {
          return (number * 33333n) / 100000n;
        }),
        loadPoolOracle: jest.fn().mockReturnValue(mockPoolOracle),
      };
    }),
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

describe('calculateBlockFillAndPercent', () => {
  let filler: Filler;
  let sorobanHelper: SorobanHelper;
  let db: AuctioneerDatabase;
  beforeEach(() => {
    sorobanHelper = new SorobanHelper();
    filler = {
      name: 'Tester',
      keypair: Keypair.random(),
      minProfitPct: 0.2,
      minHealthFactor: 1.3,
      forceFill: true,
      supportedBid: [],
      supportedLot: [],
    };
    db = inMemoryAuctioneerDb();
  });

  it('test user liquidation expect fill under 200', async () => {
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 10000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 80000_0000000n],
      ]),
      block: 123,
    };

    let fillCalc = await calculateBlockFillAndPercent(
      filler,
      AuctionType.Liquidation,
      auctionData,
      sorobanHelper,
      db
    );
    expect(fillCalc.fillBlock).toEqual(312);
    expect(fillCalc.fillPercent).toEqual(100);
  });

  it('test user liquidation expect fill over 200', async () => {
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 10000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 90000_0000000n],
      ]),
      block: 123,
    };
    filler.forceFill = false;
    let fillCalc = await calculateBlockFillAndPercent(
      filler,
      AuctionType.Liquidation,
      auctionData,
      sorobanHelper,
      db
    );
    expect(fillCalc.fillBlock).toEqual(343);
    expect(fillCalc.fillPercent).toEqual(100);
  });

  it('test force fill user liquidations sets fill to 198', async () => {
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 10000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 90000_0000000n],
      ]),
      block: 123,
    };
    let fillCalc = await calculateBlockFillAndPercent(
      filler,
      AuctionType.Liquidation,
      auctionData,
      sorobanHelper,
      db
    );
    expect(fillCalc.fillBlock).toEqual(321);
    expect(fillCalc.fillPercent).toEqual(100);
  });

  it('test user liquidation does not exceed min health factor', async () => {
    mockPoolUserEstimate.totalEffectiveLiabilities = 18660;
    sorobanHelper.loadUserPositionEstimate = jest
      .fn()
      .mockReturnValue({ estimate: mockPoolUserEstimate, user: mockPoolUser });

    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 10000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 88000_0000000n],
      ]),
      block: 123,
    };
    filler.forceFill = false;
    let fillCalc = await calculateBlockFillAndPercent(
      filler,
      AuctionType.Liquidation,
      auctionData,
      sorobanHelper,
      db
    );
    expect(fillCalc.fillBlock).toEqual(339);
    expect(fillCalc.fillPercent).toEqual(50);
  });

  it('test interest auction', async () => {
    sorobanHelper.loadUserPositionEstimate = jest
      .fn()
      .mockReturnValue({ estimate: mockPoolUserEstimate, user: mockPoolUser });
    sorobanHelper.simBalance = jest.fn().mockReturnValue(5000_0000000n);
    sorobanHelper.simLPTokenToUSDC = jest.fn().mockImplementation((number) => {
      return (number * 33333n) / 100000n;
    });
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 1000_0000000n],
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 2000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM', 5500_0000000n],
      ]),
      block: 123,
    };

    let fillCalc = await calculateBlockFillAndPercent(
      filler,
      AuctionType.Interest,
      auctionData,
      sorobanHelper,
      db
    );
    expect(fillCalc.fillBlock).toEqual(419);
    expect(fillCalc.fillPercent).toEqual(100);
  });

  it('test force fill for interest auction', async () => {
    sorobanHelper.loadUserPositionEstimate = jest
      .fn()
      .mockReturnValue({ estimate: mockPoolUserEstimate, user: mockPoolUser });
    sorobanHelper.simBalance = jest.fn().mockReturnValue(5000_0000000n);
    sorobanHelper.simLPTokenToUSDC = jest.fn().mockImplementation((number) => {
      return (number * 33333n) / 100000n;
    });
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 1_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM', 5500_0000000n],
      ]),
      block: 123,
    };

    let fillCalc = await calculateBlockFillAndPercent(
      filler,
      AuctionType.Interest,
      auctionData,
      sorobanHelper,
      db
    );
    expect(fillCalc.fillBlock).toEqual(473);
    expect(fillCalc.fillPercent).toEqual(100);
  });
  it('test interest auction increases block fill delay to fully fill', async () => {
    sorobanHelper.simBalance = jest.fn().mockReturnValue(2000_0000000n);

    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 1000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM', 4242_0000000n],
      ]),
      block: 123,
    };
    filler.forceFill = false;
    let fillCalc = await calculateBlockFillAndPercent(
      filler,
      AuctionType.Interest,
      auctionData,
      sorobanHelper,
      db
    );
    expect(fillCalc.fillBlock).toEqual(429);
    expect(fillCalc.fillPercent).toEqual(100);
  });

  it('test bad debt auction', async () => {
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM', 456_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 456_0000000n],
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 123_0000000n],
      ]),
      block: 123,
    };

    let fillCalc = await calculateBlockFillAndPercent(
      filler,
      AuctionType.BadDebt,
      auctionData,
      sorobanHelper,
      db
    );
    expect(fillCalc.fillBlock).toEqual(380);
    expect(fillCalc.fillPercent).toEqual(100);
  });
});

describe('calculateAuctionValue', () => {
  let sorobanHelper = new SorobanHelper();
  let db = inMemoryAuctioneerDb();
  it('test valuing user auction', async () => {
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 1234_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 5678_0000000n],
      ]),
      block: 123,
    };

    let result = await calculateAuctionValue(
      AuctionType.Liquidation,
      auctionData,
      sorobanHelper,
      db
    );
    expect(result.bidValue).toBeCloseTo(562.42);
    expect(result.lotValue).toBeCloseTo(1242.24);
    expect(result.effectiveCollateral).toBeCloseTo(1180.13);
    expect(result.effectiveLiabilities).toBeCloseTo(749.89);
  });

  it('test valuing interest auction', async () => {
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 1234_0000000n],
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 5678_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM', 12345678_0000000n],
      ]),
      block: 123,
    };

    let result = await calculateAuctionValue(AuctionType.Interest, auctionData, sorobanHelper, db);
    expect(result.bidValue).toBeCloseTo(4115184.85);
    expect(result.lotValue).toBeCloseTo(1795.72);
    expect(result.effectiveCollateral).toBeCloseTo(0);
    expect(result.effectiveLiabilities).toBeCloseTo(0);
  });

  it('test valuing bad debt auction', async () => {
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM', 12345678_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 1234_0000000n],
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 5678_0000000n],
      ]),
      block: 123,
    };

    let result = await calculateAuctionValue(AuctionType.BadDebt, auctionData, sorobanHelper, db);
    expect(result.bidValue).toBeCloseTo(1808.6);
    expect(result.lotValue).toBeCloseTo(4115184.85);
    expect(result.effectiveCollateral).toBeCloseTo(0);
    expect(result.effectiveLiabilities).toBeCloseTo(2061.66);
  });
});

describe('buildFillRequests', () => {
  let sorobanHelper = new SorobanHelper();

  it('test interest auction requests', async () => {
    const filler = Keypair.random();
    const user = Keypair.random();
    const auctionBid: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: {
        name: '',
        keypair: filler,
        minProfitPct: 0.2,
        minHealthFactor: 1.2,
        forceFill: false,
        supportedBid: [],
        supportedLot: ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'],
      },
      auctionEntry: {
        user_id: user.publicKey(),
        auction_type: AuctionType.Interest,
        filler: filler.publicKey(),
        start_block: 0,
        fill_block: 0,
        updated: 0,
      },
    };
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV', 10000_0000000n],
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 80000_0000000n],
        ['CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK', 456_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM', 50000_0000000n],
      ]),
      block: 123,
    };
    let requests = await buildFillRequests(auctionBid, auctionData, 100, sorobanHelper);
    let expectRequests: Request[] = [
      {
        request_type: RequestType.FillInterestAuction,
        address: user.publicKey(),
        amount: 100n,
      },
    ];
    expect(requests.length).toEqual(1);
    expect(requests).toEqual(expectRequests);
  });

  it('test bad debt auction requests', async () => {
    const filler = Keypair.random();
    const user = Keypair.random();
    const auctionBid: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: {
        name: '',
        keypair: filler,
        minProfitPct: 0.2,
        minHealthFactor: 1.2,
        forceFill: false,
        supportedBid: [],
        supportedLot: ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'],
      },
      auctionEntry: {
        user_id: user.publicKey(),
        auction_type: AuctionType.BadDebt,
        filler: filler.publicKey(),
        start_block: 0,
        fill_block: 0,
        updated: 0,
      },
    };
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM', 30000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV', 10000_0000000n],
        ['CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK', 456_0000000n],
      ]),
      block: 123,
    };
    sorobanHelper.simBalance = jest.fn().mockImplementation((tokenId: string, userId: string) => {
      if (tokenId === 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK')
        return 500_0000000n;
      else if (tokenId === 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV')
        return 10000_0000000n;
      else return 0;
    });
    let requests = await buildFillRequests(auctionBid, auctionData, 100, sorobanHelper);
    let expectRequests: Request[] = [
      {
        request_type: RequestType.FillBadDebtAuction,
        address: user.publicKey(),
        amount: 100n,
      },
      {
        request_type: RequestType.Repay,
        address: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
        amount: 10000_0000000n,
      },
      {
        request_type: RequestType.Repay,
        address: 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK',
        amount: 500_0000000n,
      },
    ];
    expect(requests.length).toEqual(3);
    expect(requests).toEqual(expectRequests);
  });

  it('test repay xlm does not use full balance', async () => {
    const filler = Keypair.random();
    const user = Keypair.random();
    const auctionBid: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: {
        name: '',
        keypair: filler,
        minProfitPct: 0.2,
        minHealthFactor: 1.2,
        forceFill: false,
        supportedBid: [],
        supportedLot: ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'],
      },
      auctionEntry: {
        user_id: user.publicKey(),
        auction_type: AuctionType.Liquidation,
        filler: filler.publicKey(),
        start_block: 0,
        fill_block: 0,
        updated: 0,
      },
    };
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV', 10000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 80000_0000000n],
        ['CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK', 456_0000000n],
      ]),
      block: 123,
    };
    sorobanHelper.simBalance = jest.fn().mockImplementation((tokenId: string, userId: string) => {
      if (tokenId === 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA')
        return 95000_0000000n;
      else if (tokenId === 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK')
        return 500_0000000n;
      else return 0;
    });
    let requests = await buildFillRequests(auctionBid, auctionData, 100, sorobanHelper);
    let expectRequests: Request[] = [
      {
        request_type: RequestType.FillUserLiquidationAuction,
        address: user.publicKey(),
        amount: 100n,
      },
      {
        request_type: RequestType.Repay,
        address: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
        amount: 95000_0000000n - BigInt(100e7),
      },
      {
        request_type: RequestType.Repay,
        address: 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK',
        amount: 500_0000000n,
      },
      {
        request_type: RequestType.WithdrawCollateral,
        address: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
        amount: 10000_0000000n,
      },
    ];
    expect(requests.length).toEqual(4);
    expect(requests).toEqual(expectRequests);
  });

  it('test requests does not withdraw exisiting supplied position', async () => {
    const filler = Keypair.random();
    const user = Keypair.random();
    const auctionBid: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: {
        name: '',
        keypair: filler,
        minProfitPct: 0.2,
        minHealthFactor: 1.2,
        forceFill: false,
        supportedBid: [],
        supportedLot: ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'],
      },
      auctionEntry: {
        user_id: user.publicKey(),
        auction_type: AuctionType.Liquidation,
        filler: filler.publicKey(),
        start_block: 0,
        fill_block: 0,
        updated: 0,
      },
    };
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 10000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV', 800_0000000n],
      ]),
      block: 123,
    };
    sorobanHelper.simBalance = jest.fn().mockImplementation((tokenId: string, userId: string) => {
      if (tokenId === 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA')
        return 95000_0000000n;
      else if (tokenId === 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK')
        return 500_0000000n;
      else if (tokenId === 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV')
        return 10000_0000000n;
      else return 0n;
    });
    mockPoolUser.positions.collateral.set(
      mockedPool.config.reserveList.indexOf(
        'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
      ),
      1n
    );
    let requests = await buildFillRequests(auctionBid, auctionData, 100, sorobanHelper);
    let expectRequests: Request[] = [
      {
        request_type: RequestType.FillUserLiquidationAuction,
        address: user.publicKey(),
        amount: 100n,
      },
      {
        request_type: RequestType.Repay,
        address: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
        amount: 10000_0000000n,
      },
    ];
    expect(requests.length).toEqual(2);
    expect(requests).toEqual(expectRequests);
  });

  it('test requests does not withdraw below min health factor', async () => {
    const filler = Keypair.random();
    const user = Keypair.random();
    const auctionBid: AuctionBid = {
      type: BidderSubmissionType.BID,
      filler: {
        name: '',
        keypair: filler,
        minProfitPct: 0.2,
        minHealthFactor: 1.2,
        forceFill: false,
        supportedBid: [],
        supportedLot: [],
      },
      auctionEntry: {
        user_id: user.publicKey(),
        auction_type: AuctionType.Liquidation,
        filler: filler.publicKey(),
        start_block: 0,
        fill_block: 0,
        updated: 0,
      },
    };
    mockPoolUserEstimate.totalEffectiveLiabilities = 15660;
    sorobanHelper.loadUserPositionEstimate = jest
      .fn()
      .mockReturnValue({ estimate: mockPoolUserEstimate, user: mockPoolUser });
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV', 8000_0000000n],
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 10_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 70000_0000000n],
      ]),
      block: 123,
    };
    sorobanHelper.simBalance = jest.fn().mockImplementation((tokenId: string, userId: string) => {
      if (tokenId === 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA')
        return 10000_0000000n;
      else if (tokenId === 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK')
        return 500_0000000n;
      else if (tokenId === 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV')
        return 10000_000000n;
    });
    let requests = await buildFillRequests(auctionBid, auctionData, 100, sorobanHelper);
    let expectRequests: Request[] = [
      {
        request_type: RequestType.FillUserLiquidationAuction,
        address: user.publicKey(),
        amount: 100n,
      },
      {
        request_type: RequestType.Repay,
        address: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
        amount: 9900_0000000n,
      },
      {
        request_type: RequestType.WithdrawCollateral,
        address: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
        amount: 10_0000000n,
      },
    ];
    expect(requests.length).toEqual(3);
    expect(requests).toEqual(expectRequests);
  });
});

describe('scaleAuction', () => {
  it('test auction scaling', () => {
    const auctionData = {
      lot: new Map<string, bigint>([
        ['asset2', 1_0000000n],
        ['asset3', 5_0000001n],
      ]),
      bid: new Map<string, bigint>([
        ['asset1', 100_0000000n],
        ['asset2', 200_0000001n],
      ]),
      block: 123,
    };
    let scaledAuction = scaleAuction(auctionData, 123, 100);
    expect(scaledAuction.block).toEqual(123);
    expect(scaledAuction.bid.size).toEqual(2);
    expect(scaledAuction.bid.get('asset1')).toEqual(100_0000000n);
    expect(scaledAuction.bid.get('asset2')).toEqual(200_0000001n);
    expect(scaledAuction.lot.size).toEqual(0);

    // 100 blocks -> 100 percent, validate lot is rounded down
    scaledAuction = scaleAuction(auctionData, 223, 100);
    expect(scaledAuction.block).toEqual(223);
    expect(scaledAuction.bid.size).toEqual(2);
    expect(scaledAuction.bid.get('asset1')).toEqual(100_0000000n);
    expect(scaledAuction.bid.get('asset2')).toEqual(200_0000001n);
    expect(scaledAuction.lot.size).toEqual(2);
    expect(scaledAuction.lot.get('asset2')).toEqual(5000000n);
    expect(scaledAuction.lot.get('asset3')).toEqual(2_5000000n);

    // 100 blocks -> 50 percent, validate bid is rounded up
    scaledAuction = scaleAuction(auctionData, 223, 50);
    expect(scaledAuction.block).toEqual(223);
    expect(scaledAuction.bid.size).toEqual(2);
    expect(scaledAuction.bid.get('asset1')).toEqual(50_0000000n);
    expect(scaledAuction.bid.get('asset2')).toEqual(100_0000001n);
    expect(scaledAuction.lot.size).toEqual(2);
    expect(scaledAuction.lot.get('asset2')).toEqual(2500000n);
    expect(scaledAuction.lot.get('asset3')).toEqual(1_2500000n);

    // 200 blocks -> 100 percent (is same)
    scaledAuction = scaleAuction(auctionData, 323, 100);
    expect(scaledAuction.block).toEqual(323);
    expect(scaledAuction.bid.size).toEqual(2);
    expect(scaledAuction.bid.get('asset1')).toEqual(100_0000000n);
    expect(scaledAuction.bid.get('asset2')).toEqual(200_0000001n);
    expect(scaledAuction.lot.size).toEqual(2);
    expect(scaledAuction.lot.get('asset2')).toEqual(1_0000000n);
    expect(scaledAuction.lot.get('asset3')).toEqual(5_0000001n);

    // 200 blocks -> 75 percent, validate bid is rounded up and lot is rounded down
    scaledAuction = scaleAuction(auctionData, 323, 75);
    expect(scaledAuction.block).toEqual(323);
    expect(scaledAuction.bid.size).toEqual(2);
    expect(scaledAuction.bid.get('asset1')).toEqual(75_0000000n);
    expect(scaledAuction.bid.get('asset2')).toEqual(150_0000001n);
    expect(scaledAuction.lot.size).toEqual(2);
    expect(scaledAuction.lot.get('asset2')).toEqual(7500000n);
    expect(scaledAuction.lot.get('asset3')).toEqual(3_7500000n);

    // 300 blocks -> 100 percent
    scaledAuction = scaleAuction(auctionData, 423, 100);
    expect(scaledAuction.block).toEqual(423);
    expect(scaledAuction.bid.size).toEqual(2);
    expect(scaledAuction.bid.get('asset1')).toEqual(50_0000000n);
    expect(scaledAuction.bid.get('asset2')).toEqual(100_0000001n);
    expect(scaledAuction.lot.size).toEqual(2);
    expect(scaledAuction.lot.get('asset2')).toEqual(1_0000000n);
    expect(scaledAuction.lot.get('asset3')).toEqual(5_0000001n);

    // 400 blocks -> 100 percent
    scaledAuction = scaleAuction(auctionData, 523, 100);
    expect(scaledAuction.block).toEqual(523);
    expect(scaledAuction.bid.size).toEqual(0);
    expect(scaledAuction.lot.size).toEqual(2);
    expect(scaledAuction.lot.get('asset2')).toEqual(1_0000000n);
    expect(scaledAuction.lot.get('asset3')).toEqual(5_0000001n);

    // 500 blocks -> 100 percent (unchanged)
    scaledAuction = scaleAuction(auctionData, 623, 100);
    expect(scaledAuction.block).toEqual(623);
    expect(scaledAuction.bid.size).toEqual(0);
    expect(scaledAuction.lot.size).toEqual(2);
    expect(scaledAuction.lot.get('asset2')).toEqual(1_0000000n);
    expect(scaledAuction.lot.get('asset3')).toEqual(5_0000001n);
  });

  it('test auction scaling with 1 stroop', () => {
    const auctionData = {
      lot: new Map<string, bigint>([['asset2', 1n]]),
      bid: new Map<string, bigint>([['asset1', 1n]]),
      block: 123,
    };
    // 1 blocks -> 10 percent
    let scaledAuction = scaleAuction(auctionData, 124, 10);
    expect(scaledAuction.block).toEqual(124);
    expect(scaledAuction.bid.size).toEqual(1);
    expect(scaledAuction.bid.get('asset1')).toEqual(1n);
    expect(scaledAuction.lot.size).toEqual(0);

    // 399 blocks -> 10 percent
    scaledAuction = scaleAuction(auctionData, 522, 10);
    expect(scaledAuction.block).toEqual(522);
    expect(scaledAuction.bid.size).toEqual(1);
    expect(scaledAuction.bid.get('asset1')).toEqual(1n);
    expect(scaledAuction.lot.size).toEqual(0);

    // 399 blocks -> 100 percent
    scaledAuction = scaleAuction(auctionData, 522, 100);
    expect(scaledAuction.block).toEqual(522);
    expect(scaledAuction.bid.size).toEqual(1);
    expect(scaledAuction.bid.get('asset1')).toEqual(1n);
    expect(scaledAuction.lot.size).toEqual(1);
    expect(scaledAuction.lot.get('asset2')).toEqual(1n);
  });
});
