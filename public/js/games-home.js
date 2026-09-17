/* The games showcase: renders /games.json as cards with screenshots. Used by the home page on play.ahaslides.io and by the
   asset catalog on games.ahaslides.io (which loads it cross-origin, so every URL is absolute).
   gamesHome(el, { base, groups, builders }) — or gamesHome.load(el, url) to fetch the list first.
   A host page can theme it with CSS variables on the container: --gh-fg, --gh-card, --gh-tag, --gh-line, --gh-accent (focus ring),
   and --gh-btn-bg / --gh-btn-fg for the main buttons (keep that pair at 4.5:1 or better in every theme the host supports). */
(function () {
  'use strict';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CSS = `
  .gh { font-family: Fredoka, system-ui, -apple-system, Segoe UI, sans-serif; color: var(--gh-fg, #20303f); }
  .gh h2 { font-size: 22px; margin: 26px 0 4px; } .gh h2:first-child { margin-top: 0; }
  .gh .note { margin: 0 0 12px; opacity: .7; font-size: 14px; }
  .gh .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 16px; padding: 0; }
  .gh .card { background: var(--gh-card, #fff); border-radius: 18px; overflow: hidden; box-shadow: 0 6px 22px rgba(0,0,0,.10); display: flex; flex-direction: column; border: 1px solid var(--gh-line, transparent); }
  .gh .shot { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #dfe8f0; }
  .gh .body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .gh .title { font-size: 18px; font-weight: 700; margin: 0; display: flex; gap: 8px; align-items: center; }
  .gh .blurb { margin: 0; font-size: 14px; line-height: 1.45; opacity: .88; flex: 1; }
  .gh .tags { display: flex; flex-wrap: wrap; gap: 4px; } .gh .tag { font-size: 11px; background: var(--gh-tag, #eef3f8); border-radius: 999px; padding: 2px 8px; opacity: .85; }
  .gh .btns { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
  .gh a.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; text-decoration: none; font-weight: 600; font-size: 15px; line-height: 1.2; border-radius: 12px; padding: 8px 16px; background: var(--gh-btn-bg, #2f6fc4); color: var(--gh-btn-fg, #fff); }
  .gh a.btn.ghost { background: var(--gh-tag, #eef3f8); color: var(--gh-fg, #20303f); box-shadow: inset 0 0 0 1px var(--gh-line, transparent); }
  .gh a:focus-visible { outline: 3px solid var(--gh-accent, #2f6fc4); outline-offset: 2px; }
  .gh .gh-err { margin: 0; }
  .gh .builders { display: flex; flex-wrap: wrap; gap: 12px; }
  .gh .builders a { text-decoration: none; color: inherit; background: var(--gh-card, #fff); border: 1px solid var(--gh-line, #e3e9f0); border-radius: 14px; padding: 10px 14px; flex: 1 1 min(240px, 100%); min-height: 44px; }
  .gh .builders a b { display: block; margin-bottom: 2px; } .gh .builders a span { font-size: 13px; opacity: .75; }`;
  function ensureCss() { if (document.getElementById('gh-css')) return; const st = document.createElement('style'); st.id = 'gh-css'; st.textContent = CSS; document.head.appendChild(st); }
  function render(el, data) {
    ensureCss(); const base = (data.base || '').replace(/\/$/, '');
    const abs = p => /^https?:/.test(p) ? p : base + p;
    el.classList.add('gh');
    el.innerHTML = (data.groups || []).map(g => `
      <h2>${esc(g.title)}</h2><p class="note">${esc(g.note || '')}</p>
      <div class="grid">${(g.games || []).map(x => `
        <div class="card" id="game-${esc(x.id)}">
          <img class="shot" loading="lazy" src="${abs('/screens/' + x.id + '.jpg')}" alt="">
          <div class="body">
            <h3 class="title"><span aria-hidden="true">${esc(x.icon || '')}</span>${esc(x.title)}</h3>
            <p class="blurb">${esc(x.blurb)}</p>
            <div class="tags">${(x.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
            <div class="btns">
              <a class="btn" href="${abs(x.path)}" target="_blank" rel="noopener">${x.play ? 'Host on big screen' : 'Play'}</a>
              ${x.play ? `<a class="btn ghost" href="${abs(x.play)}" target="_blank" rel="noopener">Open solo</a>` : ''}
              ${x.alt ? `<a class="btn ghost" href="${abs(x.alt.path)}" target="_blank" rel="noopener">${esc(x.alt.label)}</a>` : ''}
            </div>
          </div>
        </div>`).join('')}</div>`).join('') +
      (data.builders && data.builders.length ? `<h2>For builders</h2><div class="builders">${data.builders.map(b => `<a href="${esc(b.url || abs(b.path))}" target="_blank" rel="noopener"><b>${esc(b.title)}</b><span>${esc(b.blurb)}</span></a>`).join('')}</div>` : '');
  }
  function load(el, url) {
    return fetch(url, { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); })
      .then(d => { render(el, d); return d; })
      .catch(e => {
        // an empty live region first, then the text, so screen readers announce the failure
        el.textContent = ''; const msg = document.createElement('p'); msg.className = 'gh-err'; msg.setAttribute('role', 'status'); el.appendChild(msg);
        setTimeout(() => { msg.textContent = 'Could not load the games list.'; }, 50);
        throw e;
      });
  }
  render.load = load; window.gamesHome = render;
})();
