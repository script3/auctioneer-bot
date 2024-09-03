import { APP_CONFIG } from './config.js';
import { logger } from './logger.js';

export async function sendSlackNotification(message: string): Promise<void> {
  try {
    if (APP_CONFIG.slackWebhook) {
      const response = await fetch(APP_CONFIG.slackWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: `*Bot Name*: ${APP_CONFIG.name}\n*Pool Address*: ${APP_CONFIG.poolAddress}\n${message}`,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    }
  } catch (e) {
    logger.error(`Error sending slack notification: ${e}`);
  }
}
