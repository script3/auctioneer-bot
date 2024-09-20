import { ChildProcess } from 'child_process';
import { appendFile } from 'fs/promises';
import { sendEvent, readEvent, deadletterEvent } from '../../src/utils/messages';
import { AppEvent, EventType } from '../../src/events';
import { parse, stringify } from '../../src/utils/json';
import { logger } from '../../src/utils/logger';

jest.mock('fs/promises', () => ({
  appendFile: jest.fn(),
}));

jest.mock('../../src/utils/json', () => ({
  parse: jest.fn(),
  stringify: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

describe('messages.ts', () => {
  let mockSubprocess: ChildProcess;

  beforeEach(() => {
    mockSubprocess = {
      send: jest.fn(),
    } as unknown as ChildProcess;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('sendEvent', () => {
    it('should send an event as a message', () => {
      const event: AppEvent = { type: EventType.LEDGER, ledger: 123, timestamp: Date.now() }; // Example event};
      const as_string = 'event_string';
      (stringify as jest.Mock).mockReturnValue(as_string);

      sendEvent(mockSubprocess, event);

      expect(stringify).toHaveBeenCalledWith(event);
      expect(mockSubprocess.send).toHaveBeenCalledWith({ type: 'event', data: as_string });
      expect(logger.info).toHaveBeenCalledWith(`Sent event: ${as_string}`);
    });
  });

  describe('readEvent', () => {
    it('should parse a valid event message', () => {
      const message = {
        type: 'event',
        data: JSON.stringify({ type: EventType.LEDGER, ledger: 123, timestamp: Date.now() }),
      };
      const event: AppEvent = { type: EventType.LEDGER, ledger: 123, timestamp: Date.now() }; // Example event};
      (parse as jest.Mock).mockReturnValue(event);

      const result = readEvent(message);

      expect(parse).toHaveBeenCalledWith(message.data);
      expect(result).toEqual(event);
    });

    it('should return undefined for an invalid event type', () => {
      const message = { type: 'invalid_event', data: 'event_string' };
      const event: AppEvent = { type: 'UNKNOWN EVENT' } as any; // Example event};

      const result = readEvent(message);

      expect(result).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(`Invalid message format, message: ${message}`);
    });

    it('should return undefined and log an error if parsing fails', () => {
      const message = { type: 'event', data: 'event_string' };
      const error = new Error('parse error');
      (parse as jest.Mock).mockImplementation(() => {
        throw error;
      });

      const result = readEvent(message);

      expect(parse).toHaveBeenCalledWith(message.data);
      expect(result).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        `Error reading event. Message: ${message} Error: ${error}`
      );
    });
  });

  describe('deadletterEvent', () => {
    it('should append an event to the deadletter queue', async () => {
      const event: AppEvent = { type: EventType.LEDGER, ledger: 123, timestamp: Date.now() }; // Example event};
      const as_string = JSON.stringify(event);
      (stringify as jest.Mock).mockReturnValue(as_string);

      await deadletterEvent(event);

      expect(stringify).toHaveBeenCalledWith(event);
      expect(appendFile).toHaveBeenCalledWith('./data/deadletter.txt', as_string + '\n');
      expect(logger.error).toHaveBeenCalledWith('Sending event to deadletter queue.');
    });

    it('should log an error if appending to the deadletter queue fails', async () => {
      const event: AppEvent = { type: EventType.LEDGER, ledger: 123, timestamp: Date.now() }; // Example event};
      const as_string = JSON.stringify(event);
      const error = new Error('append error');
      (stringify as jest.Mock).mockReturnValue(as_string);
      (appendFile as jest.Mock).mockImplementation(() => {
        throw error;
      });

      await deadletterEvent(event);

      expect(stringify).toHaveBeenCalledWith(event);
      expect(appendFile).toHaveBeenCalledWith('./data/deadletter.txt', as_string + '\n');
      expect(logger.error).toHaveBeenCalledWith('Sending event to deadletter queue.');
      expect(logger.error).toHaveBeenCalledWith(
        `Error sending event to dead letter queue. Event: ${as_string} Error: ${error}`
      );
    });
  });
});
