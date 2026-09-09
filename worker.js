/* tiny-kingdom worker: static assets + multiplayer relay (host-authoritative) for Survival Quiz, Survival Brawl, Brawl Quiz and the Marshmallow Challenge */

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
    for (const [id, name] of this.roster) this.send(ws, { t: 'join', id, name });
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/room' && req.method === 'POST') {
      const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const code = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
      return Response.json({ code });
    }
    const ws = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4,8})$/);
    if (ws) return env.ROOM.get(env.ROOM.idFromName(ws[1].toUpperCase())).fetch(req);
    const join = url.pathname.match(/^\/sq\/([A-Za-z0-9]{4,8})$/);
    if (join) return Response.redirect(url.origin + '/survival-quiz?join=' + join[1].toUpperCase(), 302);
    const brawl = url.pathname.match(/^\/sb\/([A-Za-z0-9]{4,8})$/);
    if (brawl) return Response.redirect(url.origin + '/survival-brawl?join=' + brawl[1].toUpperCase(), 302);
    const bq = url.pathname.match(/^\/bq\/([A-Za-z0-9]{4,8})$/);
    if (bq) return Response.redirect(url.origin + '/brawl-quiz?join=' + bq[1].toUpperCase(), 302);
    const mm = url.pathname.match(/^\/mm\/([A-Za-z0-9]{4,8})$/);
    if (mm) return Response.redirect(url.origin + '/marshmallow?join=' + mm[1].toUpperCase(), 302);
    return new Response('Not found', { status: 404 });
  }
};
