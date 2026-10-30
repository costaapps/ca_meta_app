import { ExpressAdapter } from '@nestjs/platform-express';
import type { Server } from 'node:http';

export class GracefulExpressAdapter extends ExpressAdapter {
  override close(): Promise<void> {
    this.beforeClose();
    const server = this.getHttpServer() as Server | undefined;
    if (!server?.listening) return Promise.resolve();
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
}