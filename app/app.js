const OWNER = 'carlopignatari-boop';
const WF = 'update.yml';
const PLAYERS = [
  { id: 'pignatari', name: 'Pignatari', tess: '131413', repo: 'pignatari-golf' },
  { id: 'berilli',   name: 'Berilli',   tess: '106712', repo: 'berilli-golf' },
];
const API = 'https://api.github.com';
const PAGES = r => `https://${OWNER}.github.io/${r}/`;
const $ = s => document.querySelector(s);
const token = () => localStorage.getItem('figsync.token') || '';
const busy = {};

function headers(auth = true) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (auth && token()) h.Authorization = `Bearer ${token()}`;
  return h;
}
async function gh(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  if (!res.ok && res.status !== 204) {
    let msg = res.status + '';
    try { msg += ' ' + (await res.json()).message; } catch {}
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return res.status === 204 ? null : res.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = iso => new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2800); }

function render() {
  $('#cards').innerHTML = PLAYERS.map(p => `
    <article class="card" id="c-${p.id}" data-p="${p.id}">
      <div class="card-head"><span class="name">${p.name}</span><span class="tess">Tessera ${p.tess}</span></div>
      <div class="metrics">
        <div class="metric"><b data-k="idx">—</b><span>Index FIG</span></div>
        <div class="metric"><b data-k="sd">—</b><span>Media top 8</span></div>
      </div>
      <div class="status"><span class="dot" data-k="dot"></span><span data-k="msg">Lettura stato…</span></div>
      <div class="steps" data-k="steps" hidden><i></i><i></i><i></i></div>
      <div class="card-actions">
        <a class="btn" href="${PAGES(p.repo)}" target="_blank" rel="noopener">Apri pagina</a>
        <button class="btn go" data-run="${p.id}">Aggiorna</button>
      </div>
    </article>`).join('');
  PLAYERS.forEach(p => { document.getElementById('v-' + p.id).innerHTML = `
    <div class="bar" data-p="${p.id}">
      <span class="who">${p.name}</span>
      <span class="status"><span class="dot" data-k="dot"></span><span data-k="msg">…</span></span>
      <button class="chip alt" data-reload="${p.id}" aria-label="Ricarica pagina">↻</button>
      <button class="chip" data-run="${p.id}">Aggiorna</button>
      <div class="steps" data-k="steps" hidden><i></i><i></i><i></i></div>
    </div>
    <iframe class="frame" id="f-${p.id}" title="Snippet ${p.name}" loading="lazy"></iframe>`; });
  document.querySelectorAll('[data-reload]').forEach(b => b.onclick = () => reloadFrame(PLAYERS.find(p => p.id === b.dataset.reload)));
  document.querySelectorAll('[data-run]').forEach(b => b.onclick = () => run(PLAYERS.find(p => p.id === b.dataset.run)));
}
const qa = (p, k) => [...document.querySelectorAll(`[data-p="${p.id}"] [data-k="${k}"]`)];
const q = (p, k) => qa(p, k)[0];
function setStatus(p, kind, msg) { qa(p, 'dot').forEach(d => d.className = 'dot ' + (kind || '')); qa(p, 'msg').forEach(m => m.textContent = msg); }
function setSteps(p, stage, bad) { // stage 0..3
  qa(p, 'steps').forEach(s => { s.hidden = stage == null;
  [...s.children].forEach((i, n) => { i.className = bad && n === stage ? 'bad' : n < stage ? 'on' : n === stage ? 'now' : ''; }); });
}
function setBtn(p, dis) { document.querySelectorAll(`[data-run="${p.id}"]`).forEach(b => b.disabled = dis); updateAll(); }
function updateAll() { $('#runAll').disabled = PLAYERS.some(p => busy[p.id]); }

