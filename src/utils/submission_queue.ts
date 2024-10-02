import { stringify } from './json.js';
import { logger } from './logger.js';

export interface Retriable<T> {
  // The remaining number of retries for this submission
  retries: number;
  // The timestamp when this event was processed
  timestamp: number;
  // Minimum retry timeout
  minRetryTimeout: number;
  // The submission to be processed
  submission: T;
}

/**
 * A queue for processing submissions for an account to the stellar network in an
 * ordered, retriable manner.
 */
export abstract class SubmissionQueue<T> {
  submissions: Retriable<T>[];
  processing: boolean;

  /**
   * Create a submission queue
   * @param source
   */
  constructor() {
    this.submissions = [];
    this.processing = false;
  }

  /**
   * Add a submission to the queue. If the queue is not currently processing submissions,
   * the submission will be processed immediately.
   * @param submission - The submission to add to the queue
   * @param maxRetries - The maximum number of retries for the submission
   * @param minRetryTimeout - The minimum time to wait before retrying the submission
   */
  addSubmission(submission: T, maxRetries: number, minRetryTimeout: number = 1000): void {
    let retrieableSubmission: Retriable<T> = {
      retries: maxRetries,
      timestamp: 0,
      minRetryTimeout: minRetryTimeout,
      submission: submission,
    };
    this.submissions.push(retrieableSubmission);
    if (!this.processing) {
      this.processQueue();
    }
  }

  private retrySubmission(submission: Retriable<T>): void {
    if (submission.retries > 0) {
      submission.retries--;
      logger.warn(`Retrying submission, ${submission.retries} retries remaining.`);
      this.submissions.push(submission);
    } else {
      logger.error(
        `Submission retry limit reached, dropping submission: ${stringify(submission.submission)}`
      );
      this.onDrop(submission.submission);
    }
  }

  /**
   * Process the submission queue in FIFO order.
   */
  async processQueue() {
    if (this.processing || this.submissions.length === 0) {
      return;
    }
    this.processing = true;

    while (this.submissions.length > 0) {
      let retrieableSubmission = this.submissions[0];
      let time_now = Date.now();
      let startTime = retrieableSubmission.timestamp + retrieableSubmission.minRetryTimeout;
      if (time_now < startTime) {
        let waitTime = startTime - time_now;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      retrieableSubmission.timestamp = Date.now();
      try {
        let ack = await this.submit(retrieableSubmission.submission);
        if (!ack) {
          this.retrySubmission(retrieableSubmission);
        }
      } catch (error) {
        logger.error(`Unexpected error during submission`, error);
        this.retrySubmission(retrieableSubmission);
      }
      // Remove the submission from the queue after it has been processed
      this.submissions.shift();
    }

    this.processing = false;
  }

  /**
   * Execute the submission against the network.
   *
   * The submission will be consumed if the function returns true, and retried if false.
   *
   * @param submission - The submission to process
   * @returns A boolean if the submissions is acknowledged.
   */
  abstract submit(submission: T): Promise<boolean>;

  /**
   * Perform an action when a submission is dropped from the queue.
   *
   * @param submission - The submission that was dropped
   * @returns void
   */
  abstract onDrop(submission: T): void;
}
