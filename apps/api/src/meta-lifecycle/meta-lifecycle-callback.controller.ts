import { Controller, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { META_WEBHOOK_APP_CONFIG_REF_PATTERN } from '../meta-webhooks/meta-webhook-validation.js';
import {
  MetaLifecycleCallbackIngressService,
  MetaLifecycleCallbackSignatureError,
  MetaLifecycleCallbackUnavailableError,
} from './meta-lifecycle-callback.service.js';

@Controller('/webhooks/meta-lifecycle')
export class MetaLifecycleCallbackController {
  constructor(private readonly callbacks: MetaLifecycleCallbackIngressService) {}

  /** Raw-body callback route; returns unavailable until a verified current Meta adapter is installed. */
  @Post(':appConfigRef')
  @PublicRoute()
  async receive(
    @Param('appConfigRef') appConfigurationRef: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (!META_WEBHOOK_APP_CONFIG_REF_PATTERN.test(appConfigurationRef) || !Buffer.isBuffer(request.body)) {
      response.status(HttpStatus.BAD_REQUEST).json({ received: false });
      return;
    }
    try {
      const result = await this.callbacks.receive({ appConfigurationRef, rawBody: request.body });
      response.status(HttpStatus.OK).json({ received: result.accepted, result: result.result });
    } catch (error) {
      if (error instanceof MetaLifecycleCallbackSignatureError) {
        response.status(HttpStatus.FORBIDDEN).json({ received: false });
        return;
      }
      if (error instanceof MetaLifecycleCallbackUnavailableError) {
        response.status(HttpStatus.SERVICE_UNAVAILABLE).json({ received: false });
        return;
      }
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({ received: false });
    }
  }
}
