// AhaSlides games asset library (worker tiny-kingdom-lib): serves the library out of an R2 bucket.
//
//   GET  /<key>           the object, with ETag/304, Range, 1-day edge+browser cache — open to anyone
//   GET  /                the catalog page (index.html in the bucket)       ┐ the index: needs the read token,
//   GET  /llms.txt        the full guide for agents and people              │ as Authorization: Bearer <LIB_READ_TOKEN>
//   GET  /manifest.json   every file with sizes, hashes, dimensions, durations │ or ?key=<LIB_READ_TOKEN> — or a
//   GET  /packs.json      the packs with licences and credits                ┘ staff Google sign-in (/auth/login)
//   GET  /auth/…          login, callback, logout, me — Google sign-in for AhaSlides staff
//   PUT  /<key>           upload (Authorization: Bearer <LIB_UPLOAD_TOKEN>)
//   DELETE /<key>         remove (same auth)
//
// Cross-origin use (fetch, Web Audio, canvas readback, ES module import) is allowed only from AhaSlides
// origins: *.ahaslides.com / .io / .ai, *.ahaslides-game.workers.dev and localhost (ALLOWED_ORIGIN in lib.mjs).
// Plain <img>/<audio> tags work from anywhere, as they do not use CORS. The index is gated so the host is
// an asset server for our games, not a browsable library (most packs forbid redistribution as a pack).
// Deploy: wrangler deploy -c library/worker/wrangler.jsonc

import { originAllowed, verifyJwt, parseCookies, signSession, readSession, emailAllowed, safeNext } from '../lib.mjs';

const CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
const INDEX = new Set(['index.html', 'manifest.json', 'packs.json', 'llms.txt']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let key = decodeURIComponent(url.pathname.slice(1));
    if (key === '' || key.endsWith('/')) key += 'index.html';
    if (key === 'catalog') key = 'index.html';   // /catalog is the catalog for people, who sign in; / takes the agent key
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, { 'access-control-max-age': '86400' }) });

    if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) return auth(request, url, env);

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

    if (method !== 'GET' && method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: cors(request) });

    const gated = INDEX.has(key);
    if (gated && !readAuthorised(request, url, env) && !(await session(request, env))) {
      // a person in a browser is sent to Google; an agent gets the plain 401 and uses its token
      if (method === 'GET' && loginConfigured(env) && (request.headers.get('accept') || '').includes('text/html')) {
        return redirect('/auth/login?next=' + encodeURIComponent(url.pathname + url.search));
      }
      return new Response('this index needs the library read token (Authorization: Bearer <token> or ?key=<token>), or an AhaSlides sign-in at /catalog', { status: 401, headers: cors(request, { 'cache-control': 'no-store' }) });
    }

    // The edge cache holds responses without CORS headers; they are added per request below, since
    // Access-Control-Allow-Origin echoes the caller's origin and must not be cached for another.
    const cacheable = !gated && !request.headers.has('range');
    const cacheKey = new Request(new URL('/' + key, url.origin).toString(), { method: 'GET' });
    if (cacheable) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return withCors(request, conditional(request, hit));
    }

    const object = await env.LIB.get(key, {
      range: request.headers.has('range') ? request.headers : undefined,
      onlyIf: request.headers,
    });
    if (object === null) return new Response('not found', { status: 404, headers: cors(request) });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', gated ? 'private, max-age=60' : key === 'aha-assets.js' ? 'public, max-age=300' : CACHE_CONTROL);
    headers.set('accept-ranges', 'bytes');

    if (!('body' in object)) return withCors(request, new Response(null, { status: 304, headers })); // onlyIf did not match

    let status = 200;
    if (request.headers.has('range') && object.range) {
      const { offset = 0, length = object.size - offset } = object.range;
      headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
      status = 206;
    }
    const response = new Response(method === 'HEAD' ? null : object.body, { status, headers });
    if (cacheable && status === 200 && method === 'GET') ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return withCors(request, response);
  },
};

/** CORS headers for this request: the caller's origin when it is an AhaSlides one, nothing otherwise. */
function cors(request, extra = {}) {
  const origin = request.headers.get('origin');
  const h = { vary: 'origin', ...extra };
  if (originAllowed(origin)) {
    Object.assign(h, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'range, if-none-match, authorization',
      'access-control-expose-headers': 'content-length, content-range, etag, accept-ranges',
      'timing-allow-origin': origin,
    });
  }
  return h;
}

