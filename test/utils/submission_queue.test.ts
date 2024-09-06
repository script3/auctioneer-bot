import { SubmissionQueue } from '../../src/utils/submission_queue';
import { logger } from '../../src/utils/logger';

jest.mock('../../src/utils/logger.js');

interface QueueItem {
  name: string;
  ack: boolean;
}
class TestSubmissionQueue extends SubmissionQueue<QueueItem> {
  async submit(submission: QueueItem): Promise<boolean> {
    return submission.ack;
  }

  onDrop(submission: QueueItem): void {
    logger.error(`Dropped submission: ${submission}`);
  }
}

describe('SubmissionQueue', () => {
  let queue: TestSubmissionQueue;

  beforeEach(() => {
    queue = new TestSubmissionQueue();
  });

  test('should add entries to the back of the queue', async () => {
    const submit = jest.spyOn(queue as any, 'submit' as any);
    queue.addSubmission({ name: 'submission1', ack: true }, 3);
    queue.addSubmission({ name: 'submission2', ack: true }, 3);

    while (queue.processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenNthCalledWith(1, { name: 'submission1', ack: true });
    expect(submit).toHaveBeenNthCalledWith(2, { name: 'submission2', ack: true });
  });

  test('should remove entries from the queue when acknowledged', async () => {
    queue.addSubmission({ name: 'submission', ack: true }, 3);
    while (queue.processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(queue.submissions.length).toBe(0);
    expect(queue.processing).toBe(false);
  });

  test('should retry entries when not acknowledged and drop entries after max retries', async () => {
    const retrySubmission = jest.spyOn(queue as any, 'retrySubmission' as any);
    const onDrop = jest.spyOn(queue as any, 'onDrop' as any);
    const submission = { name: 'submission', ack: false };
    queue.addSubmission(submission, 3);
    while (queue.processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(queue.submissions.length).toBe(0);
    // 3 times to retry + 1 time to drop
    expect(retrySubmission).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledWith(
      'Submission retry limit reached, dropping submission: ' + JSON.stringify(submission)
    );
    expect(onDrop).toHaveBeenCalledWith(submission);
  });
});
