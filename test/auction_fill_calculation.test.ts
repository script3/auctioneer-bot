import { AuctionType } from '../src/utils/db.js';
import { Keypair } from '@stellar/stellar-sdk';
import { SorobanHelper } from '../src/utils/soroban_helper.js';
import { calculateBlockFillAndPercent } from '../src/auction.js';
import { mockedFillerState, mockedPool } from './helpers/mocks.js';
import { Filler } from '../src/utils/config.js';
jest.mock('../src/utils/soroban_helper.js', () => {
  return {
    SorobanHelper: jest.fn().mockImplementation(() => {
      return {
        loadPool: jest.fn().mockReturnValue(mockedPool),
        loadUser: jest.fn().mockReturnValue(mockedFillerState),
        simLPTokenToUSDC: jest.fn().mockImplementation((number) => {
          return number * 5;
        }),
      };
    }),
  };
});

jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      rpcURL: 'http://localhost:8000/rpc',
      networkPassphrase: 'Test SDF Network ; September 2015',
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
  let sorobanHelper = new SorobanHelper();
  let filler: Filler = {
    name: 'Tester',
    keypair: Keypair.random(),
    minProfitPct: 0.2,
    minHealthFactor: 1.3,
    forceFill: true,
    supportedBid: [],
    supportedLot: [],
  };
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
      sorobanHelper
    );
    expect(fillCalc.fillBlock).toEqual(189);
    expect(fillCalc.fillPercent).toEqual(100);
  });

  it('test user liquidation expect fill under 200', async () => {
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
      sorobanHelper
    );
    expect(fillCalc.fillBlock).toEqual(220);
    expect(fillCalc.fillPercent).toEqual(100);
  });

  it('test user liquidation does not exceed min health factor', async () => {
    mockedFillerState.positionEstimates.totalEffectiveLiabilities = 18660;
    sorobanHelper.loadUser = jest.fn().mockReturnValue(mockedFillerState);

    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 10000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', 88000_0000000n],
      ]),
      block: 123,
    };

    let fillCalc = await calculateBlockFillAndPercent(
      filler,
      AuctionType.Liquidation,
      auctionData,
      sorobanHelper
    );
    expect(fillCalc.fillBlock).toEqual(216);
    expect(fillCalc.fillPercent).toEqual(50);
  });

  it('test interest auction', async () => {
    sorobanHelper.loadUser = jest.fn().mockReturnValue(mockedFillerState);
    sorobanHelper.simBalance = jest.fn().mockReturnValue(5000_0000000);
    sorobanHelper.simLPTokenToUSDC = jest.fn().mockImplementation((number) => {
      return (number / 1e7) * 0.33;
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
      sorobanHelper
    );
    expect(fillCalc.fillBlock).toEqual(295);
    expect(fillCalc.fillPercent).toEqual(100);
  });

  it('test interest auction fully fills', async () => {
    let filler: Filler = {
      name: 'Tester',
      keypair: Keypair.random(),
      minProfitPct: 0.2,
      minHealthFactor: 1.3,
      forceFill: true,
      supportedBid: [
        'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
        'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      ],
      supportedLot: [
        'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
        'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      ],
    };
    sorobanHelper.loadUser = jest.fn().mockReturnValue(mockedFillerState);
    sorobanHelper.simBalance = jest.fn().mockReturnValue(2000_0000000);
    sorobanHelper.simLPTokenToUSDC = jest.fn().mockImplementation((number) => {
      return (number / 1e7) * 0.33;
    });
    let auctionData = {
      lot: new Map<string, bigint>([
        ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 1000_0000000n],
      ]),
      bid: new Map<string, bigint>([
        ['CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM', 4242_0000000n],
      ]),
      block: 123,
    };

    let fillCalc = await calculateBlockFillAndPercent(
      filler,
      AuctionType.Interest,
      auctionData,
      sorobanHelper
    );
    expect(fillCalc.fillBlock).toEqual(306);
    expect(fillCalc.fillPercent).toEqual(100);
  });

  it('test bad debt auction', async () => {
    let filler: Filler = {
      name: 'Tester',
      keypair: Keypair.random(),
      minProfitPct: 0.2,
      minHealthFactor: 1.3,
      forceFill: true,
      supportedBid: [
        'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
        'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      ],
      supportedLot: [
        'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
        'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      ],
    };
    sorobanHelper.loadUser = jest.fn().mockReturnValue(mockedFillerState);
    sorobanHelper.simBalance = jest.fn().mockReturnValue(2000_0000000);
    sorobanHelper.simLPTokenToUSDC = jest.fn().mockImplementation((number) => {
      return (number / 1e7) * 0.33;
    });
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
      AuctionType.Interest,
      auctionData,
      sorobanHelper
    );
    expect(fillCalc.fillBlock).toEqual(258);
    expect(fillCalc.fillPercent).toEqual(100);
  });
});
