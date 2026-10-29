import 'reflect-metadata';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ApiEnvironment } from '../../src/config/environment.js';
import { ApiModule } from '../../src/app.module.js';
import { GracefulExpressAdapter } from '../../src/http/graceful-express-adapter.js';
import { DATABASE_READINESS_PORT, type DatabaseReadinessPort } from '../../src/database/database-readiness.port.js';
import { REQUEST_DRAIN, type RequestDrain } from '../../src/common/http/request-drain.js';
import { PublicRoute } from '../../src/common/security/public-route.decorator.js';
import { configureHttpBoundaries } from '../../src/http-boundaries.js';
import { registerGracefulShutdown } from '../../src/main.js';

const DRAIN_STATE = Symbol('DRAIN_STATE');
const ipc = process as NodeJS.Process & { send(message: unknown): boolean };

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
  async inFlight(@Res() response: import('express').Response): Promise<void> {
    response.status(200);
    response.setHeader('Content-Type', 'application/json');
    response.write('{"started":true,');
    ipc.send({ type: 'request-started' });
    await this.state.waitForRelease();
    ipc.send({ type: 'handler-released' });
    response.end('"completed":true}');
  }
}

const environment: ApiEnvironment = {
  nodeEnv: 'test',
  port: 0,
  bindAddress: '127.0.0.1',
  allowedHosts: ['127.0.0.1'],
  trustedProxyCidrs: false,
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
  app.use((_request: unknown, response: import('express').Response, next: () => void) => {
    response.once('finish', () => ipc.send({ type: 'response-finished' }));
    next();
  });
  configureHttpBoundaries(app, environment);
  const server = app.getHttpServer() as import('node:http').Server;
  registerGracefulShutdown(app, app.get<RequestDrain>(REQUEST_DRAIN), server);
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'release') {
      ipc.send({ type: 'release-received' });
      state.release();
    }
  });
  process.on('SIGTERM', () => ipc.send({ type: 'signal-received', signal: 'SIGTERM' }));
  process.on('SIGINT', () => ipc.send({ type: 'signal-received', signal: 'SIGINT' }));
  await app.init();
  await app.listen(0, environment.bindAddress);
  const address = app.getHttpServer().address() as { readonly port: number };
  ipc.send({ type: 'listening', port: address.port });
}

void main().catch(() => {
  ipc.send({ type: 'startup-failed' });
  process.exitCode = 1;
});