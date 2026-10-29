import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { errorEnvelope } from './error-envelope.js';

export const REQUEST_DRAIN = Symbol('REQUEST_DRAIN');

interface ActiveRequest {
  readonly response: Response;
  readonly release: () => void;
}

export class RequestDrain {
  private readonly activeRequests = new Set<ActiveRequest>();
  private draining = false;
  private readonly drainWaiters: Array<() => void> = [];

  middleware(): RequestHandler {
    return (
      request: Request & { requestId?: string },
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

      let released = false;
      let activeRequest: ActiveRequest;
      const release = (): void => {
        if (released) return;
        released = true;
        this.activeRequests.delete(activeRequest);
        if (this.draining && this.activeRequests.size === 0) {
          for (const resolve of this.drainWaiters.splice(0)) resolve();
        }
      };
      activeRequest = { response, release };
      this.activeRequests.add(activeRequest);
      response.once('finish', () => {
        if (!this.draining) release();
      });
      response.once('close', release);
      next();
    };
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
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  async stopAdmissionsAndWait(): Promise<void> {
    this.stopAdmissions();
    await this.waitForActiveRequests();
  }
}