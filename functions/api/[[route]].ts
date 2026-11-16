/**
 * Cloudflare Pages Functions Entry Point (/api/*)
 * Handles all backend API routes natively on Cloudflare Edge with D1 Database and encrypted Secrets.
 */

import { D1DatabaseLike, EnvBindings } from '../../src/backend/types';
import { handleApiRequest } from '../../src/backend/router';

interface PagesContext {
  request: Request;
  env: EnvBindings & { DB?: D1DatabaseLike };
  params: Record<string, string | string[]>;
}

function getEdgeClientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'edge-client'
  );
}

const STATELESS_ROUTES = new Set([
  '/api/health',
  '/api/email-status',
  '/api/payments/config',
  '/api/whatsapp/status',
]);

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  const isStatelessRead =
    method === 'OPTIONS' ||
    (method === 'GET' && (STATELESS_ROUTES.has(pathname) || pathname === '/api/whatsapp/webhook'));

  if (!env.DB && !isStatelessRead) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'D1_DATABASE_NOT_BOUND',
        message:
          'Cloudflare D1 database binding "DB" is missing. Bind a D1 database named "DB" in Cloudflare Pages Settings -> Bindings (or Functions -> D1 database bindings).',
      }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }
    );
  }

  return handleApiRequest(
    request,
    env,
    (env.DB as D1DatabaseLike),
    getEdgeClientIp(request),
    { databaseStatus: env.DB ? 'connected' : 'not_bound' }
  );
};
