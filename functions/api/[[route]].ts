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

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const { request, env } = context;

  if (!env.DB) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'D1_DATABASE_NOT_BOUND',
        message:
          'Cloudflare D1 database binding "DB" is missing. Bind a D1 database named "DB" in Cloudflare Pages Settings -> Functions -> D1 database bindings.',
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

  return handleApiRequest(request, env, env.DB, getEdgeClientIp(request));
};
