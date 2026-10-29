import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { errorEnvelope } from './error-envelope.js';

export const REQUEST_DRAIN = Symbol('REQUEST_DRAIN');
export const REQUEST_WORK_CONTEXT = Symbol('REQUEST_WORK_CONTEXT');
export const DRAIN_WARNING_INTERVAL_MS = 30_000;

export interface RequestWorkContext {
  readonly signal: AbortSignal;
  acknowledgeCancellation(): boolean;
}

type DrainRequest = Request & { [REQUEST_WORK_CONTEXT]?: RequestWorkContext };

interface ActiveRequest {
  readonly response: Response;
  handlerSettled: boolean;
  responseFinished: boolean;
  responseClosed: boolean;
  released: boolean;
  completeHandler?: () => void;
}

interface DrainWaiter {
  readonly resolve: () => void;
  readonly warningTimer: NodeJS.Timeout;
}

export function getRequestWorkContext(request: Request): RequestWorkContext | undefined {
  return (request as DrainRequest)[REQUEST_WORK_CONTEXT];
}

export class RequestDrain {
  private readonly requestStates = new WeakMap<Request, ActiveRequest>();
  private readonly activeRequests = new Set<ActiveRequest>();
  private draining = false;
  private readonly drainWaiters: DrainWaiter[] = [];

  middleware(): RequestHandler {
    return (
      request: DrainRequest & { requestId?: string },
      response: Response,
      next: NextFunction,
    ): void => {
      if (this.draining) {
        response.status(503).json(
          errorEnvelope(
            'DEPENDENCY_UNAVAILABLE',
            'The operation could not be confirmed yet.',
            request.requestId ?? 'unknown',
            true,
            'CHECK_STATUS',
          ),
        );
        return;
      }

      const abortController = new AbortController();
      let state: ActiveRequest;
      const workContext: RequestWorkContext = Object.freeze({
        signal: abortController.signal,
        acknowledgeCancellation: () => {
          if (!abortController.signal.aborted) return false;
          state.handlerSettled = true;
          this.releaseIfSettled(state);
          return true;
        },
      });
      Object.defineProperty(request, REQUEST_WORK_CONTEXT, {
        configurable: false,
        enumerable: false,
        value: workContext,
      });
      state = {
        response,
        handlerSettled: true,
        responseFinished: false,
        responseClosed: false,
        released: false,
      };
      this.requestStates.set(request, state);
      this.activeRequests.add(state);

      response.once('finish', () => {
        state.responseFinished = true;
        this.releaseIfSettled(state);
      });
      response.once('close', () => {
        state.responseClosed = true;
        if (!response.writableFinished) abortController.abort();
        else state.responseFinished = true;
        this.releaseIfSettled(state);
      });
      next();
    };
  }

  beginHandler(request: Request): () => void {
    const state = this.requestStates.get(request);
    if (!state || state.released) return () => undefined;
    if (state.completeHandler) return state.completeHandler;

    state.handlerSettled = false;
    let settled = false;
    state.completeHandler = (): void => {
      if (settled) return;
      settled = true;
      state.handlerSettled = true;
      this.releaseIfSettled(state);
    };
    return state.completeHandler;
  }

  stopAdmissions(): void {
    this.draining = true;
    for (const active of this.activeRequests) {
      active.response.shouldKeepAlive = false;
      if (!active.response.headersSent) active.response.setHeader('Connection', 'close');
    }
  }

  async waitForActiveRequests(): Promise<void> {
    if (this.activeRequests.size === 0) return;
    await new Promise<void>((resolve) => {
      const warningTimer = setInterval(() => {
        process.stderr.write(
          JSON.stringify({
            level: 'warn',
            event: 'api.shutdown_waiting',
            activeRequests: this.activeRequests.size,
          }) + '\n',
        );
      }, DRAIN_WARNING_INTERVAL_MS);
      warningTimer.ref();
      this.drainWaiters.push({ resolve, warningTimer });
    });
  }

  async stopAdmissionsAndWait(): Promise<void> {
    this.stopAdmissions();
    await this.waitForActiveRequests();
  }

  private releaseIfSettled(state: ActiveRequest): void {
    if (state.released || (!state.responseFinished && !state.responseClosed) || !state.handlerSettled) {
      return;
    }
    state.released = true;
    this.activeRequests.delete(state);
    if (this.draining && this.activeRequests.size === 0) {
      for (const waiter of this.drainWaiters.splice(0)) {
        clearInterval(waiter.warningTimer);
        waiter.resolve();
      }
    }
  }
}
