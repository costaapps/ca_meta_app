import 'reflect-metadata';
import { Body, Controller, Get, Inject, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString, MaxLength } from 'class-validator';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { ApiModule } from '../src/app.module.js';
import { GracefulExpressAdapter } from '../src/http/graceful-express-adapter.js';
import { DATABASE_READINESS_PORT, type DatabaseReadinessPort } from '../src/database/database-readiness.port.js';
import type { ApiEnvironment } from '../src/config/environment.js';
import { STRUCTURED_LOGGER, type StructuredLogRecord, type StructuredLogger } from '../src/common/http/request-context.js';
import { PublicRoute } from '../src/common/security/public-route.decorator.js';
import { configureHttpBoundaries } from '../src/http-boundaries.js';
import { CLOCK, type MonotonicClock } from '../src/common/time/clock.port.js';

const PROBE_STATE = Symbol('PROBE_STATE');

interface ProbeState {
  signalStarted(): void;
  readonly started: Promise<void>;
  waitForRelease(): Promise<void>;
  release(): void;
}

class ProbeStateValue implements ProbeState {
  private resolveStarted!: () => void;
  private resolveRelease!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.resolveRelease = resolve;
  });

  signalStarted(): void {
    this.resolveStarted();
  }

  async waitForRelease(): Promise<void> {
    await this.released;
  }

  release(): void {
    this.resolveRelease();
  }
}

class FakeMonotonicClock implements MonotonicClock {
  private tick = 0;

  now(): number {
    return this.tick;
  }

  advance(milliseconds: number): void {
    this.tick += milliseconds;
  }
}

class ProbeDto {
  @IsString()
  @MaxLength(16)
  value!: string;
}

class CapturingLogger implements StructuredLogger {
  readonly records: StructuredLogRecord[] = [];

  write(record: StructuredLogRecord): void {
    this.records.push(record);
  }
}

class FakeDatabaseReadiness implements DatabaseReadinessPort {
  available = false;
  checks = 0;
  private nextGate: {
    readonly started: Promise<void>;
    readonly signalStarted: () => void;
    readonly waiting: Promise<void>;
    readonly release: () => void;
  } | undefined;

  blockNextCheck(): { readonly started: Promise<void>; readonly release: () => void } {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    this.nextGate = { started, signalStarted, waiting, release };
    return { started, release };
  }

  async check(): Promise<void> {
    this.checks += 1;
    const gate = this.nextGate;
    if (gate) {
      this.nextGate = undefined;
      gate.signalStarted();
      await gate.waiting;
    }
    if (!this.available) throw new Error('synthetic database diagnostic secret');
  }
}

@Controller('probe')
class BoundaryProbeController {
  constructor(@Inject(PROBE_STATE) private readonly state: ProbeState) {}

  @Post('validation')
  @PublicRoute()
  validate(@Body() body: ProbeDto): { readonly accepted: true; readonly value: string } {
    return { accepted: true, value: body.value };
  }

  @Get('failure')
  @PublicRoute()
  fail(): never {
    throw new Error('synthetic-marker-password-should-never-leak');
  }

  @Get('in-flight')
  @PublicRoute()
  async inFlight(): Promise<{ readonly completed: true }> {
    this.state.signalStarted();
    await this.state.waitForRelease();
    return { completed: true };
  }

  @Get('private')
  privateRoute(): { readonly reachable: true } {
    return { reachable: true };
  }
}

