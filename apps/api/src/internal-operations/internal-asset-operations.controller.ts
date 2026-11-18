import { BadRequestException, ConflictException, Controller, Get, Headers, HttpCode, HttpStatus, NotFoundException,
  Param, ParseUUIDPipe, Post, Body, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PublicRoute } from '../common/security/public-route.decorator.js';
import { InternalAssetOperationsService } from './internal-asset-operations.service.js';
import {
  InternalAssetOperationIdempotencyConflictError,
  InternalAssetOperationInputError,
  InternalAssetOperationUnavailableError,
  parseInternalAssetOperation,
} from './internal-operations.validation.js';

@Controller()
export class InternalAssetOperationsController {
  constructor(private readonly operations: InternalAssetOperationsService) {}

  @Post('/internal/v2/assets/:assetId/operations')
  @HttpCode(HttpStatus.ACCEPTED)
  @PublicRoute()
  async execute(
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    try {
      const payload = parseInternalAssetOperation(body);
      return await this.operations.execute({ authorization, assetId, idempotencyKey, payload });
    } catch (error) {
      if (error instanceof InternalAssetOperationInputError) throw new BadRequestException();
      if (error instanceof InternalAssetOperationIdempotencyConflictError) throw new ConflictException();
      if (error instanceof InternalAssetOperationUnavailableError) throw new ServiceUnavailableException();
      if (error instanceof InternalAssetOperationInputError) throw new BadRequestException();
      if (error instanceof UnauthorizedException || error instanceof ConflictException || error instanceof BadRequestException ||
          error instanceof ServiceUnavailableException) throw error;
      throw error;
    }
  }

  @Get('/internal/v2/operations/:operationId')
  @PublicRoute()
  async status(
    @Param('operationId', new ParseUUIDPipe({ version: '4' })) operationId: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    try {
      const result = await this.operations.status({ authorization, operationId });
      if (!result) throw new NotFoundException();
      return result;
    } catch (error) {
      if (error instanceof InternalAssetOperationUnavailableError) throw new ServiceUnavailableException();
      if (error instanceof InternalAssetOperationInputError) throw new BadRequestException();
      throw error;
    }
  }
}
