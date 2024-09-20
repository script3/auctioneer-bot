import { AuctioneerDatabase } from '../../src/utils/db.js';
import { binancePrices, coinbasePrices, setPrices } from '../../src/utils/prices.js';
import { inMemoryAuctioneerDb } from '../helpers/mocks.js';

// Mock the external modules and functions
jest.mock('../../src/utils/config.js', () => ({
  APP_CONFIG: {
    priceSources: [
      { type: 'coinbase', symbol: 'BTC-USD', assetId: 'bitcoin' },
      { type: 'coinbase', symbol: 'EURC-USD', assetId: 'eurc' },
      { type: 'binance', symbol: 'ETHUSDT', assetId: 'ethereum' },
      { type: 'binance', symbol: 'XLMUSDT', assetId: 'lumens' },
    ],
  },
}));

jest.mock('../../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
  },
}));

describe('setPrices', () => {
  let db: AuctioneerDatabase;
  let mockFetch: jest.Mock;
  let test_time = Date.now();
  let test_time_epoch = Math.floor(test_time / 1000);

  beforeAll(() => {
    db = inMemoryAuctioneerDb();
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(test_time));

    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();

    db.db.prepare('DELETE FROM prices').run();
  });

  it('fetches prices from Coinbase and Binance and sets them in the database', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('api.coinbase.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            products: [
              {
                product_id: 'BTC-USD',
                price: '59573.42',
              },
              {
                product_id: 'EURC-USD',
                price: '1.111',
              },
            ],
            num_products: 2,
          }),
        });
      } else if (url.includes('api.binance.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { symbol: 'ETHUSDT', price: '2604.17000000' },
            { symbol: 'XLMUSDT', price: '0.09730000' },
          ],
        });
      } else {
        return Promise.reject(new Error('Invalid URL'));
      }
    });

    await setPrices(db);

    // Check if fetch was called with the correct URLs
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.coinbase.com/api/v3/brokerage/market/products?product_ids=BTC-USD&product_ids=EURC-USD'
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.binance.com/api/v3/ticker/price?symbols=["ETHUSDT","XLMUSDT"]'
    );

    // Check if the prices were correctly inserted into the database
    let btcPrice = db.getPriceEntry('bitcoin');
    expect(btcPrice).toEqual({ asset_id: 'bitcoin', price: 59573.42, timestamp: test_time_epoch });
    let eurcPrice = db.getPriceEntry('eurc');
    expect(eurcPrice).toEqual({ asset_id: 'eurc', price: 1.111, timestamp: test_time_epoch });
    let ethPrice = db.getPriceEntry('ethereum');
    expect(ethPrice).toEqual({ asset_id: 'ethereum', price: 2604.17, timestamp: test_time_epoch });
    let xlmPrice = db.getPriceEntry('lumens');
    expect(xlmPrice).toEqual({ asset_id: 'lumens', price: 0.0973, timestamp: test_time_epoch });
  });
});

describe('coinbasePrices', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  it('should return an empty array if symbols array is empty', async () => {
    const result = await coinbasePrices([]);
    expect(result).toEqual([]);
  });

  it('should return prices for valid response from Coinbase', async () => {
    const mockResponse = {
      products: [
        { product_id: 'BTC-USD', price: '50000' },
        { product_id: 'ETH-USD', price: '4000' },
      ],
    };
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await coinbasePrices(['BTC-USD', 'ETH-USD']);
    expect(result).toEqual([
      { symbol: 'BTC-USD', price: 50000 },
      { symbol: 'ETH-USD', price: 4000 },
    ]);
  });

  it('should return an empty array for invalid response from Coinbase', async () => {
    const mockResponse = { unexpected: 'data' };
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await coinbasePrices(['BTC-USD']);
    expect(result).toEqual([]);
  });

  it('should return an empty array if fetch fails', async () => {
    (fetch as jest.Mock).mockRejectedValue(new Error('Fetch error'));

    const result = await coinbasePrices(['BTC-USD']);
    expect(result).toEqual([]);
  });
});

describe('binancePrices', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  it('should return an empty array if symbols array is empty', async () => {
    const result = await binancePrices([]);
    expect(result).toEqual([]);
  });

  it('should return prices for valid response from Binance', async () => {
    const mockResponse = [
      { symbol: 'BTCUSDT', price: '50000' },
      { symbol: 'ETHUSDT', price: '4000' },
    ];
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await binancePrices(['BTCUSDT', 'ETHUSDT']);
    expect(result).toEqual([
      { symbol: 'BTCUSDT', price: 50000 },
      { symbol: 'ETHUSDT', price: 4000 },
    ]);
  });

  it('should return an empty array for invalid response from Binance', async () => {
    const mockResponse = { unexpected: 'data' };
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await binancePrices(['BTCUSDT']);
    expect(result).toEqual([]);
  });

  it('should return an empty array if fetch fails', async () => {
    (fetch as jest.Mock).mockRejectedValue(new Error('Fetch error'));

    const result = await binancePrices(['BTCUSDT']);
    expect(result).toEqual([]);
  });
});