const TEST_ENVIRONMENT: ApiEnvironment = {
  nodeEnv: 'test',
  port: 0,
  bindAddress: '127.0.0.1',
  allowedHosts: ['127.0.0.1', 'localhost'],
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

function rawGet(
  url: string,
  host: string | undefined,
): Promise<{ readonly status: number; readonly headers: import('node:http').IncomingHttpHeaders; readonly body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: 'GET',
      setHost: false,
      headers: host === undefined ? { connection: 'close' } : { host, connection: 'close' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

const childMessageHistory = new WeakMap<
  import('node:child_process').ChildProcess,
  Record<string, unknown>[]
>();
const childMessageCursor = new WeakMap<import('node:child_process').ChildProcess, number>();

function waitForChildMessage(
  child: import('node:child_process').ChildProcess,
  type: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  let history = childMessageHistory.get(child);
  if (!history) {
    history = [];
    childMessageHistory.set(child, history);
    child.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'type' in message) {
        history?.push(message as Record<string, unknown>);
      }
    });
  }
  const cursor = childMessageCursor.get(child) ?? 0;
  const cachedIndex = history.findIndex((entry, index) => index >= cursor && entry.type === type);
  if (cachedIndex >= 0) {
    childMessageCursor.set(child, cachedIndex + 1);
    return Promise.resolve(history[cachedIndex]);
  }
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, entry?: Record<string, unknown>): void => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(entry ?? {});
    };
    const timeout = setTimeout(
      () => finish(new Error(
        'Timed out waiting for child message ' + type + '; observed: ' +
        (history?.map((entry) => String(entry.type)).join(', ') || 'none') + '.',
      )),
      timeoutMs,
    );
    const onMessage = (message: unknown): void => {
      if (typeof message === 'object' && message !== null && 'type' in message) {
        const entry = message as Record<string, unknown>;
        if (entry.type === type) {
          const matchedIndex = history?.findIndex((candidate, index) => index >= cursor && candidate.type === type) ?? -1;
          if (matchedIndex >= 0) childMessageCursor.set(child, matchedIndex + 1);
          finish(undefined, entry);
        } else if (entry.type === 'startup-failed') {
          finish(new Error('Signal-drain child failed to start.'));
        }
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error('Signal-drain child exited before ' + type + ': ' + (code ?? signal) + '.'));
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}
async function startBoundaryApp(): Promise<{
  readonly baseUrl: string;
  readonly app: INestApplication;
  readonly database: FakeDatabaseReadiness;
  readonly logger: CapturingLogger;
  readonly state: ProbeStateValue;
  readonly clock: FakeMonotonicClock;
}> {
  const database = new FakeDatabaseReadiness();
  const logger = new CapturingLogger();
  const state = new ProbeStateValue();
  const clock = new FakeMonotonicClock();
  const module = await Test.createTestingModule({
    imports: [ApiModule.register(TEST_ENVIRONMENT)],
    controllers: [BoundaryProbeController],
    providers: [{ provide: PROBE_STATE, useValue: state }],
  })
    .overrideProvider(DATABASE_READINESS_PORT)
    .useValue(database)
    .overrideProvider(STRUCTURED_LOGGER)
    .useValue(logger)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();

  const app = module.createNestApplication(new GracefulExpressAdapter(), { bodyParser: false });
  configureHttpBoundaries(app, TEST_ENVIRONMENT);
  await app.init();
  await app.listen(0, TEST_ENVIRONMENT.bindAddress);
  const address = app.getHttpServer().address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, app, database, logger, state, clock };
}

