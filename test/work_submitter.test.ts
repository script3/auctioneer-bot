import { ContractError, ContractErrorType } from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import { AppConfig } from '../src/utils/config';
import { AuctionType } from '../src/utils/db';
import { logger } from '../src/utils/logger';
import { sendSlackNotification } from '../src/utils/slack_notifier';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { WorkSubmission, WorkSubmissionType, WorkSubmitter } from '../src/work_submitter';

// Mock dependencies
jest.mock('../src/utils/db');
jest.mock('../src/utils/soroban_helper');
jest.mock('../src/utils/slack_notifier');
jest.mock('../src/utils/logger');
jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock('../src/utils/config.js', () => {
  let config: AppConfig = {
    poolAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  } as AppConfig;
  return {
    APP_CONFIG: config,
  };
});

describe('WorkSubmitter', () => {
  let workSubmitter: WorkSubmitter;

  let mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let mockedSorobanHelperConstructor = SorobanHelper as jest.MockedClass<typeof SorobanHelper>;
  const mockedSendSlackNotif = sendSlackNotification as jest.MockedFunction<
    typeof sendSlackNotification
  >;

  beforeEach(() => {
    jest.resetAllMocks();
    workSubmitter = new WorkSubmitter();
    mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);
  });

  it('should submit a user liquidation successfully', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(true);
    expect(mockedSorobanHelper.loadAuction).toHaveBeenCalledWith(
      submission.user,
      AuctionType.Liquidation
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('should not submit if auction already exists', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue({
      bid: new Map<string, bigint>([['USD', BigInt(123)]]),
      lot: new Map<string, bigint>([['USD', BigInt(456)]]),
      block: 500,
    });

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
    };

    const result = await workSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).not.toHaveBeenCalled();
    expect(mockedSendSlackNotif).not.toHaveBeenCalled();
  });

  it('should adjust fill percentage up for user liquidation with error LIQ_TOO_SMALL', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiqTooSmall)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(false);
    expect(submission.liquidationPercent).toBe(BigInt(51));
    expect(logger.error).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('does not increase fill percentage past 100 for user liquidation with error LIQ_TOO_SMALL', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiqTooSmall)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(100),
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(false);
    expect(submission.liquidationPercent).toBe(BigInt(100));
    expect(logger.error).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('should adjust fill percentage down for user liquidation with error LIQ_TOO_LARGE', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiqTooLarge)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(false);
    expect(submission.liquidationPercent).toBe(BigInt(49));
    expect(logger.error).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('does not increase fill percentage past below 1 for user liquidation with error LIQ_TOO_LARGE', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiqTooLarge)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(1),
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(false);
    expect(submission.liquidationPercent).toBe(BigInt(1));
    expect(logger.error).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('does not adjust fill percentage for general error', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiquidation)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(false);
    expect(submission.liquidationPercent).toBe(BigInt(50));
    expect(logger.error).toHaveBeenCalled();
    expect(mockedSendSlackNotif).toHaveBeenCalled();
  });

  it('should adjust fill percentage based on contract error on each retry', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.submitTransaction.mockRejectedValue(
      new ContractError(ContractErrorType.InvalidLiqTooSmall)
    );

    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
    };

    workSubmitter.addSubmission(submission, 3, 0);
    while (workSubmitter.processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 3 retries plus the final increment before dropping
    expect(submission.liquidationPercent).toBe(BigInt(54));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Dropped liquidation for user')
    );
  });

  it('should submit a bad debt transfer successfully', async () => {
    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtTransfer,
      user: Keypair.random().publicKey(),
    };

    const result = await workSubmitter.submit(submission);
    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    expect(sendSlackNotification).toHaveBeenCalled();
  });

  it('should submit a bad debt auction successfully', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtAuction,
    };
    const result = await workSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    expect(sendSlackNotification).toHaveBeenCalled();
  });

  it('should not submit if auction already exists', async () => {
    mockedSorobanHelper.loadAuction.mockResolvedValue({
      bid: new Map<string, bigint>([['USD', BigInt(123)]]),
      lot: new Map<string, bigint>([['USD', BigInt(456)]]),
      block: 500,
    });

    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtAuction,
    };
    const result = await workSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedSorobanHelper.submitTransaction).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('should log an error when a liquidation is dropped', () => {
    const submission = {
      type: WorkSubmissionType.LiquidateUser,
      user: Keypair.random().publicKey(),
      liquidationPercent: BigInt(50),
    };
    workSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Dropped liquidation for user')
    );
  });

  it('should log an error when a bad debt transfer is dropped', () => {
    const submission: WorkSubmission = {
      type: WorkSubmissionType.BadDebtTransfer,
      user: Keypair.random().publicKey(),
    };

    workSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Dropped bad debt transfer for user')
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
