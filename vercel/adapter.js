const DEFAULT_FRONTEND_ORIGIN = 'https://rv.celestivast.com';

const METHOD_EXPORTS = {
  GET: 'onRequestGet',
  HEAD: 'onRequestHead',
  POST: 'onRequestPost',
  PUT: 'onRequestPut',
  PATCH: 'onRequestPatch',
  DELETE: 'onRequestDelete',
  OPTIONS: 'onRequestOptions'
};

function normalizedEnvironment(source = {}) {
  const frontend = String(source.BUSINESS_FRONTEND_URL || DEFAULT_FRONTEND_ORIGIN).replace(/\/$/, '');
  return {
    ...source,
    AUTH_STORE: source.AUTH_STORE || 'supabase',
    BUSINESS_FRONTEND_URL: frontend,
    CORS_ALLOWED_ORIGINS: source.CORS_ALLOWED_ORIGINS || frontend
  };
}

function configuredOrigins(env) {
  return String(env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .flatMap(value => {
      try { return [new URL(value).origin]; } catch { return []; }
    });
}

function allowedCorsOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const target = new URL(request.url).origin;
  if (origin === target || configuredOrigins(env).includes(origin)) return origin;
  return null;
}

function corsHeaders(request, env) {
  const origin = allowedCorsOrigin(request, env);
  if (!origin) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin'
  };
}

function withCors(response, request, env) {
  const additions = corsHeaders(request, env);
  if (!additions) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(additions)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function frontendRedirect(response, env, route) {
  if (route !== '/auth/callback' || response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get('Location');
  if (!location || !location.startsWith('/') || location.startsWith('//')) return response;
  const headers = new Headers(response.headers);
  headers.set('Location', new URL(location, `${env.BUSINESS_FRONTEND_URL}/`).toString());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function internalError(request, env, route, error) {
  console.error(`[vercel-adapter] route=${route} error=${String(error?.message || error).slice(0, 120)}`);
  return withCors(Response.json({ error: 'internal_error' }, { status: 500 }), request, env);
}

export function createVercelFunction(handlers, options = {}) {
  const route = options.route || '/';
  const environment = options.environment || (() => process.env);

  return {
    async fetch(request) {
      const env = normalizedEnvironment(environment());
      if (request.method === 'OPTIONS') {
        if (request.headers.get('Origin') && !allowedCorsOrigin(request, env)) {
          return Response.json({ error: 'invalid_origin' }, { status: 403 });
        }
        return withCors(new Response(null, { status: 204 }), request, env);
      }

      const methodHandler = handlers[METHOD_EXPORTS[request.method]];
      const handler = typeof methodHandler === 'function' ? methodHandler : handlers.onRequest;
      if (typeof handler !== 'function') {
        return withCors(Response.json({ error: 'method_not_allowed' }, { status: 405 }), request, env);
      }

      try {
        const response = await handler({
          request,
          env,
          data: {},
          params: {},
          waitUntil() {},
          next: () => new Response('Not Found', { status: 404 })
        });
        if (!(response instanceof Response)) throw new Error('invalid_handler_response');
        return withCors(frontendRedirect(response, env, route), request, env);
      } catch (error) {
        return internalError(request, env, route, error);
      }
    }
  };
}
