import express, { type ErrorRequestHandler } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

dotenv.config();

export interface CreateAppOptions {
  mode?: 'development' | 'production';
  distPath?: string;
  jsonLimit?: string;
}

const resolveMode = (): 'development' | 'production' => {
  if (process.env.NODE_ENV === 'development') return 'development';
  if (process.env.NODE_ENV === 'production') return 'production';
  return process.env.npm_lifecycle_event === 'dev' ? 'development' : 'production';
};

const parsePort = (value: string | undefined): number => {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
};

export const contentSecurityPolicy = (
  mode: 'development' | 'production',
  developmentApiUrl = process.env.VITE_SYNC_V2_API_URL,
  developmentObjectStoreUrl =
    process.env.SYNC_OBJECT_STORE_ENDPOINT || 'http://localhost:9000',
): string => {
  const connectSources = [
    "'self'",
    'https://*.supabase.co',
    'wss://*.supabase.co',
    'https://www.googleapis.com',
  ];
  if (mode === 'development') {
    connectSources.push('ws:', 'wss:');
    for (const developmentUrl of [developmentApiUrl, developmentObjectStoreUrl]) {
      if (!developmentUrl) continue;
      try {
        const url = new URL(developmentUrl);
        if (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          !connectSources.includes(url.origin)
        ) {
          connectSources.push(url.origin);
        }
      } catch {
        // Invalid service URLs are handled by the application configuration checks.
      }
    }
  }
  const scriptSources = ["'self'"];
  // Vite injects the React Refresh preamble as an inline module during local
  // development. Keep production strict while allowing that dev-only bootstrap.
  if (mode === 'development') scriptSources.push("'unsafe-inline'");

  return [
    "default-src 'self'",
    "base-uri 'self'",
    `connect-src ${connectSources.join(' ')}`,
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'self' data: blob: https:",
    "manifest-src 'self'",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join('; ');
};

const securityHeaders =
  (mode: 'development' | 'production'): express.RequestHandler =>
  (_req, res, next) => {
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(mode));
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Permissions-Policy',
      'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
    );
    if (mode === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };

const apiNotFound: express.RequestHandler = (_req, res) => {
  res.status(404).type('application/json').json({ error: 'not_found' });
};

const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error?.type === 'entity.too.large') {
    res.status(413).type('application/json').json({ error: 'payload_too_large' });
    return;
  }
  if (error?.type === 'entity.parse.failed') {
    res.status(400).type('application/json').json({ error: 'invalid_json' });
    return;
  }
  res
    .status(error?.status || 500)
    .type('application/json')
    .json({ error: 'internal_server_error' });
};

export const createApp = async (options: CreateAppOptions = {}): Promise<express.Express> => {
  const app = express();
  const mode = options.mode || resolveMode();

  app.disable('x-powered-by');
  app.use(securityHeaders(mode));
  app.use(express.json({ limit: options.jsonLimit || '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.type('application/json').json({ status: 'ok', offline: true });
  });
  app.use('/api', apiNotFound);

  if (mode === 'development') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = options.distPath || path.join(process.cwd(), 'dist');
    const indexPath = path.join(distPath, 'index.html');
    app.use(
      express.static(distPath, {
        dotfiles: 'deny',
        fallthrough: true,
        index: false,
      }),
    );
    app.get('*', (_req, res) => {
      res.sendFile(indexPath);
    });
  }

  app.use(errorHandler);
  return app;
};

export const startServer = async (): Promise<void> => {
  const app = await createApp();
  const port = parsePort(process.env.PORT);
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`Server running on ${host}:${port}`);
  });
};

if (process.env.DEAR_DIARY_DISABLE_SERVER_AUTOSTART !== 'true') {
  void startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