test('configuration validation requires typed fields, reports names only, and rejects remote test DBs', async (t) => {
  const { EnvironmentValidationError, validateEnvironment } = await import('../src/config/environment.js');
  const valid = {
    NODE_ENV: 'test',
    API_PORT: '0',
    API_BIND_ADDRESS: '127.0.0.1',
    API_ALLOWED_HOSTS: '127.0.0.1,localhost',
    API_TRUSTED_PROXIES: 'none',
    API_DATABASE_HOST: '127.0.0.1',
    API_DATABASE_PORT: '3306',
    API_DATABASE_NAME: 'synthetic_test',
    API_DATABASE_USER: 'synthetic_user',
    API_DATABASE_PASSWORD: 'synthetic-marker-value',
    API_DATABASE_CONNECT_TIMEOUT_MS: '250',
  };

  await t.test('accepts a complete explicit configuration', () => {
    const parsed = validateEnvironment(valid);
    assert.equal(parsed.port, 0);
    assert.equal(parsed.database.host, '127.0.0.1');
    assert.equal(parsed.trustedProxyCidrs, false);
    assert.deepEqual(parsed.allowedHosts, ['127.0.0.1', 'localhost']);
    assert.equal(parsed.database.password, 'synthetic-marker-value');
    assert.equal(validateEnvironment({ ...valid, API_DATABASE_PASSWORD: '  preserved password  ' }).database.password, '  preserved password  ');
  });

  await t.test('reports absent and malformed field names without values', () => {
    const invalid = { ...valid, API_PORT: 'bad-port', API_DATABASE_PASSWORD: 'synthetic-marker-value' };
    delete (invalid as Partial<typeof invalid>).API_DATABASE_USER;
    assert.throws(
      () => validateEnvironment(invalid),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentValidationError);
        assert.ok(error.fieldNames.includes('API_PORT'));
        assert.ok(error.fieldNames.includes('API_DATABASE_USER'));
        assert.ok(!error.message.includes('synthetic-marker-value'));
        return true;
      },
    );
  });

  await t.test('requires a loopback DB, exact Host allowlist, and specific proxy ranges in test', () => {
    assert.throws(() => validateEnvironment({ ...valid, API_DATABASE_HOST: 'db.prod.example' }));
    assert.throws(() => validateEnvironment({ ...valid, API_TRUSTED_PROXIES: '0.0.0.0/99' }));
    for (const wildcard of ['0.0.0.0/0', '::/0', '0:0:0:0:0:0:0:0/0', '::ffff:0:0/96', '0:0:0:0:0:ffff:0:0/96', '*']) {
      assert.throws(() => validateEnvironment({ ...valid, API_TRUSTED_PROXIES: wildcard }), /API_TRUSTED_PROXIES/);
    }
    assert.deepEqual(validateEnvironment({ ...valid, API_TRUSTED_PROXIES: '10.12.0.0/16,2001:db8:1::/64' }).trustedProxyCidrs, ['10.12.0.0/16', '2001:db8:1::/64']);
    assert.throws(() => validateEnvironment({ ...valid, API_ALLOWED_HOSTS: '' }), /API_ALLOWED_HOSTS/);
    assert.throws(() => validateEnvironment({ ...valid, API_ALLOWED_HOSTS: '*.example.test' }), /API_ALLOWED_HOSTS/);
    assert.throws(() => validateEnvironment({ ...valid, API_DATABASE_PASSWORD: '   ' }), /API_DATABASE_PASSWORD/);
  });
});

test('health paths follow the canonical contract and liveness is independent of MariaDB', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const liveness = await fetch(`${context.baseUrl}/health`);
  assert.equal(liveness.status, 200);
  assert.deepEqual(await liveness.json(), { status: 'ok' });
  assert.match(liveness.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/i);
  assert.equal(context.database.checks, 0);

  const legacyLiveAlias = await fetch(`${context.baseUrl}/health/live`);
  const legacyReadyAlias = await fetch(`${context.baseUrl}/health/ready`);
  assert.equal(legacyLiveAlias.status, 404);
  assert.equal(legacyReadyAlias.status, 404);
});

test('Host validation allows exact configured hosts and rejects absent or unknown hosts', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());
  const port = new URL(context.baseUrl).port;

  const valid = await rawGet(`${context.baseUrl}/health`, `LOCALHOST.:${port}`);
  assert.equal(valid.status, 200);
  assert.deepEqual(JSON.parse(valid.body), { status: 'ok' });

  const unknown = await rawGet(`${context.baseUrl}/health`, `unconfigured.example:${port}`);
  assert.equal(unknown.status, 400);
  const unknownBody = JSON.parse(unknown.body) as Record<string, unknown>;
  assert.deepEqual(unknownBody, {
    code: 'ORIGIN_NOT_ALLOWED',
    safeMessage: 'This request host is not allowed.',
    requestId: unknown.headers['x-request-id'],
    retryable: false,
    action: 'CONTACT_ADMIN',
  });

  const absent = await rawGet(`${context.baseUrl}/health`, undefined);
  assert.equal(absent.status, 400);
});

test('the private route is denied and request IDs are returned in headers and error envelopes', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const response = await fetch(`${context.baseUrl}/api/v1/probe/private`, {
    headers: { 'X-Request-Id': 'malformed-request-id' },
  });
  assert.equal(response.status, 401);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, 'AUTH_REQUIRED');
  assert.equal(body.requestId, response.headers.get('x-request-id'));
  assert.match(String(body.requestId), /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  assert.deepEqual(Object.keys(body).sort(), ['action', 'code', 'requestId', 'retryable', 'safeMessage']);
  const requestLog = context.logger.records.find((record) => record.event === 'http.request');
  assert.equal(requestLog?.requestId, response.headers.get('x-request-id'));
  assert.equal(requestLog?.durationMs, 0);
});

