import type { ApiEnvironment } from '../config/environment.js';
import type { MetaAppConfiguration } from '../meta-config/meta-app-config.configuration.js';
import { MetaWebhookConfigurationResolver } from './meta-webhook-ingress.service.js';
import { MetaWebhookRepository, normalizeSqlTimestamp } from './meta-webhook.repository.js';
import type { MetaWebhookPayloadProtector, MetaWebhookReplayAuthorization } from './meta-webhook.types.js';
import { parseMetaWebhookDelivery } from './meta-webhook-validation.js';

const SAFE_AUDIT_REFERENCE = /^[A-Za-z0-9:_-]{1,128}$/;

export class MetaWebhookReplayService {
  private readonly configuration: MetaWebhookConfigurationResolver;

  constructor(
    profiles: readonly MetaAppConfiguration[],
    environment: ApiEnvironment['nodeEnv'],
    private readonly repository: MetaWebhookRepository,
    private readonly payloadProtector: MetaWebhookPayloadProtector,
    private readonly authorization: MetaWebhookReplayAuthorization,
  ) {
    this.configuration = new MetaWebhookConfigurationResolver(profiles, environment);
  }

  async replayQuarantined(input: { readonly eventId: string; readonly actorRef: string; readonly caseRef: string }): Promise<'ROUTED' | 'STILL_QUARANTINED'> {
    if (!SAFE_AUDIT_REFERENCE.test(input.actorRef) || !SAFE_AUDIT_REFERENCE.test(input.caseRef)) {
      throw new Error('Replay audit reference is invalid.');
    }
    await this.authorization.assertAuthorized({ actorRef: input.actorRef, caseRef: input.caseRef });
    const row = await this.repository.getQuarantined(input.eventId);
    if (!row || !row.delivery_id || !row.key_reference || !row.nonce || !row.authentication_tag ||
        !row.ciphertext || !row.expires_at) {
      if (row) await this.repository.recordReplayUnavailable({ ...input, reasonCode: 'PAYLOAD_EXPIRED_OR_UNAVAILABLE' });
      return 'STILL_QUARANTINED';
    }
    const application = row.app_configuration_ref
      ? this.configuration.resolveByAppConfigRef(row.app_configuration_ref)
      : undefined;
    if (!application || application.configurationRef !== row.app_configuration_ref ||
        row.delivery_provider_app_id !== row.provider_app_id || row.delivery_environment !== row.environment ||
        application.providerAppId !== row.provider_app_id || application.environment !== row.environment) {
      await this.repository.recordReplayUnavailable({ ...input, reasonCode: 'APPLICATION_CONTEXT_UNAVAILABLE' });
      return 'STILL_QUARANTINED';
    }

    let parsed: ReturnType<typeof parseMetaWebhookDelivery>;
    try {
      const rawBody = await this.payloadProtector.unprotect({
        reference: row.delivery_id,
        keyReference: row.key_reference,
        nonce: Buffer.from(row.nonce),
        authenticationTag: Buffer.from(row.authentication_tag),
        ciphertext: Buffer.from(row.ciphertext),
        expiresAt: normalizeSqlTimestamp(row.expires_at),
      });
      parsed = parseMetaWebhookDelivery(rawBody);
    } catch {
      await this.repository.recordReplayUnavailable({ ...input, reasonCode: 'PAYLOAD_EXPIRED_OR_UNAVAILABLE' });
      return 'STILL_QUARANTINED';
    }
    const item = parsed.items.find((candidate) => candidate.eventRef === row.event_ref);
    if (!item) {
      await this.repository.recordReplayUnavailable({ ...input, reasonCode: 'ITEM_IDENTITY_MISMATCH' });
      return 'STILL_QUARANTINED';
    }
    return this.repository.replayQuarantined({
      item: row, application, itemLocator: item, actorRef: input.actorRef, caseRef: input.caseRef,
    });
  }
}

export class FailClosedMetaWebhookReplayAuthorization implements MetaWebhookReplayAuthorization {
  async assertAuthorized(): Promise<never> { throw new Error('Webhook replay authorization is unavailable.'); }
}
