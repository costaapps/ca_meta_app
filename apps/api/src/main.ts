import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';
import { ApiModule } from './app.module.js';
import { EnvironmentValidationError, validateEnvironment } from './config/environment.js';
import { configureHttpBoundaries } from './http-boundaries.js';

function writeStartupError(event: string, fields?: readonly string[]): void {
  process.stderr.write(`${JSON.stringify({ level: 'error', event, ...(fields ? { fields } : {}) })}\n`);
}

export async function bootstrap(): Promise<void> {
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  try {
    const environment = validateEnvironment(process.env);
    app = await NestFactory.create(ApiModule.register(environment), { bodyParser: false, bufferLogs: true });
    configureHttpBoundaries(app, environment);
    app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
    await app.init();

    const server = app.getHttpServer() as Server;
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
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