test('strict DTO validation rejects extra fields, malformed JSON, and oversized bodies safely', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const valid = await fetch(`${context.baseUrl}/api/v1/probe/validation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'okay' }),
  });
  assert.equal(valid.status, 201);
  assert.deepEqual(await valid.json(), { accepted: true, value: 'okay' });
  assert.ok(valid.headers.get('x-request-id'));

  const extra = await fetch(`${context.baseUrl}/api/v1/probe/validation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'okay', unexpected: 'private-field' }),
  });
  assert.equal(extra.status, 400);
  const extraBody = await extra.text();
  assert.match(extraBody, /VALIDATION_FAILED/);
  assert.doesNotMatch(extraBody, /private-field|unexpected/);

  const malformed = await fetch(`${context.baseUrl}/api/v1/probe/validation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'also-not-valid' },
    body: '{"value":',
  });
  assert.equal(malformed.status, 400);
  assert.match(await malformed.text(), /VALIDATION_FAILED/);
  assert.match(malformed.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/i);

  const oversized = await fetch(`${context.baseUrl}/api/v1/probe/validation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(70_000) }),
  });
  assert.equal(oversized.status, 413);
  assert.match(await oversized.text(), /PAYLOAD_TOO_LARGE/);
});

test('internal errors are sanitized and logs correlate without raw errors or request payloads', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const response = await fetch(`${context.baseUrl}/api/v1/probe/failure`);
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /DEPENDENCY_UNAVAILABLE/);
  assert.doesNotMatch(body, /synthetic-marker-password|synthetic database diagnostic/);
  assert.equal(JSON.parse(body).requestId, response.headers.get('x-request-id'));

  await new Promise((resolve) => setTimeout(resolve, 0));
  const serializedLogs = JSON.stringify(context.logger.records);
  assert.doesNotMatch(serializedLogs, /synthetic-marker-password|synthetic database diagnostic/);
  assert.ok(context.logger.records.some((record) => record.requestId === response.headers.get('x-request-id')));
});

test('readiness uses the canonical Unavailable ErrorEnvelope while MariaDB is down and recovers when it is up', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const down = await fetch(context.baseUrl + '/ready');
  assert.equal(down.status, 503);
  const downBody = await down.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(downBody).sort(), ['action', 'code', 'requestId', 'retryable', 'safeMessage']);
  assert.deepEqual(downBody, {
    code: 'DEPENDENCY_UNAVAILABLE',
    safeMessage: 'The operation could not be confirmed yet.',
    requestId: down.headers.get('x-request-id'),
    retryable: true,
    action: 'CHECK_STATUS',
  });
  assert.equal(context.database.checks, 1);

  context.database.available = true;
  context.clock.advance(250);
  const up = await fetch(context.baseUrl + '/ready');
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { status: 'ok' });
  assert.equal(context.database.checks, 2);
  assert.doesNotMatch(JSON.stringify(context.logger.records), /synthetic database diagnostic/);
});

test('readiness coalesces a simultaneous burst and recovers after its short cache expires', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const gate = context.database.blockNextCheck();
  const requests = Array.from({ length: 16 }, () => fetch(`${context.baseUrl}/ready`));
  await gate.started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(context.database.checks, 1);
  gate.release();

  const responses = await Promise.all(requests);
  assert.ok(responses.every((response) => response.status === 503));
  for (const response of responses) {
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(body.action, 'CHECK_STATUS');
    assert.equal(body.requestId, response.headers.get('x-request-id'));
  }
  assert.equal(context.database.checks, 1);

  context.database.available = true;
  context.clock.advance(250);
  const recovered = await fetch(`${context.baseUrl}/ready`);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { status: 'ok' });
  assert.equal(context.database.checks, 2);
});

test('MariaDB ping deadline destroys a stalled probe connection', async () => {
  const { MysqlReadinessAdapter } = await import('../src/database/mysql-readiness.adapter.js');
  let destroyCount = 0;
  const adapter = new MysqlReadinessAdapter(
    { ...TEST_ENVIRONMENT.database, connectTimeoutMs: 25 },
    async () => ({
      ping: () => new Promise<void>(() => undefined),
      destroy: () => { destroyCount += 1; },
    }),
  );
  await assert.rejects(adapter.check(), /Readiness ping deadline exceeded/);
  assert.equal(destroyCount, 1);
});

