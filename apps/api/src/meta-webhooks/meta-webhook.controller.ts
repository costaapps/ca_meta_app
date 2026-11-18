import { Controller, Get, HttpStatus, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import {
  MetaWebhookChallengeError,
  MetaWebhookConfigurationUnavailableError,
  MetaWebhookIngressService,
  MetaWebhookSignatureError,
} from './meta-webhook-ingress.service.js';
import { MetaWebhookPayloadValidationError } from './meta-webhook-validation.js';
import { OBSERVABILITY_REGISTRY, type ObservabilityRegistry, type WebhookOutcome } from '../observability/observability.registry.js';
import { observedRequestDurationMs } from '../common/http/request-context.js';

function oneQueryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 512 ? value : undefined;
}

@Controller('/webhooks/meta')
export class MetaWebhookController {
  constructor(private readonly ingress: MetaWebhookIngressService,
    @Inject(OBSERVABILITY_REGISTRY) private readonly observability: ObservabilityRegistry) {}

  @Get(':appConfigRef')
  @PublicRoute()
  async verifyChallenge(
    @Param('appConfigRef') appConfigRef: string,
    @Query('hub.mode') mode: unknown,
    @Query('hub.verify_token') verifyToken: unknown,
    @Query('hub.challenge') challenge: unknown,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const result = await this.ingress.challenge({
        appConfigRef,
        mode: oneQueryString(mode),
        verifyToken: oneQueryString(verifyToken),
        challenge: oneQueryString(challenge),
      });
      response.status(HttpStatus.OK).type('text/plain').send(result);
    } catch (error) {
      const status = error instanceof MetaWebhookConfigurationUnavailableError ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.FORBIDDEN;
      response.status(status).type('text/plain').send('Webhook verification failed.');
    }
  }

  @Post(':appConfigRef')
  @PublicRoute()
  async receive(
    @Param('appConfigRef') appConfigRef: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (!request.is('application/json') || !Buffer.isBuffer(request.body)) {
      this.respond(response, request, 'invalid_content_type', HttpStatus.UNSUPPORTED_MEDIA_TYPE, { received: false });
      return;
    }
    try {
      const result = await this.ingress.ingest({
        appConfigRef,
        rawBody: request.body,
        signature: request.get('x-hub-signature-256'),
      });
      // HTTP success is emitted only after the durable inbox transaction commits.
      this.respond(response, request, 'accepted', HttpStatus.OK, { received: true, items: result.received }, result);
    } catch (error) {
      if (error instanceof MetaWebhookSignatureError) {
        this.respond(response, request, 'signature_rejected', HttpStatus.FORBIDDEN, { received: false });
        return;
      }
      if (error instanceof MetaWebhookConfigurationUnavailableError) {
        this.respond(response, request, 'configuration_unavailable', HttpStatus.SERVICE_UNAVAILABLE, { received: false });
        return;
      }
      if (error instanceof MetaWebhookPayloadValidationError) {
        this.respond(response, request, 'payload_rejected', HttpStatus.BAD_REQUEST, { received: false });
        return;
      }
      if (error instanceof MetaWebhookChallengeError) {
        this.respond(response, request, 'signature_rejected', HttpStatus.FORBIDDEN, { received: false });
        return;
      }
      this.respond(response, request, 'ingress_failure', HttpStatus.SERVICE_UNAVAILABLE, { received: false });
    }
  }

  private respond(
    response: Response,
    request: Request,
    outcome: WebhookOutcome,
    status: number,
    body: Readonly<Record<string, unknown>>,
    itemCounts?: { readonly received: number; readonly inserted: number; readonly duplicate: number; readonly quarantined: number },
  ): void {
    response.once('finish', () => {
      const durationMs = observedRequestDurationMs(request);
      // Without the early request-context middleware, omit the latency/ACK sample rather than
      // claiming a controller-only duration as an end-to-end ingress measurement.
      if (durationMs !== undefined) this.observability.recordWebhookRequest(outcome, durationMs, itemCounts);
    });
    response.status(status).json(body);
  }
}
