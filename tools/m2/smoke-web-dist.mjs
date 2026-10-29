import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webRoot = path.join(repositoryRoot, 'apps', 'web');
const staticRoot = path.join(webRoot, 'dist', 'meta-integration', 'browser');
const routesFile = path.join(webRoot, 'src', 'app', 'app.routes.ts');
const requiredRoutes = ['setup', 'channels', 'templates'];
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

await access(path.join(staticRoot, 'index.html'));
const routesSource = await readFile(routesFile, 'utf8');
for (const route of requiredRoutes) {
  if (!new RegExp(`path\\s*:\\s*['"]${route}['"]`).test(routesSource)) {
    throw new Error(`Angular route "${route}" is not declared in ${path.relative(repositoryRoot, routesFile)}.`);
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }

    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const requestedPath = path.resolve(staticRoot, `.${pathname}`);
    const relativePath = path.relative(staticRoot, requestedPath);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      response.writeHead(400).end();
      return;
    }

    let filePath = requestedPath;
    try {
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) {
        filePath = path.join(staticRoot, 'index.html');
      }
    } catch {
      if (path.extname(pathname)) {
        response.writeHead(404).end();
        return;
      }
      filePath = path.join(staticRoot, 'index.html');
    }

    response.writeHead(200, {
      'Content-Type': mimeTypes.get(path.extname(filePath)) ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(400).end();
  }
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The static smoke server did not get a TCP address.');
  }
  const origin = `http://127.0.0.1:${address.port}`;

  for (const route of requiredRoutes) {
    const response = await fetch(new URL(`/${route}`, origin));
    const body = await response.text();
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('text/html') || !body.includes('<app-root')) {
      throw new Error(`Static deep-link smoke failed for /${route} (HTTP ${response.status}).`);
    }
  }

  console.log(`Static Angular deep-link smoke passed for ${requiredRoutes.map((route) => `/${route}`).join(', ')}.`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(resolve);
  });
}