test('graceful close drains an in-flight request and stops accepting new requests', async (t) => {
  const context = await startBoundaryApp();
  let closing: Promise<void> | undefined;
  t.after(async () => {
    if (closing) await closing;
    else await context.app.close();
  });

  const inFlight = fetch(`${context.baseUrl}/api/v1/probe/in-flight`);
  await context.state.started;

  closing = context.app.close();
  await assert.rejects(fetch(`${context.baseUrl}/api/v1/probe/in-flight`));
  context.state.release();
  const response = await inFlight;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { completed: true });
  await closing;
});


test('graceful Express adapter closes safely before the server starts listening', async () => {
  const adapter = new GracefulExpressAdapter();
  await adapter.close();
});

async function assertSubprocessShutdownDrain(connection: 'close' | 'keep-alive'): Promise<void> {
  const child = fork(join(__dirname, 'fixtures', 'sigterm-drain-child.js'), [], {
    execPath: process.execPath,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  let childExited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      childExited = { code, signal };
      resolve(childExited);
    });
  });

  try {
    const listening = await waitForChildMessage(child, 'listening', 5_000);
    const port = Number(listening.port);
    const response = fetch(
      'http://127.0.0.1:' + port + '/api/v1/probe/in-flight',
      { headers: { host: '127.0.0.1:' + port, connection } },
    );
    await waitForChildMessage(child, 'request-started');

    child.kill('SIGTERM');
    const signalMessage = await waitForChildMessage(child, 'signal-received');
    assert.equal(signalMessage.signal, 'SIGTERM');
    assert.equal(childExited, undefined, 'the child must remain alive while the handler is pending');
    const rejectedWhileDraining = await rawGet(
      'http://127.0.0.1:' + port + '/api/v1/probe/private',
      '127.0.0.1:' + port,
    );
    assert.equal(rejectedWhileDraining.status, 503);
    const rejectedBody = JSON.parse(rejectedWhileDraining.body) as Record<string, unknown>;
    assert.equal(rejectedBody.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(rejectedBody.action, 'CHECK_STATUS');
    assert.equal(rejectedBody.requestId, rejectedWhileDraining.headers['x-request-id']);
    child.send({ type: 'release' });
    await waitForChildMessage(child, 'release-received');
    await waitForChildMessage(child, 'handler-released', 5_000);
    await waitForChildMessage(child, 'response-finished');

    const completed = await response;
    assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), { started: true, completed: true });
    await waitForChildMessage(child, 'drain-wait-finished', 5_000);
    await waitForChildMessage(child, 'server-closed', 5_000);
    await waitForChildMessage(child, 'app-close-finished', 5_000);
    child.disconnect();
    const result = await exited;
    assert.equal(result.code, 0, stderr);
  } finally {
    if (child.connected) {
      try { child.send({ type: 'release' }); } catch {}
      child.disconnect();
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const stoppedGracefully = await waitForChildExitWithin(exited, 2000);
      if (!stoppedGracefully && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExitWithin(exited, 2000);
      }
    }
  }
}

test('SIGTERM in a subprocess drains the response fully with both connection policies', {
  skip: process.platform === 'win32'
    ? 'Windows skips this POSIX SIGTERM subprocess case; run it with tools/m2-02/run-sigterm-drain-linux.ps1.'
    : false,
}, async () => {
  await assertSubprocessShutdownDrain('close');
  await assertSubprocessShutdownDrain('keep-alive');
});

type ChildExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

async function waitForChildExitWithin(exited: Promise<ChildExit>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    exited.then(() => 'exited' as const),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome === 'exited';
}

async function waitForChildExit(
  exited: Promise<ChildExit>,
  timeoutMs: number,
  child?: import('node:child_process').ChildProcess,
): Promise<ChildExit> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    exited,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!result) {
    const observed = child ? (childMessageHistory.get(child)?.map((entry) => String(entry.type)).join(', ') || 'none') : 'not captured';
    throw new Error('Timed out waiting for subprocess exit; observed: ' + observed + '.');
  }
  return result;
}

function abortRequestAfterFirstChunk(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let receivedChunk = false;
    let settled = false;
    const request = httpRequest(url, (response) => {
      response.on('error', () => undefined);
      response.once('data', () => {
        receivedChunk = true;
        settled = true;
        request.destroy();
        response.destroy();
        resolve();
      });
    });
    const deadline = setTimeout(() => {
      request.destroy();
      if (!settled) reject(new Error('Timed out waiting for the in-flight response chunk.'));
    }, 3000);
    request.once('error', (error) => {
      if (receivedChunk || settled) resolve();
      else reject(error);
    });
    request.once('close', () => clearTimeout(deadline));
    request.end();
  });
}

