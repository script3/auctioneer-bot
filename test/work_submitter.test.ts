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

describe('WorkSubmitter', () => {
  let workSubmitter: WorkSubmitter;
  let mockDb: jest.Mocked<AuctioneerDatabase>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = inMemoryAuctioneerDb() as jest.Mocked<AuctioneerDatabase>;
    workSubmitter = new WorkSubmitter(mockDb);
  });

  describe('submitUserLiquidation', () => {
    const mockedSendSlackNotif = sendSlackNotification as jest.MockedFunction<
      typeof sendSlackNotification
    >;
    const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation();
    it('should submit a user liquidation successfully', async () => {
      const mockLoadAuction = jest.fn().mockResolvedValue(undefined);
      const mockSubmitTransaction = jest.fn().mockResolvedValue(undefined);

      (SorobanHelper as jest.MockedClass<typeof SorobanHelper>).mockImplementation(
        () =>
          ({
            loadAuction: mockLoadAuction,
            submitTransaction: mockSubmitTransaction,
          }) as unknown as SorobanHelper
      );
      const submission = {
        type: WorkSubmissionType.LiquidateUser,
        user: 'testUser',
        liquidationPercent: BigInt(50),
      };

      const result = await workSubmitter.submit(submission);
      const expectedLogMessage = `Successfully submitted liquidation for user: ${submission.user} Liquidation Percent: ${submission.liquidationPercent}`;
      expect(result).toBe(true);
      expect(mockLoadAuction).toHaveBeenCalledWith('testUser', AuctionType.Liquidation);
      expect(mockSubmitTransaction).toHaveBeenCalled();
      expect(loggerInfoSpy).toHaveBeenCalledWith(expectedLogMessage);
      expect(mockedSendSlackNotif).toHaveBeenCalledWith(expectedLogMessage);
    });

    it('should not submit if auction already exists', async () => {
      const mockLoadAuction = jest.fn().mockResolvedValue({
        bid: new Map<string, bigint>([['USD', BigInt(123)]]),
        lot: new Map<string, bigint>([['USD', BigInt(456)]]),
        block: 500,
      });
      const mockSubmitTransaction = jest.fn().mockResolvedValue(undefined);

      (SorobanHelper as jest.MockedClass<typeof SorobanHelper>).mockImplementation(
        () =>
          ({
            loadAuction: mockLoadAuction,
            submitTransaction: mockSubmitTransaction,
          }) as unknown as SorobanHelper
      );
      const submission = {
        type: WorkSubmissionType.LiquidateUser,
        user: 'testUser',
        liquidationPercent: BigInt(50),
      };

      const result = await workSubmitter.submit(submission);

      expect(result).toBe(true);
      expect(mockSubmitTransaction).not.toHaveBeenCalled();
      expect(loggerInfoSpy).not.toHaveBeenCalled();
      expect(mockedSendSlackNotif).not.toHaveBeenCalled();
    });
  });

  describe('submitBadDebtTransfer', () => {
    it('should submit a bad debt transfer successfully', async () => {
      const mockLoadAuction = jest.fn().mockResolvedValue(undefined);
      const mockSubmitTransaction = jest.fn().mockResolvedValue(undefined);

      (SorobanHelper as jest.MockedClass<typeof SorobanHelper>).mockImplementation(
        () =>
          ({
            loadAuction: mockLoadAuction,
            submitTransaction: mockSubmitTransaction,
          }) as unknown as SorobanHelper
      );
      const submission: WorkSubmission = {
        type: WorkSubmissionType.BadDebtTransfer,
        user: 'testUser',
      };

      const result = await workSubmitter.submit(submission);
      const expectedLogMessage = `Successfully submitted bad debt transfer for user: ${submission.user}`;
      expect(result).toBe(true);
      expect(mockSubmitTransaction).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expectedLogMessage);
      expect(sendSlackNotification).toHaveBeenCalledWith(expectedLogMessage);
    });
  });

  describe('submitBadDebtAuction', () => {
    it('should submit a bad debt auction successfully', async () => {
      const mockLoadAuction = jest.fn().mockResolvedValue(undefined);
      const mockSubmitTransaction = jest.fn().mockResolvedValue(undefined);

      (SorobanHelper as jest.MockedClass<typeof SorobanHelper>).mockImplementation(
        () =>
          ({
            loadAuction: mockLoadAuction,
            submitTransaction: mockSubmitTransaction,
          }) as unknown as SorobanHelper
      );
      const submission: WorkSubmission = {
        type: WorkSubmissionType.BadDebtAuction,
      };

      const result = await workSubmitter.submit(submission);
      const expectedLogMessage = `Successfully submitted bad debt auction`;
      expect(result).toBe(true);
      expect(mockSubmitTransaction).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expectedLogMessage);
      expect(sendSlackNotification).toHaveBeenCalledWith(expectedLogMessage);
    });

    it('should not submit if auction already exists', async () => {
      const mockLoadAuction = jest.fn().mockResolvedValue({});
      const mockSubmitTransaction = jest.fn().mockResolvedValue(undefined);

      (SorobanHelper as jest.MockedClass<typeof SorobanHelper>).mockImplementation(
        () =>
          ({
            loadAuction: mockLoadAuction,
            submitTransaction: mockSubmitTransaction,
          }) as unknown as SorobanHelper
      );
      const submission: WorkSubmission = {
        type: WorkSubmissionType.BadDebtAuction,
      };

      const result = await workSubmitter.submit(submission);

      expect(result).toBe(true);
      expect(mockSubmitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('onDrop', () => {
    it('should log an error when a liquidation is dropped', () => {
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation();

      const submission = {
        type: WorkSubmissionType.LiquidateUser,
        user: 'testUser',
        liquidationPercent: BigInt(50),
      };

      workSubmitter.onDrop(submission);

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropped liquidation for user: testUser')
      );
    });
    it('should log an error when a bad debt transfer is dropped', () => {
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation();

      const submission: WorkSubmission = {
        type: WorkSubmissionType.BadDebtTransfer,
        user: 'testUser',
      };

      workSubmitter.onDrop(submission);

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropped bad debt transfer for user: testUser')
      );
    });
    it('should log an error when a bad debt auction is dropped', () => {
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation();

      const submission: WorkSubmission = {
        type: WorkSubmissionType.BadDebtAuction,
      };

      workSubmitter.onDrop(submission);

      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Dropped bad debt auction'));
    });
  });
});
