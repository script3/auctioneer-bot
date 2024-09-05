import { SubmissionQueue, Retriable } from '../../src/utils/submission_queue';
import { logger } from '../../src/utils/logger';

jest.mock('../../src/utils/logger.js');

class TestSubmissionQueue extends SubmissionQueue<string> {
  async submit(submission: string): Promise<boolean> {
    return submission === 'ack';
  }

  onDrop(submission: string): void {
    logger.error(`Dropped submission: ${submission}`);
  }
}

describe('SubmissionQueue', () => {
  let queue: TestSubmissionQueue;

  beforeEach(() => {
    queue = new TestSubmissionQueue();
  });

  test('should add entries to the back of the queue', () => {
    queue.addSubmission('submission1', 3);
    queue.addSubmission('submission2', 3);

    expect(queue.submissions.length).toBe(2);
    expect(queue.submissions[0].submission).toBe('submission1');
    expect(queue.submissions[1].submission).toBe('submission2');
  });

  test('should remove entries from the queue when acknowledged', async () => {
    queue.addSubmission('ack', 3);
    await queue.processQueue();

    expect(queue.submissions.length).toBe(0);
  });

  test('should retry entries when not acknowledged', async () => {
    queue.addSubmission('nack', 3);
    await queue.processQueue();

    expect(queue.submissions.length).toBe(1);
    expect(queue.submissions[0].submission).toBe('nack');
    expect(queue.submissions[0].retries).toBe(2);
  });

  test('should drop entries after max retries', async () => {
    queue.addSubmission('nack', 1);
    await queue.processQueue();
    await queue.processQueue();

    expect(queue.submissions.length).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      'Submission retry limit reached, dropping submission: "nack"'
    );
  });
});
