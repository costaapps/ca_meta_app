import { Controller, Get, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import {
  MetaWebhookChallengeError,
  MetaWebhookConfigurationUnavailableError,
  MetaWebhookIngressService,
  MetaWebhookSignatureError,
} from './meta-webhook-ingress.service.js';
import { MetaWebhookPayloadValidationError } from './meta-webhook-validation.js';

function oneQueryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 512 ? value : undefined;
}

@Controller('/webhooks/meta')
export class MetaWebhookController {
  constructor(private readonly ingress: MetaWebhookIngressService) {}

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
      response.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).json({ received: false });
      return;
    }
    try {
      const result = await this.ingress.ingest({
        appConfigRef,
        rawBody: request.body,
        signature: request.get('x-hub-signature-256'),
      });
      // HTTP success is emitted only after the durable inbox transaction commits.
      response.status(HttpStatus.OK).json({ received: true, items: result.received });
    } catch (error) {
      if (error instanceof MetaWebhookSignatureError) {
        response.status(HttpStatus.FORBIDDEN).json({ received: false });
        return;
      }
      if (error instanceof MetaWebhookConfigurationUnavailableError) {
        response.status(HttpStatus.SERVICE_UNAVAILABLE).json({ received: false });
        return;
      }
      if (error instanceof MetaWebhookPayloadValidationError) {
        response.status(HttpStatus.BAD_REQUEST).json({ received: false });
        return;
      }
      if (error instanceof MetaWebhookChallengeError) {
        response.status(HttpStatus.FORBIDDEN).json({ received: false });
        return;
      }
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({ received: false });
    }
  }
}