function openRequestUntilAborted(url: string): import('node:http').ClientRequest {
  const request = httpRequest(url, (response) => {
    response.on('error', () => undefined);
    response.resume();
  });
  request.on('error', () => undefined);
  request.end();
  return request;
}

async function assertAbortedClientWaitsForHandler(): Promise<void> {
  const child = fork(join(__dirname, 'fixtures', 'sigterm-drain-child.js'), [], {
    execPath: process.execPath,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  let childExited: ChildExit | undefined;
  let handlerReleased = false;
  const exited = new Promise<ChildExit>((resolve) => {
    child.once('exit', (code, signal) => {
      childExited = { code, signal };
      resolve(childExited);
    });
  });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message &&
        (message as Record<string, unknown>).type === 'handler-released') {
      handlerReleased = true;
    }
  });

  try {
    const listening = await waitForChildMessage(child, 'listening', 5_000);
    const port = Number(listening.port);
    const disconnected = waitForChildMessage(child, 'response-closed', 5_000);
    await abortRequestAfterFirstChunk('http://127.0.0.1:' + port + '/api/v1/probe/in-flight');
    const disconnectMessage = await disconnected;
    assert.equal(disconnectMessage.writableFinished, false);

    const signalReceived = waitForChildMessage(child, 'signal-received', 5_000);
    child.kill('SIGTERM');
    const signalMessage = await signalReceived;
    assert.equal(signalMessage.signal, 'SIGTERM');
    assert.equal(await waitForChildExitWithin(exited, 100), false);
    assert.equal(childExited, undefined, 'the process must wait for the disconnected handler');
    assert.equal(handlerReleased, false);

    const releaseReceived = waitForChildMessage(child, 'release-received', 5_000);
    child.send({ type: 'release' });
    await releaseReceived;
    await waitForChildMessage(child, 'handler-released', 5_000);
    await waitForChildMessage(child, 'drain-wait-finished', 5_000);
    await waitForChildMessage(child, 'server-closed', 5_000);
    await waitForChildMessage(child, 'app-close-finished', 5_000);
    child.disconnect();
    const result = await waitForChildExit(exited, 5000, child);
    assert.equal(result.code, 0, stderr);
  } finally {
    if (child.connected) {
      try { child.send({ type: 'release' }); } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const stoppedGracefully = await waitForChildExitWithin(exited, 2000);
      if (!stoppedGracefully && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExitWithin(exited, 2000);
      }
    }
    if (child.connected) child.disconnect();
  }
}

async function assertObservableCancellationWaitsForAcknowledgement(): Promise<void> {
  const child = fork(join(__dirname, 'fixtures', 'sigterm-drain-child.js'), [], {
    execPath: process.execPath,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  let childExited: ChildExit | undefined;
  let cancellationAcknowledged = false;
  const exited = new Promise<ChildExit>((resolve) => {
    child.once('exit', (code, signal) => {
      childExited = { code, signal };
      resolve(childExited);
    });
  });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message &&
        (message as Record<string, unknown>).type === 'observable-cancel-ack') {
      cancellationAcknowledged = true;
    }
  });

  let request: import('node:http').ClientRequest | undefined;
  try {
    const listening = await waitForChildMessage(child, 'listening', 5_000);
    const port = Number(listening.port);
    const disconnected = waitForChildMessage(child, 'response-closed', 5_000);
    request = openRequestUntilAborted('http://127.0.0.1:' + port + '/api/v1/probe/observable-cancel');
    await waitForChildMessage(child, 'observable-started', 5_000);
    const earlyAck = await waitForChildMessage(child, 'observable-early-ack', 5_000);
    assert.equal(earlyAck.accepted, false, 'acknowledgement before signal.aborted must be rejected');
    request.destroy();
    await waitForChildMessage(child, 'observable-unsubscribed', 5_000);
    const disconnectMessage = await disconnected;
    assert.equal(disconnectMessage.writableFinished, false);

    const signalReceived = waitForChildMessage(child, 'signal-received', 5_000);
    child.kill('SIGTERM');
    const signalMessage = await signalReceived;
    assert.equal(signalMessage.signal, 'SIGTERM');
    assert.equal(await waitForChildExitWithin(exited, 50), false);
    assert.equal(cancellationAcknowledged, false, 'RxJS unsubscribe is not cancellation acknowledgement');

    await waitForChildMessage(child, 'observable-cancel-ack', 5_000);
    cancellationAcknowledged = true;
    assert.equal(childExited, undefined);
    await waitForChildMessage(child, 'drain-wait-finished', 5_000);
    await waitForChildMessage(child, 'server-closed', 5_000);
    await waitForChildMessage(child, 'app-close-finished', 5_000);
    child.disconnect();
    const result = await waitForChildExit(exited, 5000, child);
    assert.equal(result.code, 0, stderr);
  } finally {
    request?.destroy();
    if (child.connected) child.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const stoppedGracefully = await waitForChildExitWithin(exited, 2000);
      if (!stoppedGracefully && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExitWithin(exited, 2000);
      }
    }
  }
}

