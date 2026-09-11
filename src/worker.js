/* tiny-kingdom worker: static assets + the multiplayer relay (host-authoritative) for Survival Quiz, Survival Brawl and Brawl Quiz,
   plus the Marshmallow Challenge room, which runs its own physics in a Durable Object (see marsh-room.js) */
export { MarshRoom } from './marsh-room.js';

export class Room {
  constructor(state, env) {
    this.host = null;
    this.players = new Map();   // id -> ws
    this.roster = new Map();    // id -> name (kept on disconnect so reloads can reclaim their knight)
    this.tokens = new Map();    // reconnect token -> id
    this.nextId = 1;
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const role = url.searchParams.get('role');
    if (role === 'host') this.setupHost(server);
    else this.setupPlayer(server, (url.searchParams.get('name') || 'Player').slice(0, 16), url.searchParams.get('token') || '');
    return new Response(null, { status: 101, webSocket: client });
  }
  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
  setupHost(ws) {
    if (this.host) { try { this.host.close(); } catch (e) {} }
    this.host = ws;
    // the roster replay says who is actually connected, so a host that reloads does not greet ghosts
    for (const [id, name] of this.roster) this.send(ws, { t: 'join', id, name, replay: 1, online: this.players.has(id) ? 1 : 0 });
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.to) { const p = this.players.get(m.to); delete m.to; if (p) this.send(p, m); }
      else for (const p of this.players.values()) this.send(p, m);
    });
    ws.addEventListener('close', () => {
      if (this.host !== ws) return;
      this.host = null;
      for (const p of this.players.values()) this.send(p, { t: 'hostgone' });
    });
  }
  setupPlayer(ws, name, token) {
    // the reconnect token IS the identity — ids survive even a Durable Object restart
    const id = 'p' + (token ? token.replace(/[^a-z0-9]/gi, '').slice(0, 12) : Math.random().toString(36).slice(2, 10));
    const rejoined = this.roster.has(id) ? 1 : 0;
    const old = this.players.get(id);
    if (old && old !== ws) { try { old.close(); } catch (e) {} }
    this.players.set(id, ws);
    if (name || !this.roster.has(id)) this.roster.set(id, name || 'Player');
    this.send(ws, { t: 'welcome', id, name: this.roster.get(id), rejoined });
    if (!this.host) this.send(ws, { t: 'nohost' });          // scanned before the big screen opened the room; the host gets the roster when it connects
    if (this.host) this.send(this.host, { t: 'join', id, name: this.roster.get(id), rejoin: rejoined });
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      m.id = id;
      if (this.host) this.send(this.host, m);
    });
    ws.addEventListener('close', () => {
      if (this.players.get(id) !== ws) return;          // an old socket dying after a rejoin — ignore
      this.players.delete(id);
      if (this.host) this.send(this.host, { t: 'leave', id });
    });
  }
}

/* The rooms directory: one object for the whole site. It mints codes that are free, records which page
   opened each room, expires idle rooms, and answers /j/CODE. A code brought by a page (a vanity room, a
   presentation-derived one) is claimed here too, and refused when another page holds it. */
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';        // no 0 O 1 I L: nothing to confuse when typed
const CODE_RE = /^[A-Z0-9-]{4,32}$/;
const ROOM_TTL = 12 * 3600 * 1000;                          // idle this long and the code recycles

export class RoomDir {
  constructor(state) { this.storage = state.storage; }
  async get(code) {
    const r = await this.storage.get(code);
    if (!r) return null;
    if (Date.now() - r.lastSeen > ROOM_TTL) { await this.storage.delete(code); return null; }
    return r;
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/claim' && req.method === 'POST') {
      let body = {}; try { body = await req.json(); } catch (e) {}
      const page = typeof body.page === 'string' && /^\/[a-z0-9\-\/]{0,80}$/i.test(body.page) ? body.page : '';
      let code = typeof body.code === 'string' ? body.code.toUpperCase() : '';
      if (code) {
        if (!CODE_RE.test(code)) return Response.json({ error: 'bad code' }, { status: 400 });
        const held = await this.get(code);
        if (held && held.page !== page) return Response.json({ conflict: { code, heldBy: held.page, since: held.createdAt } }, { status: 409 });
        await this.storage.put(code, { page, createdAt: held ? held.createdAt : Date.now(), lastSeen: Date.now() });
        return Response.json({ code }, { status: 201 });
      }
      for (let n = 4; n <= 8; n++) {                          // four characters; longer only if the space is crowded
        for (let tries = 0; tries < 8; tries++) {
          code = Array.from({ length: n }, () => CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)]).join('');
          if (!(await this.get(code))) {
            await this.storage.put(code, { page, createdAt: Date.now(), lastSeen: Date.now() });
            return Response.json({ code }, { status: 201 });
          }
        }
      }
      return Response.json({ error: 'no free code' }, { status: 503 });
    }
    if (url.pathname === '/lookup') {
      const r = await this.get((url.searchParams.get('code') || '').toUpperCase());
      if (r && url.searchParams.get('touch')) await this.storage.put(url.searchParams.get('code').toUpperCase(), Object.assign(r, { lastSeen: Date.now() }));
      return Response.json(r || null);
    }
    return new Response('Not found', { status: 404 });
  }
}

