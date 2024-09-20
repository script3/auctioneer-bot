import { ChildProcess } from 'child_process';
import { appendFile } from 'fs/promises';
import { AppEvent, EventType } from '../events.js';
import { parse, stringify } from './json.js';
import { logger } from './logger.js';

/**
 * Send an event as a message.
 * @param process
 * @param queue_name
 * @param event
 */
export function sendEvent(subprocess: ChildProcess, event: AppEvent) {
  const as_string = stringify(event);
  subprocess.send({ type: 'event', data: as_string });
  logger.info(`Sent event: ${as_string}`);
}

/**
 * Parse an event from a message.
 * @param message - The message received from the parent process.
 * @returns An app event, or undefined it it is not a valid event.
 */
export function readEvent(message: any): AppEvent | undefined {
  try {
    if (message && message?.type === 'event' && typeof message?.data === 'string') {
      let as_event = parse<AppEvent>(message.data);
      if (Object.values(EventType).includes(as_event.type)) {
        return as_event;
      } else {
        logger.error(`Invalid event read, message: ${message.data}`);
        return undefined;
      }
    } else {
      logger.error(`Invalid message format, message: ${message}`);
      return undefined;
    }
  } catch (error) {
    logger.error(`Error reading event. Message: ${message} Error: ${error}`);
    return undefined;
  }
}

/**
 * Send an event to the deadletter queue.
 * @param event - The event as a string
 */
export async function deadletterEvent(event: AppEvent) {
  let as_string = stringify(event);
  try {
    logger.error(`Sending event to deadletter queue.`);
    await appendFile('./data/deadletter.txt', as_string + '\n');
  } catch (error) {
    logger.error(`Error sending event to dead letter queue. Event: ${as_string} Error: ${error}`);
  }
}