test('SIGTERM waits for a Promise handler after the client aborts its response', {
  skip: process.platform === 'win32'
    ? 'Windows skips this POSIX SIGTERM subprocess case; run it with tools/m2-02/run-sigterm-drain-linux.ps1.'
    : false,
}, async () => {
  await assertAbortedClientWaitsForHandler();
});

async function assertResponseSentBeforeHandlerCompletes(): Promise<void> {
  const child = fork(join(__dirname, 'fixtures', 'sigterm-drain-child.js'), [], {
    execPath: process.execPath,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  let childExited: ChildExit | undefined;
  const exited = new Promise<ChildExit>((resolve) => {
    child.once('exit', (code, signal) => {
      childExited = { code, signal };
      resolve(childExited);
    });
  });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  try {
    const listening = await waitForChildMessage(child, 'listening', 5_000);
    const port = Number(listening.port);
    const responseFinished = waitForChildMessage(child, 'response-finished', 5_000);
    const responseClosed = waitForChildMessage(child, 'response-closed', 5_000);
    const response = await rawGet(
      'http://127.0.0.1:' + port + '/api/v1/probe/response-before-handler',
      '127.0.0.1:' + port,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { completed: false });
    await responseFinished;
    const closed = await responseClosed;
    assert.equal(closed.writableFinished, true);

    const signalReceived = waitForChildMessage(child, 'signal-received', 5_000);
    child.kill('SIGTERM');
    assert.equal((await signalReceived).signal, 'SIGTERM');
    assert.equal(await waitForChildExitWithin(exited, 100), false);
    assert.equal(childExited, undefined, 'a finished response does not settle a pending handler');

    const releaseReceived = waitForChildMessage(child, 'release-received', 5_000);
    child.send({ type: 'release' });
    await releaseReceived;
    await waitForChildMessage(child, 'handler-released', 5_000);
    await waitForChildMessage(child, 'drain-wait-finished', 5_000);
    await waitForChildMessage(child, 'server-closed', 5_000);
    await waitForChildMessage(child, 'app-close-finished', 5_000);
    child.disconnect();
    const result = await waitForChildExit(exited, 5000, child);
    assert.equal(result.code, 0, stderr);
  } finally {
    if (child.connected) {
      try { child.send({ type: 'release' }); } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const stoppedGracefully = await waitForChildExitWithin(exited, 2000);
      if (!stoppedGracefully && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExitWithin(exited, 2000);
      }
    }
    if (child.connected) child.disconnect();
  }
}

test('SIGTERM waits for a handler after the response finishes and the client closes', {
  skip: process.platform === 'win32'
    ? 'Windows skips this POSIX SIGTERM subprocess case; run it with tools/m2-02/run-sigterm-drain-linux.ps1.'
    : false,
}, async () => {
  await assertResponseSentBeforeHandlerCompletes();
});
test('SIGTERM waits for explicit acknowledgement after an Observable disconnect unsubscribe', {
  skip: process.platform === 'win32'
    ? 'Windows skips this POSIX SIGTERM subprocess case; run it with tools/m2-02/run-sigterm-drain-linux.ps1.'
    : false,
}, async () => {
  await assertObservableCancellationWaitsForAcknowledgement();
});
