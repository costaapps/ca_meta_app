import { itemFromProtectedDelivery } from './meta-webhook-validation.js';
import type { MetaWebhookRepository } from './meta-webhook.repository.js';
import type { MetaWebhookItemProcessor, MetaWebhookPayloadProtector } from './meta-webhook.types.js';

export class MetaWebhookWorker {
  private lastPayloadExpirySweep = 0;

  constructor(
    private readonly repository: MetaWebhookRepository,
    private readonly payloadProtector: MetaWebhookPayloadProtector,
    private readonly processor: MetaWebhookItemProcessor,
    private readonly workerRef: string,
  ) {}

  async runOne(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const item = await this.repository.claimNext(this.workerRef);
    if (!item) return false;
    try {
      const rawBody = await this.payloadProtector.unprotect(item.payload);
      const providerItem = itemFromProtectedDelivery(rawBody, item.locator);
      if (signal?.aborted) {
        await this.repository.finalize({ eventId: item.id, workerRef: this.workerRef,
          leaseVersion: item.leaseVersion, state: 'RETRY_PENDING', safeErrorCode: 'WORKER_STOPPING' });
        return true;
      }
      const result = await this.processor.process({
        eventRef: item.eventRef,
        tenantId: item.tenantId,
        appConfigurationId: item.appConfigurationId,
        assetId: item.assetId,
        eventType: item.eventType,
        item: providerItem,
      }, signal);
      if (result.kind === 'SUCCEEDED') {
        await this.repository.finalize({ eventId: item.id, workerRef: this.workerRef,
          leaseVersion: item.leaseVersion, state: 'PROCESSED' });
      } else if (result.kind === 'PERMANENT_FAILURE' || item.attempt >= 8) {
        await this.repository.finalize({ eventId: item.id, workerRef: this.workerRef,
          leaseVersion: item.leaseVersion, state: 'DEAD_LETTER', safeErrorCode: result.safeErrorCode });
      } else {
        await this.repository.finalize({ eventId: item.id, workerRef: this.workerRef,
          leaseVersion: item.leaseVersion, state: 'RETRY_PENDING', safeErrorCode: result.safeErrorCode });
      }
    } catch {
      await this.repository.finalize({ eventId: item.id, workerRef: this.workerRef,
        leaseVersion: item.leaseVersion, state: item.attempt >= 8 ? 'DEAD_LETTER' : 'RETRY_PENDING',
        safeErrorCode: 'DEPENDENCY_UNAVAILABLE' });
    }
    return true;
  }

  async run(signal: AbortSignal, onError: (safeCode: string) => void = () => undefined): Promise<void> {
    while (!signal.aborted) {
      try {
        if (Date.now() - this.lastPayloadExpirySweep >= 60_000) {
          await this.repository.expireProtectedPayloads();
          this.lastPayloadExpirySweep = Date.now();
        }
        const worked = await this.runOne(signal);
        if (!worked && !signal.aborted) await waitForNextPoll(signal);
      } catch {
        onError('WEBHOOK_WORKER_FAILURE');
        if (!signal.aborted) await waitForNextPoll(signal);
      }
    }
  }
}

export class FailClosedMetaWebhookItemProcessor implements MetaWebhookItemProcessor {
  async process(): Promise<{ readonly kind: 'RETRYABLE_FAILURE'; readonly safeErrorCode: string }> {
    return { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'PROCESSOR_NOT_CONFIGURED' };
  }
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, 500);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
