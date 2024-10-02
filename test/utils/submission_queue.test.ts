import { logger } from '../../src/utils/logger';
import { SubmissionQueue } from '../../src/utils/submission_queue';

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

class TestSlowSubmissionQueue extends SubmissionQueue<QueueItem> {
  async submit(submission: QueueItem): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    queue.addSubmission(submission, 3, 100);
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

  test('should retry entries when not acknowledged and drop entries after max retries', async () => {
    const retrySubmission = jest.spyOn(queue as any, 'retrySubmission' as any);
    const onDrop = jest.spyOn(queue as any, 'onDrop' as any);
    const submission = { name: 'submission', ack: false };
    let timer_start = Date.now();
    queue.addSubmission(submission, 3, 100);
    while (queue.processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let time_passed = Date.now() - timer_start;
    expect(queue.submissions.length).toBe(0);
    // 3 times to retry + 1 time to drop
    expect(retrySubmission).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledWith(
      'Submission retry limit reached, dropping submission: ' + JSON.stringify(submission)
    );
    expect(onDrop).toHaveBeenCalledWith(submission);
    expect(time_passed).toBeGreaterThanOrEqual(300);
    expect(time_passed).toBeLessThanOrEqual(400);
  });

  test('should respect minRetryTimeout', async () => {
    const retrySubmission = jest.spyOn(queue as any, 'retrySubmission' as any);
    const onDrop = jest.spyOn(queue as any, 'onDrop' as any);
    const submission = { name: 'submission', ack: false };
    let timer_start = Date.now();
    queue.addSubmission(submission, 3, 500);
    while (queue.processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let time_passed = Date.now() - timer_start;
    expect(queue.submissions.length).toBe(0);
    // 3 times to retry + 1 time to drop
    expect(retrySubmission).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledWith(
      'Submission retry limit reached, dropping submission: ' + JSON.stringify(submission)
    );
    expect(onDrop).toHaveBeenCalledWith(submission);
    expect(time_passed).toBeGreaterThanOrEqual(1500);
    expect(time_passed).toBeLessThanOrEqual(1600);
  });

  test('should include retry timeout with processing time', async () => {
    let slow_queue = new TestSlowSubmissionQueue();
    const retrySubmission = jest.spyOn(slow_queue as any, 'retrySubmission' as any);
    const onDrop = jest.spyOn(slow_queue as any, 'onDrop' as any);
    const submission = { name: 'submission', ack: false };

    let timer_start = Date.now();
    slow_queue.addSubmission(submission, 3, 75);
    while (slow_queue.processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let time_passed = Date.now() - timer_start;
    expect(slow_queue.submissions.length).toBe(0);
    // 3 times to retry + 1 time to drop
    expect(retrySubmission).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledWith(
      'Submission retry limit reached, dropping submission: ' + JSON.stringify(submission)
    );
    expect(onDrop).toHaveBeenCalledWith(submission);
    // event is tried once + 3 retries and takes 100 ms per attempt
    expect(time_passed).toBeGreaterThanOrEqual(400);
    expect(time_passed).toBeLessThanOrEqual(500);
  });
});
