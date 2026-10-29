import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Observable as ObservableType } from 'rxjs';
import { REQUEST_DRAIN, RequestDrain } from './request-drain.js';

export const REQUIRE_CANCELLATION_ACK = Symbol('REQUIRE_CANCELLATION_ACK');

export function RequireCancellationAcknowledgement(): MethodDecorator {
  return SetMetadata(REQUIRE_CANCELLATION_ACK, true);
}

export function requiresCancellationAcknowledgement(
  handler: Function,
  prototype?: object,
): boolean {
  if (Reflect.getMetadata(REQUIRE_CANCELLATION_ACK, handler) === true) return true;
  const hasReturnType = prototype
    ? Reflect.hasMetadata('design:returntype', prototype, handler.name)
    : Reflect.hasMetadata('design:returntype', handler);
  if (!hasReturnType) return true;
  const returnType = prototype
    ? Reflect.getMetadata('design:returntype', prototype, handler.name)
    : Reflect.getMetadata('design:returntype', handler);
  return returnType === Observable;
}

@Injectable()
export class RequestDrainInterceptor implements NestInterceptor {
  constructor(@Inject(REQUEST_DRAIN) private readonly requestDrain: RequestDrain) {}

  intercept(context: ExecutionContext, next: CallHandler): ObservableType<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<import('express').Request>();
    const handlerSettled = this.requestDrain.beginHandler(
      request,
      requiresCancellationAcknowledgement(context.getHandler(), context.getClass().prototype),
    );
    return next.handle().pipe(
      tap({
        error: () => handlerSettled(),
        complete: () => handlerSettled(),
      }),
    );
  }
}
