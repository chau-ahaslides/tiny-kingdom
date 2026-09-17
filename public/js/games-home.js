/* The games showcase: renders /games.json as cards with screenshots. Used by the home page on play.ahaslides.io and by the
   asset catalog on games.ahaslides.io (which loads it cross-origin, so every URL is absolute).
   gamesHome(el, { base, groups, builders }) — a group with "layout": "compact" renders as rows; data-level on the container sets the heading level — or gamesHome.load(el, url) to fetch the list first.
   A host page can theme it with CSS variables on the container: --gh-fg, --gh-card, --gh-tag, --gh-line, --gh-accent (focus ring),
   and --gh-btn-bg / --gh-btn-fg for the main buttons (keep that pair at 4.5:1 or better in every theme the host supports). */
(function () {
  'use strict';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CSS = `
  .gh { --gh-s1: 4px; --gh-s2: 8px; --gh-s3: 12px; --gh-s4: 16px; --gh-s5: 24px; --gh-s6: 40px;
    font-family: Fredoka, system-ui, -apple-system, Segoe UI, sans-serif; color: var(--gh-fg, #20303f); }
  .gh .gh-group + .gh-group { margin-top: var(--gh-s6); }
  .gh .gh-head { margin: 0 0 var(--gh-s4); max-width: 70ch; }
  .gh .gh-head > :first-child { font-size: 22px; line-height: 1.2; margin: 0 0 var(--gh-s1); }
  .gh .note { margin: 0; opacity: .78; font-size: 14px; line-height: 1.45; }
  .gh .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: var(--gh-s5) var(--gh-s4); padding: 0; }
  .gh .card { background: var(--gh-card, #fff); border-radius: 18px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 6px 18px rgba(0,0,0,.07); display: flex; flex-direction: column; border: 1px solid var(--gh-line, transparent); }
  .gh .shot { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #dfe8f0; }
  .gh .body { padding: var(--gh-s4) var(--gh-s4) var(--gh-s4); display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .gh .title { font-size: 19px; line-height: 1.2; font-weight: 700; margin: 0 0 var(--gh-s2); display: flex; gap: var(--gh-s2); align-items: baseline; }
  .gh .blurb { margin: 0 0 var(--gh-s3); font-size: 14px; line-height: 1.5; opacity: .88; }
  .gh .tags { display: flex; flex-wrap: wrap; gap: var(--gh-s1); margin: 0 0 var(--gh-s4); }
  .gh .tag { font-size: 12px; line-height: 1.5; background: var(--gh-tag, #eef3f8); border-radius: 999px; padding: 1px 9px; }
  .gh .btns { display: flex; gap: var(--gh-s2); flex-wrap: wrap; margin-top: auto; }
  .gh a.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; text-decoration: none; font-weight: 600; font-size: 15px; line-height: 1.2; border-radius: 12px; padding: 8px 14px; background: var(--gh-btn-bg, #2f6fc4); color: var(--gh-btn-fg, #fff); }
  .gh a.btn.ghost { background: var(--gh-tag, #eef3f8); color: var(--gh-fg, #20303f); box-shadow: inset 0 0 0 1px var(--gh-line, transparent); }
  .gh a:focus-visible { outline: 3px solid var(--gh-accent, #2f6fc4); outline-offset: 2px; }
  .gh .gh-err { margin: 0; }
  /* compact groups: a two-up list of rows, thumbnail beside the text, so the secondary games don't repeat the big cards */
  .gh .rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(460px, 100%), 1fr)); gap: var(--gh-s3) var(--gh-s4); }
  .gh .row { display: grid; grid-template-columns: 168px 1fr; background: var(--gh-card, #fff); border: 1px solid var(--gh-line, #e3e9f0); border-radius: 14px; overflow: hidden; }
  .gh .row .shot { height: 100%; aspect-ratio: auto; min-height: 120px; }
  .gh .row .body { padding: var(--gh-s3) var(--gh-s4); }
  .gh .row .title { font-size: 17px; margin-bottom: var(--gh-s1); }
  .gh .row .blurb { font-size: 13.5px; margin-bottom: var(--gh-s2); }
  .gh .row .tags { margin-bottom: var(--gh-s3); }
  @media (max-width: 520px) {
    .gh .row { grid-template-columns: 104px 1fr; }
    .gh .row .shot { min-height: 0; }
    .gh .row .tags { display: none; }
  }
  .gh .builders { display: flex; flex-wrap: wrap; gap: var(--gh-s3); }
  .gh .builders a { text-decoration: none; color: inherit; background: var(--gh-card, #fff); border: 1px solid var(--gh-line, #e3e9f0); border-radius: 14px; padding: var(--gh-s3) var(--gh-s4); flex: 1 1 min(240px, 100%); min-height: 44px; }
  .gh .builders a b { display: block; margin-bottom: 2px; } .gh .builders a span { font-size: 13px; opacity: .78; }`;
  function ensureCss() { if (document.getElementById('gh-css')) return; const st = document.createElement('style'); st.id = 'gh-css'; st.textContent = CSS; document.head.appendChild(st); }
  function render(el, data) {
    ensureCss(); const base = (data.base || '').replace(/\/$/, '');
    const abs = p => /^https?:/.test(p) ? p : base + p;
    // a host page that already has a section heading can push these down a level: <div data-level="3">
    const lv = Math.min(5, Math.max(2, parseInt(el.dataset.level, 10) || 2)), h = `h${lv}`, h3 = `h${lv + 1}`;
    const btns = x => `<div class="btns">
              <a class="btn" href="${abs(x.path)}" target="_blank" rel="noopener">${x.play ? 'Host on big screen' : 'Play'}</a>
              ${x.play ? `<a class="btn ghost" href="${abs(x.play)}" target="_blank" rel="noopener">Open solo</a>` : ''}
              ${x.alt ? `<a class="btn ghost" href="${abs(x.alt.path)}" target="_blank" rel="noopener">${esc(x.alt.label)}</a>` : ''}
            </div>`;
    const item = (x, cls) => `
        <div class="${cls}" id="game-${esc(x.id)}">
          <img class="shot" loading="lazy" src="${abs('/screens/' + x.id + '.jpg')}" alt="">
          <div class="body">
            <${h3} class="title"><span aria-hidden="true">${esc(x.icon || '')}</span>${esc(x.title)}</${h3}>
            <p class="blurb">${esc(x.blurb)}</p>
            <div class="tags">${(x.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
            ${btns(x)}
          </div>
        </div>`;
    el.classList.add('gh');
    el.innerHTML = (data.groups || []).map(g => {
      const compact = g.layout === 'compact';
      return `<section class="gh-group">
      <div class="gh-head"><${h}>${esc(g.title)}</${h}>${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}</div>
      <div class="${compact ? 'rows' : 'grid'}">${(g.games || []).map(x => item(x, compact ? 'row' : 'card')).join('')}</div></section>`;
    }).join('') +
      (data.builders && data.builders.length ? `<section class="gh-group"><div class="gh-head"><${h}>For builders</${h}></div><div class="builders">${data.builders.map(b => `<a href="${esc(b.url || abs(b.path))}" target="_blank" rel="noopener"><b>${esc(b.title)}</b><span>${esc(b.blurb)}</span></a>`).join('')}</div></section>` : '');
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
