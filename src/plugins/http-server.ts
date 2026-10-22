import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Logger } from '@guiiai/logg';

import type { HttpHandler, HttpRequest, HttpRoute } from '../../plugins/src/sdk';

const MAX_BODY_SIZE = 64 * 1024; // 64 KB

interface CompiledRoute {
  method: string;
  path: string;
  regex: RegExp;
  paramNames: string[];
  handler: HttpHandler;
}

const compilePath = (pathPattern: string): { regex: RegExp; paramNames: string[] } => {
  const paramNames: string[] = [];
  const normalized = pathPattern.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const escaped = normalized.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  const regex = new RegExp(`^${escaped}/?$`);
  return { regex, paramNames };
};

export interface PluginHttpServer {
  registerRoute(route: HttpRoute): void;
  hasRoutes(): boolean;
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  start(host: string, port: number): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export const createPluginHttpServer = (logger: Logger): PluginHttpServer => {
  let server: Server | undefined;
  let running = false;
  const routes: CompiledRoute[] = [];

  const registerRoute = (route: HttpRoute): void => {
    const { regex, paramNames } = compilePath(route.path);
    routes.push({
      method: route.method.toUpperCase(),
      path: route.path,
      regex,
      paramNames,
      handler: route.handler,
    });
  };

  const hasRoutes = (): boolean => routes.length > 0;

  const matchRoute = (method: string, path: string): { route: CompiledRoute; params: Record<string, string> } | undefined => {
    const upperMethod = method.toUpperCase();
    const cleanPath = path.split('?')[0] ?? '/';

    for (const route of routes) {
      if (route.method !== '*' && route.method !== upperMethod) continue;
      const match = cleanPath.match(route.regex);
      if (match) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          const name = route.paramNames[i]!;
          params[name] = match[i + 1]!;
        }
        return { route, params };
      }
    }
    return undefined;
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';

    const match = matchRoute(method, path);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    // Read raw body up to limit
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    try {
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buf.length;
        if (receivedBytes > MAX_BODY_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload Too Large' }));
          return;
        }
        chunks.push(buf);
      }
    } catch (err) {
      logger.withError(err).warn('Failed reading HTTP request body');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed reading request body' }));
      return;
    }

    const rawBody = Buffer.concat(chunks);
    let body: unknown = undefined;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        // Leave body undefined if not JSON
      }
    }

    const httpRequest: HttpRequest = {
      method,
      path: path.split('?')[0] ?? '/',
      headers: req.headers,
      rawBody,
      body,
      params: match.params,
    };

    try {
      const response = await match.route.handler(httpRequest);
      if (res.headersSent) return;

      if (!response) {
        res.writeHead(200);
        res.end();
        return;
      }

      const status = response.status || 200;
      const headers = response.headers ? { ...response.headers } : {};

      if (response.body !== undefined) {
        if (typeof response.body === 'string') {
          headers['Content-Type'] ??= 'text/plain; charset=utf-8';
          res.writeHead(status, headers);
          res.end(response.body);
        } else if (Buffer.isBuffer(response.body)) {
          headers['Content-Type'] ??= 'application/octet-stream';
          res.writeHead(status, headers);
          res.end(response.body);
        } else {
          headers['Content-Type'] ??= 'application/json; charset=utf-8';
          res.writeHead(status, headers);
          res.end(JSON.stringify(response.body));
        }
      } else {
        res.writeHead(status, headers);
        res.end();
      }
    } catch (err) {
      logger.withError(err).withFields({ path, method }).error('Unhandled error in plugin HTTP handler');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  };

  const start = async (host: string, port: number): Promise<void> => {
    if (running) return;
    server = createServer((req, res) => {
      void handleRequest(req, res).catch(err => {
        logger.withError(err).error('Unexpected server error');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Server Error' }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server!.listen(port, host, () => {
        running = true;
        logger.withFields({ host, port }).log('Plugin HTTP server listening');
        resolve();
      });
      server!.once('error', reject);
    });
  };

  const stop = async (): Promise<void> => {
    if (!running || !server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close(err => {
        running = false;
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return {
    registerRoute,
    hasRoutes,
    handleRequest,
    start,
    stop,
    isRunning: () => running,
  };
};
