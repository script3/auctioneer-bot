import { PoolOracle, PriceData } from '@blend-capital/blend-sdk';
import { OracleHistory } from '../src/oracle_history.js';

describe('oracleHistory', () => {
  it('finds significant price changes', async () => {
    let starting_prices = new Map<string, PriceData>();
    starting_prices.set('bitcoin', { price: BigInt(59573_0000000), timestamp: 1000 });
    starting_prices.set('eurc', { price: BigInt(1_1000000), timestamp: 1000 });
    starting_prices.set('ethereum', { price: BigInt(2_5000000), timestamp: 1000 });

    let next_prices = new Map<string, PriceData>();
    next_prices.set('bitcoin', { price: BigInt(59573_0000000 * 1.051), timestamp: 2000 });
    next_prices.set('eurc', { price: BigInt(1_1000000 * 1.04), timestamp: 2000 });
    next_prices.set('ethereum', { price: BigInt(2_5000000 * 0.94), timestamp: 2000 });

    let poolOracle0 = new PoolOracle('id', starting_prices, 7, 1);
    let poolOracle1 = new PoolOracle('id', next_prices, 7, 100);

    let oracleHistory = new OracleHistory(0.05);

    let initStep = oracleHistory.getSignificantPriceChanges(poolOracle0);
    expect(initStep.up).toEqual([]);
    expect(initStep.down).toEqual([]);

    let nextStep = oracleHistory.getSignificantPriceChanges(poolOracle1);
    expect(nextStep.up).toEqual(['bitcoin']);
    expect(nextStep.down).toEqual(['ethereum']);

    // check that the price history was updated for flagged assets
    expect(oracleHistory.priceHistory.get('bitcoin')).toEqual(next_prices.get('bitcoin'));
    expect(oracleHistory.priceHistory.get('ethereum')).toEqual(next_prices.get('ethereum'));
    // check that the price history was not updated for unflagged assets
    expect(oracleHistory.priceHistory.get('eurc')).toEqual(starting_prices.get('eurc'));
  });

  it('correctly tracks price history', async () => {
    let starting_prices = new Map<string, PriceData>();
    starting_prices.set('bitcoin', { price: BigInt(59573_0000000), timestamp: 1000 });
    starting_prices.set('eurc', { price: BigInt(1_1000000), timestamp: 1000 });
    starting_prices.set('ethereum', { price: BigInt(2_5000000), timestamp: 1000 });

    let next_prices = new Map<string, PriceData>();
    next_prices.set('bitcoin', {
      price: BigInt(59573_0000000 * 0.94),
      timestamp: 1000 + 24 * 60 * 60,
    });
    next_prices.set('eurc', { price: BigInt(1_1000000 * 1.04), timestamp: 1000 + 24 * 60 * 60 });
    next_prices.set('ethereum', {
      price: BigInt(2_5000000 * 0.98),
      timestamp: 1000 + 24 * 60 * 60,
    });

    let next_prices_2 = new Map<string, PriceData>();
    next_prices_2.set('bitcoin', {
      price: BigInt(59573_0000000 * 0.96),
      timestamp: 1000 + 24 * 60 * 60 + 1,
    });
    next_prices_2.set('eurc', {
      price: BigInt(1_1000000 * 1.06),
      timestamp: 1000 + 24 * 60 * 60 + 1,
    });
    next_prices_2.set('ethereum', {
      price: BigInt(2_5000000 * 0.96),
      timestamp: 1000 + 24 * 60 * 60 + 1,
    });

    let poolOracle0 = new PoolOracle('id', starting_prices, 7, 1);
    let poolOracle1 = new PoolOracle('id', next_prices, 7, 9000);
    let poolOracle2 = new PoolOracle('id', next_prices_2, 7, 10000);

    let oracleHistory = new OracleHistory(0.05);

    let initStep = oracleHistory.getSignificantPriceChanges(poolOracle0);
    expect(initStep.up).toEqual([]);
    expect(initStep.down).toEqual([]);

    let nextStep = oracleHistory.getSignificantPriceChanges(poolOracle1);
    expect(nextStep.up).toEqual([]);
    expect(nextStep.down).toEqual(['bitcoin']);

    let nextDayStep = oracleHistory.getSignificantPriceChanges(poolOracle2);
    expect(nextDayStep.up).toEqual(['eurc']);
    expect(nextDayStep.down).toEqual([]);

    // updated in poolOracle1
    expect(oracleHistory.priceHistory.get('bitcoin')).toEqual(next_prices.get('bitcoin'));
    // updated in poolOracle2
    expect(oracleHistory.priceHistory.get('ethereum')).toEqual(next_prices_2.get('ethereum'));
    // updated in poolOracle2
    expect(oracleHistory.priceHistory.get('eurc')).toEqual(next_prices_2.get('eurc'));
  });
});
