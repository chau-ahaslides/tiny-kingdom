// AhaSlides games asset library (worker tiny-kingdom-lib): serves the library out of an R2 bucket.
//
//   GET  /<key>           the object, with CORS, ETag/304, Range, 1-day edge+browser cache — open to anyone
//   GET  /                the catalog page (index.html in the bucket)       ┐ the index: needs the read token,
//   GET  /llms.txt        the full guide for agents and people              │ as Authorization: Bearer <LIB_READ_TOKEN>
//   GET  /manifest.json   every file with sizes, hashes, dimensions, durations │ or ?key=<LIB_READ_TOKEN>
//   GET  /packs.json      the packs with licences and credits                ┘ (the upload token works too)
//   PUT  /<key>           upload (Authorization: Bearer <LIB_UPLOAD_TOKEN>)
//   DELETE /<key>         remove (same auth)
//
// The files are public because games load them from any origin; the index is gated so the host is an
// asset server for our games, not a browsable library (most packs forbid redistribution as an asset pack).
// Deploy: wrangler deploy -c library/worker/wrangler.jsonc

const CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
const INDEX = new Set(['index.html', 'manifest.json', 'packs.json', 'llms.txt']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let key = decodeURIComponent(url.pathname.slice(1));
    if (key === '' || key.endsWith('/')) key += 'index.html';
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors({ 'access-control-max-age': '86400' }) });

    if (method === 'PUT' || method === 'DELETE') {
      if (!authorised(request, env)) return new Response('unauthorised', { status: 401 });
      if (!validKey(key)) return new Response('bad key', { status: 400 });
      if (method === 'DELETE') { await env.LIB.delete(key); }
      else {
        const contentType = request.headers.get('content-type') || 'application/octet-stream';
        await env.LIB.put(key, request.body, { httpMetadata: { contentType } });
      }
      ctx.waitUntil(caches.default.delete(new Request(new URL('/' + key, url.origin).toString())));
      return new Response(method === 'PUT' ? 'stored' : 'deleted', { status: 200 });
    }

    if (method !== 'GET' && method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: cors() });

    const gated = INDEX.has(key);
    if (gated && !readAuthorised(request, url, env)) {
      return new Response('this index needs the library read token: Authorization: Bearer <token> or ?key=<token>', { status: 401, headers: cors({ 'cache-control': 'no-store' }) });
    }

    const cacheable = !gated && !request.headers.has('range');
    const cacheKey = new Request(new URL('/' + key, url.origin).toString(), { method: 'GET' });
    if (cacheable) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return conditional(request, hit);
    }

    const object = await env.LIB.get(key, {
      range: request.headers.has('range') ? request.headers : undefined,
      onlyIf: request.headers,
    });
    if (object === null) return new Response('not found', { status: 404, headers: cors() });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', gated ? 'private, max-age=60' : CACHE_CONTROL);
    headers.set('accept-ranges', 'bytes');
    for (const [k, v] of Object.entries(cors())) headers.set(k, v);

    if (!('body' in object)) return new Response(null, { status: 304, headers }); // onlyIf did not match: R2ObjectBody absent

    let status = 200;
    if (request.headers.has('range') && object.range) {
      const { offset = 0, length = object.size - offset } = object.range;
      headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
      status = 206;
    }
    const response = new Response(method === 'HEAD' ? null : object.body, { status, headers });
    if (cacheable && status === 200 && method === 'GET') ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  },
};

function cors(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'range, if-none-match',
    'access-control-expose-headers': 'content-length, content-range, etag, accept-ranges',
    'timing-allow-origin': '*',
    ...extra,
  };
}

function conditional(request, cached) {
  const inm = request.headers.get('if-none-match');
  const etag = cached.headers.get('etag');
  if (inm && etag && inm.split(',').map((s) => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers: cached.headers });
  }
  return request.method === 'HEAD' ? new Response(null, { status: cached.status, headers: cached.headers }) : cached;
}

function bearer(request) {
  const auth = request.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

function same(token, expected) {
  if (!expected || !token || token.length !== expected.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(token), enc.encode(expected));
}

/** Writes: the upload token only. */
function authorised(request, env) {
  return same(bearer(request), env.LIB_UPLOAD_TOKEN);
}

/** Index reads: the read token or the upload token, as a bearer header or ?key=. */
function readAuthorised(request, url, env) {
  const token = bearer(request) || url.searchParams.get('key') || '';
  return same(token, env.LIB_READ_TOKEN) || same(token, env.LIB_UPLOAD_TOKEN);
}

function validKey(key) {
  return key.length > 0 && key.length < 1024 && !key.includes('..') && !key.startsWith('/') && !/[\u0000-\u001f]/.test(key);
}
