import { AuctionType } from '@blend-capital/blend-sdk';
import { sendNotification, getNotificationLevelForAuction } from '../../src/utils/notifier';
import { APP_CONFIG } from '../../src/utils/config';
import { NotificationLevel } from '../../src/utils/notifier';
import { logger } from '../../src/utils/logger';

// Mock dependencies
jest.mock('../../src/utils/config', () => ({
  APP_CONFIG: {
    name: 'TestBot',
    slackWebhook: undefined,
    discordWebhook: undefined,
    notificationLevel: undefined,
  },
  NotificationLevel: {
    LOW: 'low',
    MED: 'med',
    HIGH: 'high',
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));

// Mock global fetch
global.fetch = jest.fn();

describe('sendNotification', () => {
  let consoleLogSpy: jest.SpyInstance;
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

    // Reset APP_CONFIG to default state
    (APP_CONFIG as any).slackWebhook = undefined;
    (APP_CONFIG as any).discordWebhook = undefined;
    (APP_CONFIG as any).notificationLevel = NotificationLevel.MED;
    (APP_CONFIG as any).name = 'TestBot';
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe('notification level filtering', () => {
    beforeEach(() => {
      (APP_CONFIG as any).slackWebhook = 'https://hooks.slack.com/test';
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);
    });

    it('should send HIGH level notifications when config is set to HIGH', async () => {
      (APP_CONFIG as any).notificationLevel = NotificationLevel.HIGH;

      await sendNotification('High priority message', NotificationLevel.HIGH);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://hooks.slack.com/test',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('should NOT send MED level notifications when config is set to HIGH', async () => {
      (APP_CONFIG as any).notificationLevel = NotificationLevel.HIGH;

      await sendNotification('Medium priority message', NotificationLevel.MED);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should NOT send LOW level notifications when config is set to HIGH', async () => {
      (APP_CONFIG as any).notificationLevel = NotificationLevel.HIGH;

      await sendNotification('Low priority message', NotificationLevel.LOW);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should send HIGH and MED notifications when config is set to MED', async () => {
      (APP_CONFIG as any).notificationLevel = NotificationLevel.MED;

      await sendNotification('High priority message', NotificationLevel.HIGH);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      mockFetch.mockClear();

      await sendNotification('Medium priority message', NotificationLevel.MED);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should NOT send LOW notifications when config is set to MED', async () => {
      (APP_CONFIG as any).notificationLevel = NotificationLevel.MED;

      await sendNotification('Low priority message', NotificationLevel.LOW);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should send all notifications when config level is undefined (defaults to MED)', async () => {
      (APP_CONFIG as any).notificationLevel = undefined;

      await sendNotification('High priority', NotificationLevel.HIGH);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      mockFetch.mockClear();
      await sendNotification('Medium priority', NotificationLevel.MED);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      mockFetch.mockClear();
      await sendNotification('Low priority', NotificationLevel.LOW);
      expect(mockFetch).not.toHaveBeenCalled(); // MED level filters out LOW
    });
  });

  describe('fallback to console when no webhooks configured', () => {
    it('should log to console when both webhooks are undefined', async () => {
      (APP_CONFIG as any).slackWebhook = undefined;
      (APP_CONFIG as any).discordWebhook = undefined;

      await sendNotification('Test message', NotificationLevel.MED);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Bot Name: TestBot'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Test message'));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should include timestamp in console fallback', async () => {
      const dateSpy = jest
        .spyOn(Date.prototype, 'toISOString')
        .mockReturnValue('2024-01-01T00:00:00.000Z');

      await sendNotification('Test message', NotificationLevel.MED);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('2024-01-01T00:00:00.000Z')
      );

      dateSpy.mockRestore();
    });
  });

  describe('Slack notifications', () => {
    beforeEach(() => {
      (APP_CONFIG as any).slackWebhook = 'https://hooks.slack.com/test';
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);
    });

    it('should send notification to Slack with correct format', async () => {
      await sendNotification('Test notification', NotificationLevel.MED);

      expect(mockFetch).toHaveBeenCalledWith('https://hooks.slack.com/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: '*Bot Name*: TestBot\nTest notification',
        }),
      });
    });

    it('should add <!channel> tag for HIGH level notifications', async () => {
      await sendNotification('High priority alert', NotificationLevel.HIGH);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body.text).toContain('<!channel>');
      expect(body.text).toContain('High priority alert');
    });

    it('should NOT add <!channel> tag for MED level notifications', async () => {
      await sendNotification('Medium priority alert', NotificationLevel.MED);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body.text).not.toContain('<!channel>');
      expect(body.text).toContain('Medium priority alert');
    });

    it('should log error when Slack webhook fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      await sendNotification('Test message', NotificationLevel.MED);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error sending Slack notification')
      );
    });

    it('should log error when Slack webhook throws exception', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await sendNotification('Test message', NotificationLevel.MED);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error sending Slack notification')
      );
    });
  });

  describe('Discord notifications', () => {
    beforeEach(() => {
      (APP_CONFIG as any).discordWebhook = 'https://discord.com/api/webhooks/test';
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);
    });

    it('should send notification to Discord with correct format', async () => {
      await sendNotification('Test notification', NotificationLevel.MED);

      expect(mockFetch).toHaveBeenCalledWith('https://discord.com/api/webhooks/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '**TestBot**\nTest notification',
        }),
      });
    });

    it('should add @everyone tag for HIGH level notifications', async () => {
      await sendNotification('High priority alert', NotificationLevel.HIGH);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body.content).toContain('@everyone');
      expect(body.content).toContain('High priority alert');
    });

    it('should NOT add @everyone tag for MED level notifications', async () => {
      await sendNotification('Medium priority alert', NotificationLevel.MED);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body.content).not.toContain('@everyone');
      expect(body.content).toContain('Medium priority alert');
    });

    it('should log error when Discord webhook fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
      } as Response);

      await sendNotification('Test message', NotificationLevel.MED);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error sending Discord notification')
      );
    });

    it('should log error when Discord webhook throws exception', async () => {
      mockFetch.mockRejectedValue(new Error('Connection timeout'));

      await sendNotification('Test message', NotificationLevel.MED);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error sending Discord notification')
      );
    });
  });

  describe('multiple webhooks', () => {
    beforeEach(() => {
      (APP_CONFIG as any).slackWebhook = 'https://hooks.slack.com/test';
      (APP_CONFIG as any).discordWebhook = 'https://discord.com/api/webhooks/test';
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);
    });

    it('should send to both Slack and Discord when both are configured', async () => {
      await sendNotification('Multi-platform message', NotificationLevel.MED);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith('https://hooks.slack.com/test', expect.any(Object));
      expect(mockFetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/test',
        expect.any(Object)
      );
    });
  });
});

