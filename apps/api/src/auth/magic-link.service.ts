import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AbuseLimitService } from '../common/security/abuse-limits.js';
import { SafeBoundaryError } from '../common/security/security.errors.js';
import type { ApiEnvironment } from '../config/environment.js';
import type { IssuedPortalSession, PortalSessionPublicContext } from '../identity/portal-session.service.js';
import type { MagicLinkIssuedSession, MagicLinkStore } from './magic-link.store.js';

export const MAGIC_LINK_MAIL_TRANSPORT = Symbol('MAGIC_LINK_MAIL_TRANSPORT');
export const MAGIC_LINK_ENVIRONMENT = Symbol('MAGIC_LINK_ENVIRONMENT');

export interface MagicLinkMail {
  readonly recipient: string;
  readonly confirmationUrl: string;
  readonly subject: string;
}

export abstract class MagicLinkMailTransport {
  abstract send(message: MagicLinkMail): Promise<void>;
}

export interface LocalInboxMessage extends MagicLinkMail {
  readonly id: string;
  readonly createdAt: string;
}

/** This transport never opens a network connection and is only registered in local/test mode. */
export class LocalMagicLinkInbox extends MagicLinkMailTransport {
  private readonly messages: LocalInboxMessage[] = [];

  override async send(message: MagicLinkMail): Promise<void> {
    this.messages.push(Object.freeze({ ...message, id: randomUUID(), createdAt: new Date().toISOString() }));
  }

  list(): readonly LocalInboxMessage[] {
    return Object.freeze(this.messages.map((message) => Object.freeze({ ...message })));
  }
}

export interface MagicLinkRequestResult {
  readonly accepted: true;
}

export interface MagicLinkConsumeResult {
  readonly session: IssuedPortalSession;
  readonly availableTenants: MagicLinkIssuedSession['availableTenants'];
}

export function normalizeMagicLinkEmail(value: string): string {
  const normalized = value.normalize('NFC').trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new BadRequestException('Check the submitted fields.');
  }
  return normalized;
}

function digestHex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function deriveMagicLinkToken(linkId: string, recoveryKey: string): string {
  return createHmac('sha256', recoveryKey).update(`ca-meta-magic-link-v1\0${linkId}`, 'utf8').digest('base64url');
}

export function hashMagicLinkEmail(email: string, recoveryKey: string): string {
  const normalized = normalizeMagicLinkEmail(email);
  return createHmac('sha256', recoveryKey).update(`ca-meta-magic-link-email-v1\0${normalized}`, 'utf8').digest('hex');
}

function sessionFrom(record: MagicLinkIssuedSession): IssuedPortalSession {
  const principalRef = digestHex(`principal-ref\0${record.principalId}`);
  const publicContext: PortalSessionPublicContext = Object.freeze({
    sessionRef: record.sessionId,
    principalRef,
    roles: Object.freeze([...record.roles]),
    tenantRef: record.tenantId,
    tenantContextRef: record.contextRef,
    contextVersion: 1,
  });
  return Object.freeze({
    sessionId: record.sessionId,
    sessionCookie: record.sessionCookie,
    csrfToken: record.csrfToken,
    contextRef: record.contextRef,
    tenantId: record.tenantId,
    expiresAt: record.expiresAt,
    publicContext,
  });
}

@Injectable()
export class MagicLinkService implements OnModuleInit, OnModuleDestroy {
  private deliveryTimer?: NodeJS.Timeout;
  private deliveryInProgress = false;
  private readonly deliveryEnabled: boolean;
  private readonly confirmationOrigin: string;

  constructor(
    private readonly store: MagicLinkStore,
    private readonly abuseLimits: AbuseLimitService,
    private readonly mailTransport: MagicLinkMailTransport,
    private readonly environment: ApiEnvironment,
  ) {
    this.deliveryEnabled = environment.nodeEnv === 'development' || environment.nodeEnv === 'test';
    this.confirmationOrigin = environment.allowedOrigins[0] ?? 'http://localhost';
  }

