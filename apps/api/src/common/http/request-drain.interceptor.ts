import { Inject, Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs';
import type { Observable } from 'rxjs';
import { REQUEST_DRAIN, RequestDrain } from './request-drain.js';

@Injectable()
export class RequestDrainInterceptor implements NestInterceptor {
  constructor(@Inject(REQUEST_DRAIN) private readonly requestDrain: RequestDrain) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<import('express').Request>();
    const handlerSettled = this.requestDrain.beginHandler(request);
    return next.handle().pipe(
      tap({
        error: () => handlerSettled(),
        complete: () => handlerSettled(),
      }),
    );
  }
}