async function loadData(p) {
  try {
    const r = await fetch(PAGES(p.repo) + 'scraper/last_run.json?t=' + Date.now(), { cache: 'no-store' });
    const d = await r.json();
    q(p, 'idx').textContent = d.stats?.idx_fig?.toFixed(1) ?? '—';
    q(p, 'sd').textContent = d.stats?.avg_sd?.toFixed(1) ?? '—';
    return d.updated_at;
  } catch { return null; }
}
async function loadStatus(p) {
  const upd = await loadData(p);
  if (busy[p.id]) return;
  try {
    const d = await gh(`/repos/${OWNER}/${p.repo}/actions/workflows/${WF}/runs?per_page=1`);
    const r = d.workflow_runs[0];
    if (!r) return setStatus(p, '', 'Nessun run');
    if (r.status !== 'completed') { setStatus(p, 'run', 'Aggiornamento in corso…'); return; }
    const ok = r.conclusion === 'success';
    setStatus(p, ok ? 'ok' : 'err', `${ok ? 'Dati FIG' : 'Ultimo run fallito'} · ${upd ? upd.replace(/\/\d{4}/, '') : fmt(r.updated_at)}`);
  } catch (e) {
    setStatus(p, '', upd ? `Dati FIG · ${upd.replace(/\/\d{4}/, '')}` : 'Stato non disponibile');
  }
}

async function run(p) {
  if (!token()) { openSettings(); return; }
  if (busy[p.id]) return;
  busy[p.id] = true; setBtn(p, true);
  const t0 = Date.now() - 5000;
  try {
    setStatus(p, 'run', 'Avvio…'); setSteps(p, 0);
    await gh(`/repos/${OWNER}/${p.repo}/actions/workflows/${WF}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
    // 1) trova il run appena creato
    let runObj = null;
    for (let i = 0; i < 30 && !runObj; i++) {
      await sleep(3000);
      const d = await gh(`/repos/${OWNER}/${p.repo}/actions/workflows/${WF}/runs?event=workflow_dispatch&per_page=3`);
      runObj = d.workflow_runs.find(r => new Date(r.created_at).getTime() >= t0);
      setStatus(p, 'run', 'In coda su GitHub…');
    }
    if (!runObj) throw new Error('Run non trovato');
    setSteps(p, 1); setStatus(p, 'run', 'Lettura dati FIG…');
    // 2) attende fine scraper
    while (runObj.status !== 'completed') {
      await sleep(5000);
      runObj = await gh(`/repos/${OWNER}/${p.repo}/actions/runs/${runObj.id}`);
    }
    if (runObj.conclusion !== 'success') { setSteps(p, 1, true); throw new Error('Run ' + runObj.conclusion); }
    // 3) attende la pubblicazione Pages
    setSteps(p, 2); setStatus(p, 'run', 'Pubblicazione pagina…');
    const tDone = new Date(runObj.updated_at).getTime() - 5000;
    for (let i = 0; i < 40; i++) {
      await sleep(5000);
      const d = await gh(`/repos/${OWNER}/${p.repo}/actions/runs?event=dynamic&per_page=3`);
      const pg = d.workflow_runs.find(r => r.name === 'pages build and deployment' && new Date(r.created_at).getTime() >= tDone);
      if (pg && pg.status === 'completed') break;
      if (!pg && i > 6) break; // nessun commit nuovo: dati invariati
    }
    setSteps(p, 3); busy[p.id] = false;
    reloadFrame(p);
    await loadStatus(p);
    toast(`${p.name} aggiornato`);
  } catch (e) {
    busy[p.id] = false;
    const m = e.status === 401 ? 'Token scaduto o revocato: aprine uno nuovo dall\'ingranaggio' : e.status === 403 || e.status === 404 ? 'Token senza permesso Actions' : e.message;
    setStatus(p, 'err', m); toast(`${p.name}: ${m}`);
    if (e.status) setSteps(p, null);
  } finally { busy[p.id] = false; setBtn(p, false); }
}

function openSettings() { $('#tokenInput').value = token(); $('#tokenState').textContent = token() ? 'Token salvato su questo dispositivo.' : ''; $('#settings').showModal(); }
async function saveToken() {
  const v = $('#tokenInput').value.replace(/[\s"'`]/g, '');
  if (!v) return;
  if (!/^(github_pat_|ghp_)/.test(v)) { $('#tokenState').textContent = 'Il codice deve iniziare con github_pat_ — hai incollato altro (' + v.slice(0, 12) + '…).'; return; }
  if (v.startsWith('github_pat_') && v.length !== 93) { $('#tokenState').textContent = 'Codice incompleto: ' + v.length + ' caratteri su 93. Copialo di nuovo con l\'icona di copia.'; return; }
  const prev = token();
  localStorage.setItem('figsync.token', v);
  $('#tokenState').textContent = 'Verifica…';
  try {
    for (const p of PLAYERS) await gh(`/repos/${OWNER}/${p.repo}/actions/workflows/${WF}`);
    localStorage.removeItem('figsync.dropped');
    $('#tokenState').textContent = 'Token valido per entrambi i repo.';
    refreshNotice(); setTimeout(() => $('#settings').close(), 700); toast('Token salvato');
  } catch (e) {
    if (e.status === 401) { prev && prev !== v ? localStorage.setItem('figsync.token', prev) : dropToken('GitHub ha rifiutato il token (401)'); }
    else { $('#tokenState').textContent = 'Token salvato, ma la verifica non è riuscita (' + e.message + '). Riprova più tardi.'; refreshNotice(); return; }
    $('#tokenState').textContent = e.status === 401 ? 'GitHub non riconosce il token (401, ' + v.length + ' caratteri, finisce con …' + v.slice(-4) + '). È scaduto o è stato rigenerato dopo la copia: creane uno nuovo.' : 'Errore: ' + e.message;
  }
}
function dropToken(reason) {
  localStorage.removeItem('figsync.token');
  localStorage.setItem('figsync.dropped', JSON.stringify({ reason, at: new Date().toISOString() }));
}
function refreshNotice() {
  const el = $('#noToken'); el.hidden = !!token();
  if (token()) { localStorage.setItem('figsync.since', localStorage.getItem('figsync.since') || new Date().toISOString()); return; }
  let why = '';
  try { const d = JSON.parse(localStorage.getItem('figsync.dropped') || 'null'); if (d) why = `Token rimosso il ${fmt(d.at)}: ${d.reason}.`; } catch {}
  if (!why && !localStorage.getItem('figsync.seen')) why = (navigator.standalone ? 'Prima apertura dell\'app dalla schermata Home: ha una memoria separata da Safari.' : 'Nessun token su questo browser.');
  el.firstChild.textContent = (why ? why + ' ' : '') + 'Serve un token GitHub per avviare l\'aggiornamento. ';
  localStorage.setItem('figsync.seen', '1');
}

