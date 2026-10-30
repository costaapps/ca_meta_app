import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { ApiModule } from './app.module.js';
import { EnvironmentValidationError, validateEnvironment } from './config/environment.js';
import { REQUEST_DRAIN, type RequestDrain } from './common/http/request-drain.js';
import { GracefulExpressAdapter } from './http/graceful-express-adapter.js';
import { configureHttpBoundaries } from './http-boundaries.js';

function writeStartupError(event: string, fields?: readonly string[]): void {
  process.stderr.write(`${JSON.stringify({ level: 'error', event, ...(fields ? { fields } : {}) })}\n`);
}

function stopListening(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (error && code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function registerGracefulShutdown(
  app: Pick<INestApplication, 'close'>,
  requestDrain: RequestDrain,
  server: Server,
): void {
  let shuttingDown = false;
  const shutdown = (_signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    requestDrain.stopAdmissions();
    void requestDrain.waitForActiveRequests()
      .then(() => stopListening(server))
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => app.close())
      .catch(() => {
        writeStartupError('api.shutdown_failed');
        process.exitCode = 1;
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export async function bootstrap(): Promise<void> {
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  try {
    const environment = validateEnvironment(process.env);
    app = await NestFactory.create(
      ApiModule.register(environment),
      new GracefulExpressAdapter(),
      { bodyParser: false, bufferLogs: true },
    );
    configureHttpBoundaries(app, environment);
    const server = app.getHttpServer() as Server;
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    registerGracefulShutdown(app, app.get<RequestDrain>(REQUEST_DRAIN), server);
    await app.init();

    await app.listen(environment.port, environment.bindAddress);
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : environment.port;
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'api.started', port })}\n`);
  } catch (error) {
    if (error instanceof EnvironmentValidationError) {
      writeStartupError('configuration.invalid', error.fieldNames);
    } else {
      writeStartupError('api.startup_failed');
    }
    if (app) await app.close().catch(() => undefined);
    process.exitCode = 1;
  }
}

if (require.main === module) void bootstrap();