function withCors(request, response) {
  const out = new Response(response.body, response);
  for (const k of [...out.headers.keys()]) if (k.startsWith('access-control-') || k === 'timing-allow-origin') out.headers.delete(k);
  for (const [k, v] of Object.entries(cors(request))) out.headers.set(k, v);
  return out;
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

/* --- Google sign-in, for people -------------------------------------------------------------------
   Staff open the catalog and sign in with their AhaSlides Google account; the cookie it sets then opens
   llms.txt, manifest.json and packs.json in that browser too. Agents keep using the read token, and the
   asset files are public either way, so none of this is on the hot path.

     GET /auth/login?next=/catalog   -> Google's account chooser
     GET /auth/callback?code&state   -> checks the ID token, sets the session cookie, goes to `next`
     GET /auth/logout                -> drops the cookie
     GET /auth/me                    -> { email } for the catalog page

   Needs the GOOGLE_CLIENT_ID var and the GOOGLE_CLIENT_SECRET and LIB_SESSION_SECRET secrets; without
   them /auth answers 503 and only the token works. LOGIN_DOMAINS lists the email domains allowed in. */
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];
const SESSION = 'aha_lib_session';
const STATE = 'aha_lib_state';
const SESSION_TTL = 12 * 3600;

const loginConfigured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.LIB_SESSION_SECRET);
const loginDomains = (env) => String(env.LOGIN_DOMAINS || 'ahaslides.com').split(',').map((s) => s.trim()).filter(Boolean);
const setCookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const note = (body, status) => new Response(body + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const redirect = (location, extra = []) => {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of extra) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
};

/** The signed-in staff member, or null. */
async function session(request, env) {
  if (!env.LIB_SESSION_SECRET) return null;
  return readSession(parseCookies(request.headers.get('cookie'))[SESSION], env.LIB_SESSION_SECRET);
}

async function auth(request, url, env) {
  const path = url.pathname;
  if (path === '/auth/me') {
    const s = await session(request, env);
    return Response.json({ email: s ? s.email : null, exp: s ? s.exp : null, login: loginConfigured(env) },
      { status: s ? 200 : 401, headers: { 'cache-control': 'no-store' } });
  }
  if (path === '/auth/logout') return redirect(safeNext(url.searchParams.get('next'), '/catalog'), [setCookie(SESSION, '', 0)]);
  if (!loginConfigured(env)) return note('sign-in is not set up on this worker (needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and LIB_SESSION_SECRET); use the library read token instead', 503);

  if (path === '/auth/login') {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const to = new URL(GOOGLE_AUTH);
    to.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: url.origin + '/auth/callback',
      response_type: 'code',
      scope: 'openid email',
      state: nonce,
      prompt: 'select_account',
      hd: loginDomains(env)[0],            // Google offers company accounts first; the check below is the real gate
    }).toString();
    const state = `${nonce}.${encodeURIComponent(safeNext(url.searchParams.get('next')))}`;
    return redirect(to.toString(), [setCookie(STATE, state, 600)]);
  }

  if (path === '/auth/callback') {
    const [nonce, next = ''] = (parseCookies(request.headers.get('cookie'))[STATE] || '').split('.');
    if (!nonce || url.searchParams.get('state') !== nonce) return note('that sign-in has expired — start again at /catalog', 400);
    const code = url.searchParams.get('code');
    if (!code) return note('sign-in was cancelled', 400);

    const token = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: url.origin + '/auth/callback',
        grant_type: 'authorization_code',
      }),
    });
    if (!token.ok) return note('Google would not exchange that sign-in code', 502);
    const { id_token: idToken } = await token.json();

    const certs = await fetch(GOOGLE_CERTS, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!certs.ok) return note('could not reach Google to check the sign-in', 502);
    const { keys } = await certs.json();
    const claims = await verifyJwt(idToken, { keys, aud: env.GOOGLE_CLIENT_ID });
    if (!claims || !GOOGLE_ISS.includes(claims.iss)) return note('that sign-in did not check out', 401);

    const domains = loginDomains(env);
    if (claims.email_verified === false || !emailAllowed(claims.email, domains)) {
      return note(`${claims.email || 'That account'} cannot open the asset library. Sign in with your @${domains[0]} account.`, 403);
    }
    const value = await signSession({ email: claims.email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, env.LIB_SESSION_SECRET);
    return redirect(safeNext(decodeURIComponent(next)), [setCookie(SESSION, value, SESSION_TTL), setCookie(STATE, '', 0)]);
  }
  return note('not found', 404);
}

function validKey(key) {
  return key.length > 0 && key.length < 1024 && !key.includes('..') && !key.startsWith('/') && !/[\u0000-\u001f]/.test(key);
}
