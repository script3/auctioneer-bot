import { Channel, ConsumeMessage } from 'amqplib';
import { AppEvent, EventType } from '../events.js';
import { parse, stringify } from './json.js';
import { logger } from './logger.js';

export function sendEvent(channel: Channel, queue_name: string, event: AppEvent) {
  const as_string = stringify(event);
  channel.sendToQueue(queue_name, Buffer.from(as_string), {
    persistent: true,
  });
  logger.info(`Sending event to ${queue_name}. Event: ${as_string}`);
}

export function readEvent(message: ConsumeMessage | undefined): AppEvent | undefined {
  if (!message) {
    return undefined;
  }
  const event = message.content.toString();
  let as_event = parse<AppEvent>(event);
  if (Object.values(EventType).includes(as_event.type)) {
    return as_event;
  } else {
    logger.error(`Invalid event type read: ${as_event.type}, message: ${event}`);
    return undefined;
  }
}
