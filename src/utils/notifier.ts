import { AuctionType } from '@blend-capital/blend-sdk';
import { APP_CONFIG } from './config.js';
import { logger } from './logger.js';

/**
 * Notification levels indicating the severity of the message. Intended to filter notifications sent
 * to external services like Slack or Discord.
 *
 * - HIGH: Important notifications that may require immediate attention. Includes things like
 *         dropping auction fill events, bad debt auctions, or critical system errors.
 * - MED: Notifications of moderate importance that normally don't require attention. Includes
 *        successful auction fills, system warnings, and liquidation auctions.
 * - LOW: Informational messages that do not require immediate action. Includes interest auctions
 *        and debug information.
 */
export enum NotificationLevel {
  HIGH = 'high',
  MED = 'med',
  LOW = 'low',
}

async function sendSlackNotification(message: string, tag: boolean): Promise<void> {
  try {
    if (APP_CONFIG.slackWebhook) {
      const taggedMessage = tag ? `<!channel> ${message}` : message;
      const response = await fetch(APP_CONFIG.slackWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: `*Bot Name*: ${APP_CONFIG.name}\n${taggedMessage}`,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    }
  } catch (e) {
    logger.error(`Error sending Slack notification: ${e}`);
  }
}

async function sendDiscordNotification(message: string, tag: boolean): Promise<void> {
  try {
    if (APP_CONFIG.discordWebhook) {
      const taggedMessage = tag ? `@everyone ${message}` : message;
      const response = await fetch(APP_CONFIG.discordWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: `**${APP_CONFIG.name}**\n${taggedMessage}`,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    }
  } catch (e) {
    logger.error(`Error sending Discord notification: ${e}`);
  }
}

/**
 * Send a notification message to configured external services (Slack, Discord). If no services
 * are configured, logs the message to the console as a fallback. Will not send any notification if
 * the notification level is below the configured threshold.
 *
 * If no notification level is set in the config, defaults to MED.
 *
 * @param message - The notification message to send
 * @param level - The severity level of the notification
 */
export async function sendNotification(message: string, level: NotificationLevel): Promise<void> {
  // Determine if the notification should be sent based on the configured level.
  switch (APP_CONFIG.notificationLevel) {
    case NotificationLevel.HIGH:
      if (level !== NotificationLevel.HIGH) {
        return;
      }
      break;
    case NotificationLevel.MED:
    case undefined:
      if (level === NotificationLevel.LOW) {
        return;
      }
      break;
  }

  // If no webhooks are configured, log to console as fallback
  if (!APP_CONFIG.slackWebhook && !APP_CONFIG.discordWebhook) {
    console.log(`Bot Name: ${APP_CONFIG.name}\nTimestamp: ${new Date().toISOString()}\n${message}`);
    return;
  }

  // Send to both platforms in parallel if configured
  const notifications = [];

  if (APP_CONFIG.slackWebhook) {
    notifications.push(sendSlackNotification(message, level === NotificationLevel.HIGH));
  }

  if (APP_CONFIG.discordWebhook) {
    notifications.push(sendDiscordNotification(message, level === NotificationLevel.HIGH));
  }

  try {
    await Promise.all(notifications);
  } catch (error) {
    logger.error(`Error sending notifications: ${error}`);
  }
}

/**
 * Get the appropriate notification level for an auction based on its type and whether the bot successfully
 * filled it.
 * @param auctionType - The auction type to determine the notification level for
 * @param isBotFill - Whether the bot successfully filled the auction
 * @returns The notification level to use for the given auction type and fill status.
 */
export function getNotificationLevelForAuction(
  auctionType: AuctionType,
  isBotFill: boolean
): NotificationLevel {
  if (isBotFill) {
    switch (auctionType) {
      case 0: // Liquidation
        return NotificationLevel.MED;
      case 1: // Bad Debt
        return NotificationLevel.HIGH;
      case 2: // Interest
        return NotificationLevel.MED;
      default:
        return NotificationLevel.MED;
    }
  } else {
    switch (auctionType) {
      case 0: // Liquidation
        return NotificationLevel.LOW;
      case 1: // Bad Debt
        return NotificationLevel.HIGH;
      case 2: // Interest
        return NotificationLevel.LOW;
      default:
        return NotificationLevel.LOW;
    }
  }
}
