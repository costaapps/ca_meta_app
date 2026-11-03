import 'reflect-metadata';
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NEVER, Observable, takeUntil, tap } from 'rxjs';
import { Test } from '@nestjs/testing';
import type { ApiEnvironment } from '../../src/config/environment.js';
import { ApiModule } from '../../src/app.module.js';
import { GracefulExpressAdapter } from '../../src/http/graceful-express-adapter.js';
import { DATABASE_READINESS_PORT, type DatabaseReadinessPort } from '../../src/database/database-readiness.port.js';
import { REQUEST_DRAIN, type RequestDrain, getRequestWorkContext } from '../../src/common/http/request-drain.js';
import { PublicRoute } from '../../src/common/security/public-route.decorator.js';
import { configureHttpBoundaries } from '../../src/http-boundaries.js';
import { registerGracefulShutdown } from '../../src/main.js';
import { RequireCancellationAcknowledgement } from '../../src/common/http/request-drain.interceptor.js';

const DRAIN_STATE = Symbol('DRAIN_STATE');
const ipc = process as NodeJS.Process & { send(message: unknown): boolean; connected: boolean };

function notifyParent(message: unknown): void {
  if (!ipc.connected) return;
  try { ipc.send(message); } catch { /* The fixture may already be disconnecting. */ }
}

class DrainState {
  private releaseWait!: () => void;
  private readonly waiting = new Promise<void>((resolve) => { this.releaseWait = resolve; });

  release(): void {
    this.releaseWait();
  }

  async waitForRelease(): Promise<void> {
    await this.waiting;
  }
}

@Controller()
class DrainController {
  constructor(@Inject(DRAIN_STATE) private readonly state: DrainState) {}

  @Get('/probe/in-flight')
  @PublicRoute()
  async inFlight(@Res() response: Response): Promise<void> {
    response.status(200);
    response.setHeader('Content-Type', 'application/json');
    response.write('{"started":true,');
    notifyParent({ type: 'request-started' });
    await this.state.waitForRelease();
    notifyParent({ type: 'handler-released' });
    if (!response.destroyed) response.end('"completed":true}');
  }

  @Get('/probe/response-before-handler')
  @PublicRoute()
  async responseBeforeHandler(@Res() response: Response): Promise<void> {
    response.status(200).json({ completed: false });
    await this.state.waitForRelease();
    notifyParent({ type: 'handler-released' });
  }

  @Get('/probe/observable-takeuntil')
  @PublicRoute()
  @RequireCancellationAcknowledgement()
  async observableTakeUntil(@Req() request: Request): Promise<Observable<never>> {
    const work = getRequestWorkContext(request);
    if (!work) throw new Error('request work context missing');
    notifyParent({ type: 'observable-takeuntil-started' });
    const abort$ = new Observable<void>((subscriber) => {
      const onAbort = (): void => {
        notifyParent({ type: 'observable-takeuntil-cleanup-started' });
        const cleanup = setTimeout(() => {
          const accepted = work.acknowledgeCancellation();
          notifyParent({ type: 'observable-takeuntil-cleanup-ack', accepted });
        }, 300);
        cleanup.ref();
        subscriber.next();
        subscriber.complete();
      };
      work.signal.addEventListener('abort', onAbort, { once: true });
      if (work.signal.aborted) onAbort();
      return () => work.signal.removeEventListener('abort', onAbort);
    });
    return NEVER.pipe(
      takeUntil(abort$),
      tap({ complete: () => notifyParent({ type: 'observable-takeuntil-completed' }) }),
    );
  }

  @Get('/probe/observable-cancel')
  @PublicRoute()
  observableCancel(@Req() request: Request): Observable<never> {
    return new Observable<never>(() => {
      const work = getRequestWorkContext(request);
      notifyParent({ type: 'observable-started' });
      const acceptedEarlyAck = work?.acknowledgeCancellation() ?? false;
      notifyParent({ type: 'observable-early-ack', accepted: acceptedEarlyAck });
      return () => {
        notifyParent({ type: 'observable-unsubscribed' });
        const acknowledgeAfterCleanup = (): void => {
          const cleanup = setTimeout(() => {
            const acknowledged = work?.acknowledgeCancellation() ?? false;
            notifyParent({ type: acknowledged ? 'observable-cancel-ack' : 'observable-cancel-ack-rejected' });
          }, 250);
          cleanup.ref();
        };
        if (work?.signal.aborted) acknowledgeAfterCleanup();
        else work?.signal.addEventListener('abort', acknowledgeAfterCleanup, { once: true });
      };
    });
  }
}

const environment: ApiEnvironment = {
  nodeEnv: 'test',
  port: 0,
  bindAddress: '127.0.0.1',
  allowedHosts: ['127.0.0.1'],
  allowedOrigins: ['http://127.0.0.1'],
  suite4EmbedOrigins: [],
  trustedProxyCidrs: false,
  portalSessionRecoveryKey: 'synthetic-test-session-recovery-key-32-bytes-minimum',
  portalSessionIdleTimeoutSeconds: 1800,
  portalSessionAbsoluteTimeoutSeconds: 28800,
  database: {
    host: '127.0.0.1',
    port: 3306,
    name: 'synthetic_test',
    user: 'synthetic_test',
    password: 'synthetic-test-password',
    connectTimeoutMs: 250,
  },
};

async function main(): Promise<void> {
  const state = new DrainState();
  const module = await Test.createTestingModule({
    imports: [ApiModule.register(environment)],
    controllers: [DrainController],
    providers: [{ provide: DRAIN_STATE, useValue: state }],
  })
    .overrideProvider(DATABASE_READINESS_PORT)
    .useValue({ check: async () => undefined } satisfies DatabaseReadinessPort)
    .compile();
  const app = module.createNestApplication(new GracefulExpressAdapter(), { bodyParser: false });
  app.use((_request: unknown, response: Response, next: () => void) => {
    response.once('finish', () => notifyParent({ type: 'response-finished' }));
    response.once('close', () => notifyParent({
      type: 'response-closed',
      writableFinished: response.writableFinished,
    }));
    next();
  });
  configureHttpBoundaries(app, environment);
  const server = app.getHttpServer() as import('node:http').Server;
  const drain = app.get<RequestDrain>(REQUEST_DRAIN);
  const waitForActiveRequests = drain.waitForActiveRequests.bind(drain);
  drain.waitForActiveRequests = async (): Promise<void> => {
    notifyParent({ type: 'drain-wait-started' });
    await waitForActiveRequests();
    notifyParent({ type: 'drain-wait-finished' });
  };
  server.once('close', () => notifyParent({ type: 'server-closed' }));
  const closeApplication = app.close.bind(app);
  app.close = async (): Promise<void> => {
    notifyParent({ type: 'app-close-started' });
    await closeApplication();
    notifyParent({ type: 'app-close-finished' });
  };
  registerGracefulShutdown(app, drain, server);
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'release') {
      notifyParent({ type: 'release-received' });
      state.release();
    }
  });
  process.on('SIGTERM', () => notifyParent({ type: 'signal-received', signal: 'SIGTERM' }));
  process.on('SIGINT', () => notifyParent({ type: 'signal-received', signal: 'SIGINT' }));
  await app.init();
  await app.listen(0, environment.bindAddress);
  const address = app.getHttpServer().address() as { readonly port: number };
  notifyParent({ type: 'listening', port: address.port });
}

void main().catch(() => {
  notifyParent({ type: 'startup-failed' });
  process.exitCode = 1;
});
