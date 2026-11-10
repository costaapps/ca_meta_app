import { itemFromProtectedDelivery } from './meta-webhook-validation.js';
import type { ClaimedMetaWebhookItem, MetaWebhookRepository, MetaWebhookStatusLease } from './meta-webhook.repository.js';
import type { MetaWebhookItemProcessor, MetaWebhookItemProcessorInput, MetaWebhookPayloadProtector } from './meta-webhook.types.js';

function hasStatusFence(item: ClaimedMetaWebhookItem): item is ClaimedMetaWebhookItem & {
  readonly itemKind: 'statuses';
  readonly providerTimestamp: string;
  readonly providerMessageId: string;
  readonly providerStatus: string;
  readonly statusLease: MetaWebhookStatusLease;
} {
  return item.itemKind === 'statuses' && item.providerTimestamp !== null && item.providerMessageId !== null &&
    item.providerStatus !== null && item.statusLease !== null;
}

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
          leaseVersion: item.leaseVersion, state: 'RETRY_PENDING', safeErrorCode: 'WORKER_STOPPING',
          statusLease: item.statusLease });
        return true;
      }
      const commonInput = {
        eventRef: item.eventRef,
        eventKey: item.eventKey,
        schemaVersion: item.schemaVersion,
        tenantId: item.tenantId,
        appConfigurationId: item.appConfigurationId,
        assetId: item.assetId,
        eventType: item.eventType,
        item: providerItem,
      };
      let processorInput: MetaWebhookItemProcessorInput;
      if (item.itemKind === 'statuses') {
        if (!hasStatusFence(item)) {
          await this.repository.finalize({ eventId: item.id, workerRef: this.workerRef,
            leaseVersion: item.leaseVersion, state: 'DEAD_LETTER', safeErrorCode: 'STATUS_FENCE_UNAVAILABLE',
            statusLease: item.statusLease });
          return true;
        }
        processorInput = {
          ...commonInput,
          itemKind: 'statuses',
          providerTimestamp: item.providerTimestamp,
          providerMessageId: item.providerMessageId,
          providerStatus: item.providerStatus,
          providerStatusRank: item.providerStatusRank,
          statusFence: {
            leaseVersion: item.statusLease.leaseVersion,
            leaseToken: item.statusLease.leaseToken,
            eventKey: item.statusLease.eventKey,
            providerTimestamp: item.statusLease.providerTimestamp,
          },
        };
      } else {
        processorInput = {
          ...commonInput,
          itemKind: item.itemKind,
          providerTimestamp: item.providerTimestamp,
          providerMessageId: item.providerMessageId,
          providerStatus: null,
          providerStatusRank: null,
          statusFence: null,
        };
      }
      const result = await this.processor.process(processorInput, signal);
      if (result.kind === 'SUCCEEDED') {
        await this.repository.finalize({ eventId: item.id, workerRef: this.workerRef,
          leaseVersion: item.leaseVersion, state: 'PROCESSED', statusLease: item.statusLease });
      } else if (result.kind === 'PERMANENT_FAILURE' || item.attempt >= 8) {
        await this.repository.finalize({ eventId: item.id, workerRef: this.workerRef,
          leaseVersion: item.leaseVersion, state: 'DEAD_LETTER', safeErrorCode: result.safeErrorCode,
          statusLease: item.statusLease });
      } else {
        await this.repository.finalize({ eventId: item.id, workerRef: this.workerRef,
          leaseVersion: item.leaseVersion, state: 'RETRY_PENDING', safeErrorCode: result.safeErrorCode,
          statusLease: item.statusLease });
      }
    } catch {
      await this.repository.finalize({ eventId: item.id, workerRef: this.workerRef,
        leaseVersion: item.leaseVersion, state: item.attempt >= 8 ? 'DEAD_LETTER' : 'RETRY_PENDING',
        safeErrorCode: 'DEPENDENCY_UNAVAILABLE', statusLease: item.statusLease });
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
