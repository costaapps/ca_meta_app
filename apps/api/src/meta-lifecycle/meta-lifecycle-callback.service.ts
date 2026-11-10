import {
  isTrustedMetaLifecycleCallback,
  type MetaLifecycleCallbackProcessor,
  type MetaLifecycleCallbackVerifier,
  type TrustedMetaLifecycleCallback,
} from './connection-lifecycle.types.js';

const APP_CONFIGURATION_REF = /^[A-Za-z0-9._-]{1,96}$/;
const MAX_CALLBACK_BYTES = 256 * 1024;

export class MetaLifecycleCallbackSignatureError extends Error {
  constructor() { super('Lifecycle callback authentication failed.'); this.name = 'MetaLifecycleCallbackSignatureError'; }
}

export class MetaLifecycleCallbackUnavailableError extends Error {
  constructor() { super('Lifecycle callback processing is unavailable.'); this.name = 'MetaLifecycleCallbackUnavailableError'; }
}

export class FailClosedMetaLifecycleCallbackVerifier implements MetaLifecycleCallbackVerifier {
  async verify(): Promise<undefined> { return undefined; }
}

/** Provider-specific callback parsing is intentionally an adapter; the currently observed Meta contract is Not confirmed. */
export class MetaLifecycleCallbackIngressService {
  constructor(
    private readonly verifier?: MetaLifecycleCallbackVerifier,
    private readonly processor?: MetaLifecycleCallbackProcessor,
  ) {}

  async receive(input: { readonly appConfigurationRef: string; readonly rawBody: Buffer }): Promise<{
    readonly accepted: true;
    readonly result: 'APPLIED' | 'DUPLICATE' | 'UNMAPPED';
  }> {
    if (!APP_CONFIGURATION_REF.test(input.appConfigurationRef) || !Buffer.isBuffer(input.rawBody) ||
      input.rawBody.length === 0 || input.rawBody.length > MAX_CALLBACK_BYTES) throw new MetaLifecycleCallbackSignatureError();
    if (!this.verifier || !this.processor) throw new MetaLifecycleCallbackUnavailableError();
    let callback: TrustedMetaLifecycleCallback | undefined;
    try {
      callback = await this.verifier.verify(input);
    } catch {
      // `undefined` is the verifier's explicit invalid/unverifiable result. A
      // thrown error means the verifier itself could not complete (for example,
      // its app-specific key/configuration lookup failed), so the provider must
      // be able to retry instead of receiving a permanent signature rejection.
      throw new MetaLifecycleCallbackUnavailableError();
    }
    if (!callback || !isTrustedMetaLifecycleCallback(callback) || callback.appConfigurationRef !== input.appConfigurationRef) {
      throw new MetaLifecycleCallbackSignatureError();
    }
    let result: 'APPLIED' | 'DUPLICATE' | 'UNMAPPED';
    try {
      result = await this.processor.process(callback);
    } catch {
      throw new MetaLifecycleCallbackUnavailableError();
    }
    return Object.freeze({ accepted: true, result });
  }
}
