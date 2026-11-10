import { randomUUID } from 'node:crypto';
import type { ApiEnvironment } from '../config/environment.js';
import type { MetaAppConfiguration } from '../meta-config/meta-app-config.configuration.js';
import { META_WEBHOOK_APP_CONFIG_REF_PATTERN, META_WEBHOOK_MAX_BODY_BYTES,
  MetaWebhookPayloadValidationError, parseMetaWebhookDelivery } from './meta-webhook-validation.js';
import { verifyChallengeToken, verifyMetaWebhookSignature } from './meta-webhook-signature.js';
import type { MetaWebhookRepository } from './meta-webhook.repository.js';
import type {
  MetaWebhookApplication,
  MetaWebhookPayloadProtector,
  MetaWebhookSecretProvider,
} from './meta-webhook.types.js';

export class MetaWebhookConfigurationUnavailableError extends Error {
  constructor() { super('Meta webhook configuration is unavailable.'); }
}

export class MetaWebhookSignatureError extends Error {
  constructor() { super('Meta webhook signature was rejected.'); }
}

export class MetaWebhookChallengeError extends Error {
  constructor() { super('Meta webhook challenge was rejected.'); }
}

export class MetaWebhookConfigurationResolver {
  constructor(private readonly profiles: readonly MetaAppConfiguration[], private readonly environment: ApiEnvironment['nodeEnv']) {}

  resolveByAppConfigRef(appConfigRef: string): MetaWebhookApplication | undefined {
    if (!META_WEBHOOK_APP_CONFIG_REF_PATTERN.test(appConfigRef)) return undefined;
    const matching = this.profiles.filter((profile) => profile.environment === this.environment &&
      profile.configurationRef === appConfigRef);
    if (matching.length !== 1) return undefined;
    const profile = matching[0];
    if (!profile?.enabled) return undefined;
    return {
      configurationRef: profile.configurationRef,
      providerAppId: profile.providerAppId,
      environment: this.environment,
      appSecretRef: profile.appSecretRef,
      providerAppIdRef: profile.providerAppIdRef,
    };
  }

}

export class MetaWebhookIngressService {
  constructor(
    private readonly configuration: MetaWebhookConfigurationResolver,
    private readonly secrets: MetaWebhookSecretProvider,
    private readonly payloadProtector: MetaWebhookPayloadProtector,
    private readonly repository: MetaWebhookRepository,
  ) {}

  async challenge(input: {
    readonly appConfigRef: string;
    readonly mode: string | undefined;
    readonly verifyToken: string | undefined;
    readonly challenge: string | undefined;
  }): Promise<string> {
    const application = this.configuration.resolveByAppConfigRef(input.appConfigRef);
    if (!application || input.mode !== 'subscribe' || !input.challenge || input.challenge.length > 512) {
      throw new MetaWebhookChallengeError();
    }
    const expected = await this.secrets.verificationToken({
      providerAppId: application.providerAppId,
      providerAppIdRef: application.providerAppIdRef,
      environment: application.environment,
    });
    if (expected === undefined || expected.length === 0) throw new MetaWebhookConfigurationUnavailableError();
    if (!verifyChallengeToken(input.verifyToken, expected)) throw new MetaWebhookChallengeError();
    return input.challenge;
  }

  async ingest(input: {
    readonly appConfigRef: string;
    readonly rawBody: Buffer;
    readonly signature: string | undefined;
    readonly receivedAt?: Date;
  }): Promise<{ readonly received: number; readonly inserted: number; readonly duplicate: number; readonly quarantined: number }> {
    if (!Buffer.isBuffer(input.rawBody) || input.rawBody.length === 0 || input.rawBody.length > META_WEBHOOK_MAX_BODY_BYTES) {
      throw new Error('Webhook body is outside the accepted size bounds.');
    }
    const application = this.configuration.resolveByAppConfigRef(input.appConfigRef);
    if (!application) throw new MetaWebhookConfigurationUnavailableError();

    // Verify the exact raw byte sequence before JSON parsing or trusting provider fields.
    const secretVersions = await this.secrets.appSecretVersions(application.appSecretRef);
    if (secretVersions.length === 0) throw new MetaWebhookConfigurationUnavailableError();
    if (!verifyMetaWebhookSignature(input.rawBody, input.signature, secretVersions)) {
      throw new MetaWebhookSignatureError();
    }
    const signatureVerifiedAt = new Date();
    let parsed: ReturnType<typeof parseMetaWebhookDelivery>;
    try {
      parsed = parseMetaWebhookDelivery(input.rawBody);
    } catch {
      throw new MetaWebhookPayloadValidationError();
    }
    const receivedAt = input.receivedAt ?? new Date();
    const protectedPayload = await this.payloadProtector.protect({
      reference: randomUUID(), providerAppId: application.providerAppId,
      environment: application.environment, rawBody: input.rawBody,
    });
    return this.repository.persist({ application, items: parsed.items, rawBody: input.rawBody, payload: protectedPayload,
      receivedAt, signatureVerifiedAt });
  }
}

export class FailClosedMetaWebhookSecretProvider implements MetaWebhookSecretProvider {
  async verificationToken(): Promise<string | undefined> { return undefined; }
  async appSecretVersions(): Promise<readonly Buffer[]> { return []; }
}

export class FailClosedMetaWebhookPayloadProtector implements MetaWebhookPayloadProtector {
  async protect(): Promise<never> { throw new MetaWebhookConfigurationUnavailableError(); }
  async unprotect(): Promise<never> { throw new MetaWebhookConfigurationUnavailableError(); }
}

export function metaWebhookConfigurationProfiles(environment: ApiEnvironment): readonly MetaAppConfiguration[] {
  return environment.metaAppConfigurations ?? [];
}
