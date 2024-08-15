import { BlendContractType, PoolEventType, PoolNewAuctionEvent } from '@blend-capital/blend-sdk';
import { EventType, PoolEventEvent } from '../../src/events.js';
import { UserEntry } from '../../src/utils/db.js';
import { parse, stringify } from '../../src/utils/json.js';

test('user entry parse round trip', () => {
  // happy path
  const userTest: UserEntry = {
    user_id: 'test',
    health_factor: 2.5,
    collateral: new Map<string, bigint>([
      ['asset1', BigInt(123)],
      ['asset2', BigInt(456)],
    ]),
    liabilities: new Map<string, bigint>([['asset3', BigInt(789)]]),
    updated: 123,
  };

  let asJsonString = stringify(userTest);
  let asObj = parse<UserEntry>(asJsonString);

  expect(userTest.user_id).toEqual(asObj.user_id);
  expect(userTest.health_factor).toEqual(asObj.health_factor);
  expect(userTest.collateral.size).toEqual(asObj.collateral.size);
  expect(userTest.collateral.get('asset1')).toEqual(asObj.collateral.get('asset1'));
  expect(userTest.collateral.get('asset2')).toEqual(asObj.collateral.get('asset2'));
  expect(userTest.liabilities.size).toEqual(asObj.liabilities.size);
  expect(userTest.liabilities.get('asset3')).toEqual(asObj.liabilities.get('asset3'));
  expect(userTest.updated).toEqual(asObj.updated);

  // with an empty map
  const userTestEmpty: UserEntry = {
    user_id: 'test',
    health_factor: 2.5,
    collateral: new Map<string, bigint>([['asset3', BigInt(123)]]),
    liabilities: new Map<string, bigint>(),
    updated: 123,
  };

  let asJsonStringEmpty = stringify(userTestEmpty);
  let asObjEmpty = parse<UserEntry>(asJsonStringEmpty);

  expect(userTestEmpty.user_id).toEqual(asObjEmpty.user_id);
  expect(userTestEmpty.health_factor).toEqual(asObjEmpty.health_factor);
  expect(userTestEmpty.collateral.size).toEqual(asObjEmpty.collateral.size);
  expect(userTestEmpty.collateral.get('asset3')).toEqual(asObjEmpty.collateral.get('asset3'));
  expect(userTestEmpty.liabilities.size).toEqual(asObjEmpty.liabilities.size);
  expect(userTestEmpty.updated).toEqual(asObjEmpty.updated);

  // just the map
  const mapTest = new Map<string, bigint>([
    ['asset1', BigInt(123)],
    ['asset2', BigInt(456)],
  ]);

  let asJsonStringMap = stringify(mapTest);
  let asObjMap = parse<Map<string, bigint>>(asJsonStringMap);

  expect(mapTest.size).toEqual(asObjMap.size);
  expect(mapTest.get('asset1')).toEqual(asObjMap.get('asset1'));
  expect(mapTest.get('asset2')).toEqual(asObjMap.get('asset2'));
});

test('blend event parse round trip', () => {
  const blendEvent: PoolNewAuctionEvent = {
    id: 'abc',
    contractId: '123',
    contractType: BlendContractType.Pool,
    ledger: 123,
    ledgerClosedAt: Date.now().toLocaleString(),
    txHash: '0x123',
    eventType: PoolEventType.NewAuction,
    auctionType: 2,
    auctionData: {
      bid: new Map<string, bigint>([['C2', BigInt(123)]]),
      lot: new Map<string, bigint>([
        ['C1', BigInt(456)],
        ['C2', BigInt(789)],
      ]),
      block: 123,
    },
  };
  const eventTest: PoolEventEvent = {
    type: EventType.POOL_EVENT,
    timestamp: Date.now(),
    event: blendEvent,
  };

  let asJsonString = stringify(eventTest);
  let asObj = parse<PoolEventEvent>(asJsonString);

  // make editor follow typing
  if (
    asObj.type === EventType.POOL_EVENT &&
    asObj.event.eventType === PoolEventType.NewAuction &&
    eventTest.type === EventType.POOL_EVENT &&
    eventTest.event.eventType === PoolEventType.NewAuction
  ) {
    expect(eventTest.type).toEqual(asObj.type);
    expect(eventTest.timestamp).toEqual(asObj.timestamp);
    expect(eventTest.event.id).toEqual(asObj.event.id);
    expect(eventTest.event.contractId).toEqual(asObj.event.contractId);
    expect(eventTest.event.contractType).toEqual(asObj.event.contractType);
    expect(eventTest.event.ledger).toEqual(asObj.event.ledger);
    expect(eventTest.event.ledgerClosedAt).toEqual(asObj.event.ledgerClosedAt);
    expect(eventTest.event.txHash).toEqual(asObj.event.txHash);
    expect(eventTest.event.eventType).toEqual(asObj.event.eventType);
    expect(eventTest.event.auctionType).toEqual(asObj.event.auctionType);
    expect(eventTest.event.auctionData.bid.size).toEqual(asObj.event.auctionData.bid.size);
    expect(eventTest.event.auctionData.bid.get('C2')).toEqual(
      asObj.event.auctionData.bid.get('C2')
    );
    expect(eventTest.event.auctionData.lot.size).toEqual(asObj.event.auctionData.lot.size);
    expect(eventTest.event.auctionData.lot.get('C1')).toEqual(
      asObj.event.auctionData.lot.get('C1')
    );
    expect(eventTest.event.auctionData.lot.get('C2')).toEqual(
      asObj.event.auctionData.lot.get('C2')
    );
  } else {
    fail('Type mismatch');
  }
});