describe('getNotificationLevelForAuction', () => {
  describe('when bot successfully fills auction', () => {
    it('should return MED for Liquidation auctions', () => {
      const level = getNotificationLevelForAuction(AuctionType.Liquidation, true);
      expect(level).toBe(NotificationLevel.MED);
    });

    it('should return HIGH for BadDebt auctions', () => {
      const level = getNotificationLevelForAuction(AuctionType.BadDebt, true);
      expect(level).toBe(NotificationLevel.HIGH);
    });

    it('should return MED for Interest auctions', () => {
      const level = getNotificationLevelForAuction(AuctionType.Interest, true);
      expect(level).toBe(NotificationLevel.MED);
    });
  });

  describe('when bot does NOT fill auction', () => {
    it('should return LOW for Liquidation auctions', () => {
      const level = getNotificationLevelForAuction(AuctionType.Liquidation, false);
      expect(level).toBe(NotificationLevel.LOW);
    });

    it('should return HIGH for BadDebt auctions', () => {
      const level = getNotificationLevelForAuction(AuctionType.BadDebt, false);
      expect(level).toBe(NotificationLevel.HIGH);
    });

    it('should return LOW for Interest auctions', () => {
      const level = getNotificationLevelForAuction(AuctionType.Interest, false);
      expect(level).toBe(NotificationLevel.LOW);
    });
  });

  describe('edge cases', () => {
    it('should handle numeric auction type values correctly', () => {
      expect(getNotificationLevelForAuction(0 as AuctionType, true)).toBe(NotificationLevel.MED);
      expect(getNotificationLevelForAuction(1 as AuctionType, true)).toBe(NotificationLevel.HIGH);
      expect(getNotificationLevelForAuction(2 as AuctionType, true)).toBe(NotificationLevel.MED);
    });

    it('should default to MED for unknown auction types when bot fills', () => {
      const level = getNotificationLevelForAuction(999 as AuctionType, true);
      expect(level).toBe(NotificationLevel.MED);
    });

    it('should default to LOW for unknown auction types when bot does not fill', () => {
      const level = getNotificationLevelForAuction(999 as AuctionType, false);
      expect(level).toBe(NotificationLevel.LOW);
    });
  });
});