  onModuleInit(): void {
    if (!this.deliveryEnabled) return;
    this.deliveryTimer = setInterval(() => {
      if (this.deliveryInProgress) return;
      this.deliveryInProgress = true;
      void this.processNextDelivery().catch(() => undefined).finally(() => {
        this.deliveryInProgress = false;
      });
    }, 1000);
    this.deliveryTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
  }

  async request(email: string, ip: string | undefined): Promise<MagicLinkRequestResult> {
    const normalizedEmail = normalizeMagicLinkEmail(email);
    const emailHash = hashMagicLinkEmail(normalizedEmail, this.environment.portalSessionRecoveryKey);
    const requestIp = ip ?? 'unknown';

    await this.abuseLimits.consume('MAGIC_LINK_REQUEST', { ip: requestIp });
    await this.abuseLimits.consume('MAGIC_LINK_IDENTITY_REQUEST', { ip: requestIp, actor: emailHash });

    // No identity query, token, or queue entry is created until a local fake transport is enabled.
    // Staging/production remain closed until an approved runtime provider adapter is configured.
    if (!this.deliveryEnabled) return Object.freeze({ accepted: true });

    const target = await this.store.findEligibleTarget(emailHash);
    if (target) {
      try {
        await this.abuseLimits.consume('MAGIC_LINK_TENANT_REQUEST', { ip: requestIp, tenant: target.tenantId });
      } catch (error) {
        if (error instanceof SafeBoundaryError && error.code === 'RATE_LIMITED') {
          // The public status/body must not show whether the tenant quota was reached.
          return Object.freeze({ accepted: true });
        }
        throw error;
      }
      const linkId = randomBytes(32).toString('hex');
      const token = deriveMagicLinkToken(linkId, this.environment.portalSessionRecoveryKey);
      await this.store.enqueueForInvitedIdentity({
        emailHash,
        recipient: normalizedEmail,
        target,
        linkId,
        tokenHash: digestHex(token),
      });
    }
    return Object.freeze({ accepted: true });
  }

  async consume(token: string, ip: string | undefined, priorSessionCookie?: string): Promise<MagicLinkConsumeResult> {
    const tokenHash = digestHex(token);
    await this.abuseLimits.consume('MAGIC_LINK_CONSUME', { ip: ip ?? 'unknown', actor: tokenHash });
    const sessionCookie = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const contextRef = randomBytes(32).toString('base64url');
    const record = await this.store.consumeAndIssueSession(tokenHash, {
      sessionId: randomUUID(),
      sessionCookie,
      sessionCookieHash: digestHex(sessionCookie),
      csrfToken,
      csrfTokenHash: digestHex(csrfToken),
      contextRef,
      contextRefHash: digestHex(contextRef),
      ...(priorSessionCookie ? { priorSessionSecretHash: digestHex(priorSessionCookie) } : {}),
    });
    const issued = sessionFrom(record);
    return Object.freeze({ session: issued, availableTenants: record.availableTenants });
  }

  async processNextDelivery(): Promise<boolean> {
    if (!this.deliveryEnabled) return false;
    const leaseOwner = randomUUID();
    const claim = await this.store.claimNextMail(leaseOwner);
    if (!claim) return false;
    const token = deriveMagicLinkToken(claim.linkId, this.environment.portalSessionRecoveryKey);
    const confirmationUrl = new URL('/api/v1/auth/magic-links/confirm', this.confirmationOrigin);
    confirmationUrl.searchParams.set('token', token);
    try {
      await this.mailTransport.send({
        recipient: claim.recipient,
        confirmationUrl: confirmationUrl.toString(),
        subject: 'Your secure portal sign-in link',
      });
    } catch {
      await this.store.markMailFailed(claim.queueId, leaseOwner);
      return true;
    }
    await this.store.markMailDelivered(claim.queueId, leaseOwner);
    return true;
  }

  localInboxMessages(): readonly LocalInboxMessage[] {
    if (!(this.mailTransport instanceof LocalMagicLinkInbox)) return Object.freeze([]);
    return this.mailTransport.list();
  }

  getConfirmationOrigin(): string {
    return this.confirmationOrigin;
  }
}
