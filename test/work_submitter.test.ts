import { WorkSubmitter, WorkSubmissionType, WorkSubmission } from '../src/work_submitter';
import { AuctioneerDatabase, AuctionType } from '../src/utils/db';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { inMemoryAuctioneerDb } from './helpers/mocks';
import { logger } from '../src/utils/logger';
import { sendSlackNotification } from '../src/utils/slack_notifier';

// Mock dependencies
jest.mock('../src/utils/db');
jest.mock('../src/utils/soroban_helper');
jest.mock('@blend-capital/blend-sdk');
jest.mock('../src/utils/slack_notifier');
jest.mock('../src/utils/logger');
jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('WorkSubmitter', () => {
  let workSubmitter: WorkSubmitter;
  let mockDb: AuctioneerDatabase;

  let mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let mockedSorobanHelperConstructor = SorobanHelper as jest.MockedClass<typeof SorobanHelper>;

  const mockedSendSlackNotif = sendSlackNotification as jest.MockedFunction<
    typeof sendSlackNotification
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = inMemoryAuctioneerDb();
    workSubmitter = new WorkSubmitter(mockDb);
  });
  it('should submit a user liquidation successfully', async () => {
    mockedSorobanHelper.loadAuction = jest.fn().mockResolvedValue(undefined);
    mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);
    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: 'testUser',
      liquidationPercent: BigInt(50),
    };

    const result = await workSubmitter.submit(submission);
    const expectedLogMessage = `Successfully submitted liquidation for user: ${submission.user} Liquidation Percent: ${submission.liquidationPercent}`;
    expect(result).toBe(true);
    expect(mockedSorobanHelper.loadAuction).toHaveBeenCalledWith(
      'testUser',
      AuctionType.Liquidation
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expectedLogMessage);
    expect(mockedSendSlackNotif).toHaveBeenCalledWith(expectedLogMessage);
  });

  it('should not submit if auction already exists', async () => {
    mockedSorobanHelper.loadAuction = jest.fn().mockResolvedValue({
      bid: new Map<string, bigint>([['USD', BigInt(123)]]),
      lot: new Map<string, bigint>([['USD', BigInt(456)]]),
      block: 500,
    });
    mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: 'testUser',
      liquidationPercent: BigInt(50),
    };

    const result = await workSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'User liquidation auction already exists for user: testUser'
    );
    expect(mockedSendSlackNotif).not.toHaveBeenCalled();
  });

  it('should submit a bad debt transfer successfully', async () => {
    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtTransfer,
      user: 'testUser',
    };

    const result = await workSubmitter.submit(submission);
    const expectedLogMessage = `Successfully submitted bad debt transfer for user: ${submission.user}`;
    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expectedLogMessage);
    expect(sendSlackNotification).toHaveBeenCalledWith(expectedLogMessage);
  });

  it('should submit a bad debt auction successfully', async () => {
    mockedSorobanHelper.loadAuction = jest.fn().mockResolvedValue(undefined);
    mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);

    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtAuction,
    };
    const result = await workSubmitter.submit(submission);
    const expectedLogMessage = `Successfully submitted bad debt auction`;
    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expectedLogMessage);
    expect(sendSlackNotification).toHaveBeenCalledWith(expectedLogMessage);
  });

  it('should not submit if auction already exists', async () => {
    mockedSorobanHelper.loadAuction = jest.fn().mockResolvedValue({
      bid: new Map<string, bigint>([['USD', BigInt(123)]]),
      lot: new Map<string, bigint>([['USD', BigInt(456)]]),
      block: 500,
    });
    mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);

    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtAuction,
    };

    const result = await workSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Bad debt auction already exists');
  });

  it('should log an error when a liquidation is dropped', () => {
    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: 'testUser',
      liquidationPercent: BigInt(50),
    };

    workSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Dropped liquidation for user: testUser')
    );
  });
  it('should log an error when a bad debt transfer is dropped', () => {
    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtTransfer,
      user: 'testUser',
    };

    workSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Dropped bad debt transfer for user: testUser')
    );
  });
  it('should log an error when a bad debt auction is dropped', () => {
    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtAuction,
    };

    workSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Dropped bad debt auction'));
  });
});
