import { BadRequestException, Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { TicketExchangeService } from './ticket-exchange.service.js';

interface RequestWithId extends Request {
  requestId?: string;
}

@Controller('auth/exchanges')
export class TicketExchangeController {
  constructor(private readonly exchanges: TicketExchangeService) {}

  @Post()
  @PublicRoute()
  exchange(
    @Body() body: unknown,
    @Req() request: RequestWithId,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (request.originalUrl.includes('?')) throw new BadRequestException();
    return this.exchanges.exchange(
      body,
      { headers: request.headers, requestId: request.requestId, clientIp: request.ip },
      response,
    );
  }
}