$('#showToken').onclick = () => { const i = $('#tokenInput'); i.type = i.type === 'password' ? 'text' : 'password'; $('#showToken').textContent = i.type === 'password' ? 'Mostra' : 'Nascondi'; };
$('#openSettings').onclick = openSettings;
$('#noTokenBtn').onclick = openSettings;
$('#saveToken').onclick = saveToken;
$('#clearToken').onclick = () => { dropToken('rimosso a mano con il pulsante Rimuovi'); $('#tokenInput').value = ''; $('#tokenState').textContent = 'Token rimosso.'; refreshNotice(); };
$('#runAll').onclick = () => { if (!token()) return openSettings(); PLAYERS.forEach(run); };

function reloadFrame(p) { const f = document.getElementById('f-' + p.id); f.src = PAGES(p.repo) + '?t=' + Date.now(); }
function show(tab) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.dataset.view === tab));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const p = PLAYERS.find(x => x.id === tab);
  if (p) { const f = document.getElementById('f-' + p.id); if (!f.src) reloadFrame(p); }
  localStorage.setItem('figsync.tab', tab);
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab);
}
render(); refreshNotice();
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => show(b.dataset.tab));
const startTab = location.hash.slice(1) || localStorage.getItem('figsync.tab') || 'berilli';
show(['berilli', 'pignatari', 'sync'].includes(startTab) ? startTab : 'berilli');
PLAYERS.forEach(loadStatus);
document.addEventListener('visibilitychange', () => { if (!document.hidden) PLAYERS.forEach(loadStatus); });
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