const dir = env => env.ROOMDIR.get(env.ROOMDIR.idFromName('rooms'));
async function lookup(env, code, touch) {
  try { return await (await dir(env).fetch('https://dir/lookup?code=' + encodeURIComponent(code) + (touch ? '&touch=1' : ''))).json(); }
  catch (e) { return null; }
}
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/api/room' && req.method === 'POST') {
      // pages without a body (the older games) still get a plain minted code
      let body = {}; try { body = await req.json(); } catch (e) {}
      const res = await dir(env).fetch('https://dir/claim', { method: 'POST', body: JSON.stringify(body) });
      const out = await res.json();
      if (res.status === 201) out.joinUrl = url.origin + '/j/' + out.code;
      return Response.json(out, { status: res.status });
    }
    const j = url.pathname.match(/^\/j\/([A-Za-z0-9-]{4,32})$/);
    if (j) {
      const r = await lookup(env, j[1]);
      if (r && r.page) return Response.redirect(url.origin + r.page + '?join=' + j[1].toUpperCase(), 302);
      return new Response('This room has ended. Ask the big screen for a new code.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const ws = url.pathname.match(/^\/ws\/([A-Za-z0-9-]{4,32})$/);
    if (ws) {
      // a room the directory knows is namespaced by its page, so a stale code from another game never lands here;
      // a code it does not know (older games mint without registering) keeps the plain name
      const code = ws[1].toUpperCase();
      const r = await lookup(env, code, true);
      return env.ROOM.get(env.ROOM.idFromName(r && r.page ? r.page + ':' + code : code)).fetch(req);
    }
    const mws = url.pathname.match(/^\/mws\/([A-Za-z0-9]{4,8})$/);
    if (mws) return env.MARSH.get(env.MARSH.idFromName(mws[1].toUpperCase())).fetch(req);
    const join = url.pathname.match(/^\/sq\/([A-Za-z0-9]{4,8})$/);
    if (join) return Response.redirect(url.origin + '/survival-quiz?join=' + join[1].toUpperCase(), 302);
    const brawl = url.pathname.match(/^\/sb\/([A-Za-z0-9]{4,8})$/);
    if (brawl) return Response.redirect(url.origin + '/survival-brawl?join=' + brawl[1].toUpperCase(), 302);
    const bq = url.pathname.match(/^\/bq\/([A-Za-z0-9]{4,8})$/);
    if (bq) return Response.redirect(url.origin + '/brawl-quiz?join=' + bq[1].toUpperCase(), 302);
    const mm = url.pathname.match(/^\/mm\/([A-Za-z0-9]{4,8})$/);
    if (mm) return Response.redirect(url.origin + '/marshmallow?join=' + mm[1].toUpperCase(), 302);
    const ml = url.pathname.match(/^\/ml\/([A-Za-z0-9]{4,8})$/);
    if (ml) return Response.redirect(url.origin + '/marshmallow-live?join=' + ml[1].toUpperCase(), 302);
    const tr = url.pathname.match(/^\/tr\/([A-Za-z0-9]{4,8})$/);
    if (tr) return Response.redirect(url.origin + '/tower-raid?join=' + tr[1].toUpperCase(), 302);
    const cs = url.pathname.match(/^\/cs\/([A-Za-z0-9]{4,8})$/);
    if (cs) return Response.redirect(url.origin + '/color-and-sound?join=' + cs[1].toUpperCase(), 302);
    return new Response('Not found', { status: 404 });
  }
};
