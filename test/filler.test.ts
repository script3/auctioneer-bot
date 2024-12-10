import {
  AuctionData,
  FixedMath,
  PoolOracle,
  Positions,
  PriceData,
  Request,
  RequestType,
} from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import { canFillerBid, getFillerProfitPct, managePositions } from '../src/filler';
import { AuctionProfit, Filler } from '../src/utils/config';
import { mockPool } from './helpers/mocks';

jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
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

describe('filler', () => {
  describe('canFillerBid', () => {
    it('returns true if the filler supports the auction', () => {
      const filler: Filler = {
        name: 'Teapot',
        keypair: Keypair.random(),
        primaryAsset: 'XLM',
        defaultProfitPct: 0.1,
        minHealthFactor: 1.5,
        minPrimaryCollateral: FixedMath.toFixed(100, 7),
        forceFill: true,
        supportedBid: ['ASSET0', 'ASSET1', 'ASSET2'],
        supportedLot: ['ASSET1', 'ASSET2', 'ASSET3'],
      };
      const auctionData: AuctionData = {
        bid: new Map<string, bigint>([
          ['ASSET0', 100n],
          ['ASSET1', 200n],
        ]),
        lot: new Map<string, bigint>([
          ['ASSET1', 100n],
          ['ASSET3', 200n],
        ]),
        block: 123,
      };

      const result = canFillerBid(filler, auctionData);
      expect(result).toBe(true);
    });

    it('returns false if the filler does not support the lot', () => {
      const filler: Filler = {
        name: 'Teapot',
        keypair: Keypair.random(),
        primaryAsset: 'XLM',
        defaultProfitPct: 0.1,
        minHealthFactor: 1.5,
        minPrimaryCollateral: FixedMath.toFixed(100, 7),
        forceFill: true,
        supportedBid: ['ASSET0', 'ASSET1', 'ASSET2'],
        supportedLot: ['ASSET1', 'ASSET2', 'ASSET3'],
      };
      const auctionData: AuctionData = {
        bid: new Map<string, bigint>([
          ['ASSET0', 100n],
          ['ASSET1', 200n],
        ]),
        lot: new Map<string, bigint>([
          ['ASSET1', 100n],
          ['ASSET0', 200n],
        ]),
        block: 123,
      };

      const result = canFillerBid(filler, auctionData);
      expect(result).toBe(false);
    });

    it('returns false if the filler does not support the bid', () => {
      const filler: Filler = {
        name: 'Teapot',
        keypair: Keypair.random(),
        primaryAsset: 'XLM',
        defaultProfitPct: 0.1,
        minHealthFactor: 1.5,
        minPrimaryCollateral: FixedMath.toFixed(100, 7),
        forceFill: true,
        supportedBid: ['ASSET0', 'ASSET1', 'ASSET2'],
        supportedLot: ['ASSET1', 'ASSET2', 'ASSET3'],
      };
      const auctionData: AuctionData = {
        bid: new Map<string, bigint>([
          ['ASSET1', 100n],
          ['ASSET3', 200n],
        ]),
        lot: new Map<string, bigint>([
          ['ASSET1', 100n],
          ['ASSET3', 200n],
        ]),
        block: 123,
      };

      const result = canFillerBid(filler, auctionData);
      expect(result).toBe(false);
    });
  });
  describe('getFillerProfitPct', () => {
    it('gets profitPct from profit config if available', () => {
      const filler: Filler = {
        name: 'Teapot',
        keypair: Keypair.random(),
        primaryAsset: 'XLM',
        defaultProfitPct: 0.1,
        minHealthFactor: 1.5,
        minPrimaryCollateral: FixedMath.toFixed(100, 7),
        forceFill: true,
        supportedBid: ['ASSET0', 'ASSET1', 'ASSET2'],
        supportedLot: ['ASSET1', 'ASSET2', 'ASSET3'],
      };
      const profits: AuctionProfit[] = [
        {
          profitPct: 0.2,
          supportedBid: ['ASSET0', 'ASSET1'],
          supportedLot: ['ASSET1', 'ASSET3'],
        },
        {
          profitPct: 0.3,
          supportedBid: ['ASSET0', 'ASSET1'],
          supportedLot: ['ASSET1', 'ASSET2'],
        },
      ];
      const auctionData: AuctionData = {
        bid: new Map<string, bigint>([['ASSET0', 100n]]),
        lot: new Map<string, bigint>([
          ['ASSET1', 100n],
          ['ASSET2', 200n],
        ]),
        block: 123,
      };

      const result = getFillerProfitPct(filler, profits, auctionData);
      expect(result).toBe(0.3);
    });

    it('returns first matched profit', () => {
      const filler: Filler = {
        name: 'Teapot',
        keypair: Keypair.random(),
        primaryAsset: 'XLM',
        defaultProfitPct: 0.1,
        minHealthFactor: 1.5,
        minPrimaryCollateral: FixedMath.toFixed(100, 7),
        forceFill: true,
        supportedBid: ['ASSET0', 'ASSET1', 'ASSET2'],
        supportedLot: ['ASSET1', 'ASSET2', 'ASSET3'],
      };
      const profits: AuctionProfit[] = [
        {
          profitPct: 0.2,
          supportedBid: ['ASSET0', 'ASSET1'],
          supportedLot: ['ASSET1', 'ASSET3'],
        },
        {
          profitPct: 0.3,
          supportedBid: ['ASSET0', 'ASSET1'],
          supportedLot: ['ASSET1', 'ASSET2'],
        },
      ];
      const auctionData: AuctionData = {
        bid: new Map<string, bigint>([['ASSET0', 100n]]),
        lot: new Map<string, bigint>([['ASSET1', 100n]]),
        block: 123,
      };

      const result = getFillerProfitPct(filler, profits, auctionData);
      expect(result).toBe(0.2);
    });

    it('returns default profit if bid does not match', () => {
      const filler: Filler = {
        name: 'Teapot',
        keypair: Keypair.random(),
        primaryAsset: 'XLM',
        defaultProfitPct: 0.1,
        minHealthFactor: 1.5,
        minPrimaryCollateral: FixedMath.toFixed(100, 7),
        forceFill: true,
        supportedBid: ['ASSET0', 'ASSET1', 'ASSET2'],
        supportedLot: ['ASSET1', 'ASSET2', 'ASSET3'],
      };
      const profits: AuctionProfit[] = [
        {
          profitPct: 0.2,
          supportedBid: ['ASSET0', 'ASSET1'],
          supportedLot: ['ASSET1', 'ASSET3'],
        },
        {
          profitPct: 0.3,
          supportedBid: ['ASSET0', 'ASSET1'],
          supportedLot: ['ASSET1', 'ASSET2'],
        },
      ];
      const auctionData: AuctionData = {
        bid: new Map<string, bigint>([
          ['ASSET1', 100n],
          ['ASSET3', 200n],
        ]),
        lot: new Map<string, bigint>([['ASSET1', 100n]]),
        block: 123,
      };

      const result = getFillerProfitPct(filler, profits, auctionData);
      expect(result).toBe(0.1);
    });

    it('returns default profit if lot does not match', () => {
      const filler: Filler = {
        name: 'Teapot',
        keypair: Keypair.random(),
        primaryAsset: 'XLM',
        defaultProfitPct: 0.1,
        minHealthFactor: 1.5,
        minPrimaryCollateral: FixedMath.toFixed(100, 7),
        forceFill: true,
        supportedBid: ['ASSET0', 'ASSET1', 'ASSET2'],
        supportedLot: ['ASSET1', 'ASSET2', 'ASSET3'],
      };
      const profits: AuctionProfit[] = [
        {
          profitPct: 0.2,
          supportedBid: ['ASSET0', 'ASSET1'],
          supportedLot: ['ASSET1', 'ASSET3'],
        },
        {
          profitPct: 0.3,
          supportedBid: ['ASSET0', 'ASSET1'],
          supportedLot: ['ASSET1', 'ASSET2'],
        },
      ];
      const auctionData: AuctionData = {
        bid: new Map<string, bigint>([['ASSET0', 100n]]),
        lot: new Map<string, bigint>([
          ['ASSET1', 100n],
          ['ASSET0', 200n],
        ]),
        block: 123,
      };

      const result = getFillerProfitPct(filler, profits, auctionData);
      expect(result).toBe(0.1);
    });

    it('returns default profit if no auction profits defined', () => {
      const filler: Filler = {
        name: 'Teapot',
        keypair: Keypair.random(),
        primaryAsset: 'XLM',
        defaultProfitPct: 0.1,
        minHealthFactor: 1.5,
        minPrimaryCollateral: FixedMath.toFixed(100, 7),
        forceFill: true,
        supportedBid: ['ASSET0', 'ASSET1', 'ASSET2'],
        supportedLot: ['ASSET1', 'ASSET2', 'ASSET3'],
      };
      const profits: AuctionProfit[] = [];
      const auctionData: AuctionData = {
        bid: new Map<string, bigint>([['ASSET0', 100n]]),
        lot: new Map<string, bigint>([
          ['ASSET1', 100n],
          ['ASSET0', 200n],
        ]),
        block: 123,
      };

      const result = getFillerProfitPct(filler, profits, auctionData);
      expect(result).toBe(0.1);
    });
  });
  describe('managePositions', () => {
    const assets = mockPool.config.reserveList;
    const mockOracle = new PoolOracle(
      'CATKK5ZNJCKQQWTUWIUFZMY6V6MOQUGSTFSXMNQZHVJHYF7GVV36FB3Y',
      new Map<string, PriceData>([
        [assets[0], { price: BigInt(1e6), timestamp: 1724949300 }],
        [assets[1], { price: BigInt(1e7), timestamp: 1724949300 }],
        [assets[2], { price: BigInt(1.1e7), timestamp: 1724949300 }],
        [assets[3], { price: BigInt(1000e7), timestamp: 1724949300 }],
      ]),
      7,
      53255053
    );
    const filler: Filler = {
      name: 'Teapot',
      keypair: Keypair.random(),
      primaryAsset: assets[1],
      defaultProfitPct: 0.1,
      minHealthFactor: 1.5,
      minPrimaryCollateral: FixedMath.toFixed(100, 7),
      forceFill: true,
      supportedBid: [assets[1], assets[0]],
      supportedLot: [assets[1], assets[2], assets[3]],
    };

    it('clears excess liabilities and collateral', () => {
      const positions = new Positions(
        // dTokens
        new Map<number, bigint>([[1, FixedMath.toFixed(100, 7)]]),
        // bTokens
        new Map<number, bigint>([[2, FixedMath.toFixed(500, 7)]]),
        new Map<number, bigint>([])
      );
      const balances = new Map<string, bigint>([
        [assets[0], FixedMath.toFixed(0, 7)],
        [assets[1], FixedMath.toFixed(1234, 7)],
        [assets[2], FixedMath.toFixed(200, 7)],
        [assets[3], FixedMath.toFixed(0, 7)],
      ]);

      const requests = managePositions(filler, mockPool, mockOracle, positions, balances);

      const expectedRequests: Request[] = [
        {
          request_type: RequestType.Repay,
          address: assets[1],
          amount: FixedMath.toFixed(1234, 7),
        },
        {
          request_type: RequestType.WithdrawCollateral,
          address: assets[2],
          amount: BigInt('9223372036854775807'),
        },
      ];
      expect(requests).toEqual(expectedRequests);
    });

    it('does not withdraw collateral if a different liability still exists', () => {
      const positions = new Positions(
        // dTokens
        new Map<number, bigint>([[1, FixedMath.toFixed(5000, 7)]]),
        // bTokens
        new Map<number, bigint>([[2, FixedMath.toFixed(4500, 7)]]),
        new Map<number, bigint>([])
      );
      const balances = new Map<string, bigint>([
        [assets[0], FixedMath.toFixed(0, 7)],
        [assets[1], FixedMath.toFixed(3000, 7)],
        [assets[2], FixedMath.toFixed(0, 7)],
        [assets[3], FixedMath.toFixed(0, 7)],
      ]);

      const requests = managePositions(filler, mockPool, mockOracle, positions, balances);

      const expectedRequests: Request[] = [
        {
          request_type: RequestType.Repay,
          address: assets[1],
          amount: FixedMath.toFixed(3000, 7),
        },
      ];
      expect(requests).toEqual(expectedRequests);
    });

    it('does not withdraw primary collateral if a different liability still exists', () => {
      const positions = new Positions(
        // dTokens
        new Map<number, bigint>([[2, FixedMath.toFixed(4500, 7)]]),
        // bTokens
        new Map<number, bigint>([[1, FixedMath.toFixed(5000, 7)]]),
        new Map<number, bigint>([])
      );
      const balances = new Map<string, bigint>([
        [assets[0], FixedMath.toFixed(0, 7)],
        [assets[1], FixedMath.toFixed(0, 7)],
        [assets[2], FixedMath.toFixed(3000, 7)],
        [assets[3], FixedMath.toFixed(0, 7)],
      ]);

      const requests = managePositions(filler, mockPool, mockOracle, positions, balances);

      const expectedRequests: Request[] = [
        {
          request_type: RequestType.Repay,
          address: assets[2],
          amount: FixedMath.toFixed(3000, 7),
        },
      ];
      expect(requests).toEqual(expectedRequests);
    });

    it('can unwind looped positions', () => {
      filler.minHealthFactor = 1.1;
      const positions = new Positions(
        // dTokens
        new Map<number, bigint>([[1, FixedMath.toFixed(50000, 7)]]),
        // bTokens
        new Map<number, bigint>([[1, FixedMath.toFixed(58000, 7)]]),
        new Map<number, bigint>([])
      );
      const balances = new Map<string, bigint>([
        [assets[0], FixedMath.toFixed(0, 7)],
        [assets[1], FixedMath.toFixed(5000, 7)],
        [assets[2], FixedMath.toFixed(2000, 7)],
        [assets[3], FixedMath.toFixed(0, 7)],
      ]);

      const requests = managePositions(filler, mockPool, mockOracle, positions, balances);
      // return minimum health factor back to 1.5
      filler.minHealthFactor = 1.5;

      const expectedRequests: Request[] = [
        {
          request_type: RequestType.Repay,
          address: assets[1],
          amount: FixedMath.toFixed(5000, 7),
        },
        {
          request_type: RequestType.WithdrawCollateral,
          address: assets[1],
          amount: BigInt(29372567525),
        },
      ];
      expect(requests).toEqual(expectedRequests);
    });

    it('clears collateral with no liabilities and keeps primary collateral above min collateral', () => {
      const positions = new Positions(
        // dTokens
        new Map<number, bigint>([]),
        // bTokens
        new Map<number, bigint>([
          [1, FixedMath.toFixed(125, 7)],
          [3, FixedMath.toFixed(1, 7)],
        ]),
        new Map<number, bigint>([])
      );
      const balances = new Map<string, bigint>([
        [assets[0], FixedMath.toFixed(575, 7)],
        [assets[1], FixedMath.toFixed(3000, 7)],
        [assets[2], FixedMath.toFixed(1000, 7)],
        [assets[3], FixedMath.toFixed(0, 7)],
      ]);

      const requests = managePositions(filler, mockPool, mockOracle, positions, balances);

      const expectedRequests: Request[] = [
        {
          request_type: RequestType.WithdrawCollateral,
          address: assets[3],
          amount: BigInt('9223372036854775807'),
        },
        {
          request_type: RequestType.WithdrawCollateral,
          address: assets[1],
          amount: 258738051n,
        },
      ];
      expect(requests).toEqual(expectedRequests);
    });

    it('clears smallest collateral position first', () => {
      const positions = new Positions(
        // dTokens
        new Map<number, bigint>([
          [0, FixedMath.toFixed(1500, 7)],
          [3, FixedMath.toFixed(2, 7)],
        ]),
        // bTokens
        new Map<number, bigint>([
          [1, FixedMath.toFixed(5000, 7)],
          [2, FixedMath.toFixed(500, 7)],
        ]),
        new Map<number, bigint>([])
      );
      const balances = new Map<string, bigint>([
        [assets[0], FixedMath.toFixed(5000, 7)],
        [assets[1], FixedMath.toFixed(1234, 7)],
        [assets[2], FixedMath.toFixed(0, 7)],
        [assets[3], FixedMath.toFixed(1, 7)],
      ]);

      const requests = managePositions(filler, mockPool, mockOracle, positions, balances);

      const expectedRequests: Request[] = [
        {
          request_type: RequestType.Repay,
          address: assets[0],
          amount: FixedMath.toFixed(5000, 7),
        },
        {
          request_type: RequestType.Repay,
          address: assets[3],
          amount: FixedMath.toFixed(1, 7),
        },
        {
          request_type: RequestType.WithdrawCollateral,
          address: assets[2],
          amount: BigInt('9223372036854775807'),
        },
      ];
      expect(requests).toEqual(expectedRequests);
    });

    it('partially withdraws large collateral first when a liability position is maintained', () => {
      const positions = new Positions(
        // dTokens
        new Map<number, bigint>([
          [2, FixedMath.toFixed(1500, 7)],
          [3, FixedMath.toFixed(2, 7)],
        ]),
        // bTokens
        new Map<number, bigint>([
          [0, FixedMath.toFixed(500, 7)],
          [1, FixedMath.toFixed(2500, 7)],
          [2, FixedMath.toFixed(3000, 7)],
        ]),
        new Map<number, bigint>([])
      );
      const balances = new Map<string, bigint>([
        [assets[0], FixedMath.toFixed(5000, 7)],
        [assets[1], FixedMath.toFixed(1234, 7)],
        [assets[2], FixedMath.toFixed(1000, 7)],
        [assets[3], FixedMath.toFixed(1, 7)],
      ]);

      const requests = managePositions(filler, mockPool, mockOracle, positions, balances);

      const expectedRequests: Request[] = [
        {
          request_type: RequestType.Repay,
          address: assets[2],
          amount: FixedMath.toFixed(1000, 7),
        },
        {
          request_type: RequestType.Repay,
          address: assets[3],
          amount: FixedMath.toFixed(1, 7),
        },
        {
          request_type: RequestType.WithdrawCollateral,
          address: assets[2],
          amount: 14820705895n,
        },
      ];
      expect(requests).toEqual(expectedRequests);
    });
  });
});
