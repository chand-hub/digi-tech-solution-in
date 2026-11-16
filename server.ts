import dotenv from 'dotenv';
dotenv.config();

import express, { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { handleApiRequest } from './src/backend/router';
import { EnvBindings } from './src/backend/types';
import { getNodeDatabase, mirrorEnquiriesToJsonBackup } from './src/backend/nodeSqliteAdapter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getClientIp(req: ExpressRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown-ip';
}

function getProcessEnvBindings(): EnvBindings {
  return {
    NODE_ENV: process.env.NODE_ENV,
    APP_URL: process.env.APP_URL,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    OFFICIAL_NOTIFICATION_EMAIL: process.env.OFFICIAL_NOTIFICATION_EMAIL,
    NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_DEFAULT_TEMPLATE: process.env.WHATSAPP_DEFAULT_TEMPLATE,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
  };
}

function toWebRequest(req: ExpressRequest, rawBodyText?: string): Request {
  const host = req.headers.host || 'localhost:3000';
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  const fullUrl = `${proto}://${host}${req.originalUrl}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    }
  }

  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

  return new Request(fullUrl, {
    method,
    headers,
    body: hasBody ? (rawBodyText !== undefined ? rawBodyText : '') : undefined,
  });
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  // Initialize persistent SQLite database + migrate existing data/enquiries.json records
  const db = await getNodeDatabase();

  // Capture raw request text on /api routes so webhooks preserve exact raw payload for HMAC verification
  app.use('/api', express.text({ type: '*/*', limit: '1mb' }));

  app.use('/api', async (req: ExpressRequest, res: ExpressResponse) => {
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const webRequest = toWebRequest(req, rawBody);
    const webResponse = await handleApiRequest(
      webRequest,
      getProcessEnvBindings(),
      db,
      getClientIp(req),
      {
        onEnquirySaved: () => mirrorEnquiriesToJsonBackup(db),
      }
    );

    res.status(webResponse.status);
    webResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const text = await webResponse.text();
    res.send(text);
  });

  // Express error guard for malformed /api requests
  app.use((err: unknown, req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    if (req.originalUrl.startsWith('/api')) {
      const msg = err instanceof Error ? err.message : 'Invalid request payload';
      res.status(400).json({
        success: false,
        emailSent: false,
        error: 'BAD_REQUEST',
        message: msg,
      });
      return;
    }
    next(err);
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: ExpressRequest, res: ExpressResponse) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[DIGI TECH SOLUTION] Server running on http://0.0.0.0:${PORT} (${isProd ? 'production' : 'development'})`
    );
  });
}

startServer().catch((err) => {
  console.error('[DIGI TECH SOLUTION] Fatal server startup error:', err);
  process.exit(1);
});
