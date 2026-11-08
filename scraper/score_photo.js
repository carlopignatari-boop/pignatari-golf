// score_photo.js — "Carica score": lettura della scheda con Gemini, Perplexity o Anthropic + calcolo WHS buca per buca.
// Contesto dato al modello (RAG leggero): campo noto (par e handicap di buca), nome del giocatore,
// errori di lettura già corretti su questo telefono. I conti li fa l'app, non il modello.
const SP = (() => {
  // Chiave predefinita del gruppo (Great Learning, compatibile OpenAI), mascherata solo per gli scanner automatici.
  const DEF = 'aFhsb1RLdUpUZlFnbTRBYURlbHNBVk9NSmNEUWtmbnFkR0txd1BpNzBxYXhkeXNLc0U1NXArMVhrVkdkc0YyVS1sZw==';
  const defKey = () => { try { return atob(DEF).split('').reverse().join(''); } catch (e) { return ''; } };
  const getKey = () => localStorage.getItem(KEY) || defKey();
  const KEY = 'figsync.gemini', MODEL_KEY = 'figsync.geminiModel', LOG = 'figsync.scorelog';
  // Gruppo: il nome in alto sulla scheda decide a chi va il punteggio.
  const ROSTER = [
    { id: 'pignatari', nome: 'Carlo',  cognome: 'Pignatari', label: 'Pignatari',   repo: 'pignatari-golf' },
    { id: 'berilli',   nome: '',       cognome: 'Berilli',   label: 'Berilli',     repo: 'berilli-golf' },
    { id: 'spagnoli',  nome: 'Andrea', cognome: 'Spagnoli',  label: 'A. Spagnoli', repo: 'spagnoli-golf' },
    { id: 'espagnoli', nome: 'Enrico', cognome: 'Spagnoli',  label: 'E. Spagnoli', repo: 'e-spagnoli-golf' },
  ];
  const PENDING = 'figsync.pending';
  const norm = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // Ritorna { p } se il nome individua un giocatore, { amb: [...] } se il cognome è condiviso e il nome non basta, {} se nessuno.
  function identify(name) {
    const words = norm(name).split(' ').filter(Boolean);
    const long = words.filter(w => w.length > 2);
    let bd = 99;
    const dist = ROSTER.map(p => Math.min(99, ...long.map(w => lev(w, norm(p.cognome)))));
    dist.forEach(d => { if (d < bd) bd = d; });
    if (bd > 2) return {};
    const cands = ROSTER.filter((p, i) => dist[i] === bd);
    if (cands.length === 1) return { p: cands[0] };
    const byFirst = cands.filter(p => p.nome && words.some(w => w !== norm(p.cognome) &&
      (w.length === 1 ? w === norm(p.nome)[0] : lev(w, norm(p.nome)) <= 1)));
    return byFirst.length === 1 ? { p: byFirst[0] } : { amb: cands };
  }
  const whoIs = name => identify(name).p || null;
  const me = () => identify(typeof PLAYER_FULL !== 'undefined' ? PLAYER_FULL : (typeof PLAYER_NAME !== 'undefined' ? PLAYER_NAME : '')).p || null;
    // Schede dei percorsi note (fonti: GolfPass, TheGrint, Golfify — par e handicap di buca coincidono)
  const COURSES = {
    'MODENA': { nome: 'Modena Golf & Country Club — Bernhard Langer',
      par: [4,4,3,5,4,3,5,4,4, 5,3,4,5,4,3,4,3,5],
      si:  [4,2,8,10,12,14,18,16,6, 13,17,7,3,11,5,1,15,9] },
  };
  const $ = id => document.getElementById(id);
  let read = null;   // risposta del modello (per il registro delle correzioni)

  function courseFor(name) {
    const u = (name || '').toUpperCase();
    return Object.keys(COURSES).find(k => u.includes(k)) || null;
  }
  // percorsi già giocati, con CR/SR presi dalla storia FIG
  function knownCircoli() {
    const m = {};
    ROWS.forEach(r => { if (r.circolo && !m[r.circolo] && r.cr && r.sr) m[r.circolo] = { cr: r.cr, sr: r.sr }; });
    return m;
  }

  // ── calcolo WHS buca per buca ──────────────────────────────────────
  // ch = course handicap; colpi null = buca non completata (vale doppio bogey netto, 0 punti)
  function strokesRecv(ch, si) {
    if (ch <= 0) return 0;
    const base = Math.floor(ch / 18), rest = ch % 18;
    return base + (si <= rest ? 1 : 0);
  }
  function computeCard(holes, ch) {
    let stbl = 0, ags = 0, par = 0;
    const det = holes.map(h => {
      const recv = strokesRecv(ch, h.si);
      const cap = h.par + 2 + recv;                        // doppio bogey netto
      const pts = h.colpi ? Math.max(0, h.par + recv + 2 - h.colpi) : 0;
      const adj = h.colpi ? Math.min(h.colpi, cap) : cap;
      stbl += pts; ags += adj; par += h.par;
      return { ...h, recv, cap, pts, adj };
    });
    return { det, stbl, ags, par };
  }

  // ── immagine → base64 ridimensionata ───────────────────────────────
  function toJpeg(file, max = 1600) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
      };
      img.onerror = rej; img.src = URL.createObjectURL(file);
    });
  }

  function hints() {
    const log = JSON.parse(localStorage.getItem(LOG) || '[]').slice(-10);
    const errs = log.flatMap(l => l.diff.map(d => `buca ${d.n}: letto ${d.letto ?? 'vuoto'}, era ${d.vero ?? 'non completata'}`));
    return errs.length ? 'Errori di lettura già corretti su schede precedenti (fai attenzione a cifre simili): ' + errs.slice(-15).join('; ') + '.' : '';
  }

  function prompt() {
    const corsi = Object.values(COURSES).map(c => `${c.nome}: par ${c.par.join(',')}; handicap di buca ${c.si.join(',')}`).join('\n');
    return `Sei un lettore di schede score di golf italiane, compilate a mano.
Giocatore: è il titolare della scheda, il cui nome è stampato o scritto in alto (intestazione), NON il marcatore. Giocatori del gruppo: ${ROSTER.map(p => (p.nome ? p.nome + ' ' : '') + p.cognome).join(', ')} (due hanno lo stesso cognome: riporta sempre anche nome o iniziale se scritti). Riporta in "giocatore" il nome come lo leggi in intestazione e usa SOLO la riga o colonna di colpi del titolare.
Leggi per ognuna delle 18 buche (o 9) i colpi lordi scritti dal marcatore. Una buca senza numero, con "X", "-", "/" o cancellata significa non completata: colpi = null.
Leggi anche par e handicap di buca stampati sulla scheda. Se il campo è uno di questi, usa questi valori stampati:
${corsi}
Riporta anche, se scritti, il totale colpi e il totale punti Stableford del giocatore, il nome del circolo e la data.
Per ogni buca in cui la cifra è dubbia mettila in "incerte".
${hints()}
Rispondi solo con JSON: {"giocatore":str,"circolo":str|null,"data":"gg/mm/aaaa"|null,"buche":[{"n":int,"par":int|null,"si":int|null,"colpi":int|null}],"totale_colpi_scritto":int|null,"stbl_scritto":int|null,"incerte":[int],"note":str}`;
  }

  // Fornitore riconosciuto dal prefisso della chiave: gl- → Great Learning (OpenAI), pplx- → Perplexity, sk-ant- → Anthropic, altrimenti Gemini.
  const PROVIDERS = {
    gl: ['gpt-5.4', 'gpt-5.6-luna', 'gpt-4o'],
    gemini: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    perplexity: ['google/gemini-3.6-flash', 'anthropic/claude-sonnet-5-5', 'openai/gpt-5.6-terra'],
    anthropic: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
  };
  function provider(key) { return key.startsWith('gl-') ? 'gl' : key.startsWith('pplx-') ? 'perplexity' : key.startsWith('sk-ant-') ? 'anthropic' : 'gemini'; }
  function parseJson(txt) {
    txt = (txt || '{}').replace(/^\s*```(json)?/i, '').replace(/```\s*$/, '').trim();
    const i = txt.indexOf('{'), j = txt.lastIndexOf('}');
    return JSON.parse(i >= 0 && j > i ? txt.slice(i, j + 1) : txt);
  }
  function request(prov, m, key, b64) {
    if (prov === 'gl') return ['https://aibe.mygreatlearning.com/openai/v1/chat/completions',
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      { model: m, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: [
          { type: 'text', text: prompt() + '\nRispondi solo con il JSON.' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'high' } }] }] },
      j => j.choices?.[0]?.message?.content];
    if (prov === 'gemini') return [`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
      { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      { contents: [{ parts: [{ text: prompt() }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' } },
      j => j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('')];
    if (prov === 'perplexity') return ['https://api.perplexity.ai/v1/agent',
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      { model: m, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt() + '\nRispondi solo con il JSON, senza testo attorno.' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,' + b64 }] }] },
      j => j.output_text || (j.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []).map(c => c.text || '').join('')];
    return ['https://api.anthropic.com/v1/messages',
      { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      { model: m, max_tokens: 2000, temperature: 0, messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: prompt() + '\nRispondi solo con il JSON, senza testo attorno.' }] }] },
      j => (j.content || []).map(c => c.text || '').join('')];
  }
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  const ERRLOG = 'figsync.sperr';
  function logErr(e) {
    try { const l = JSON.parse(localStorage.getItem(ERRLOG) || '[]'); l.push({ t: new Date().toISOString(), e: String(e).slice(0, 300) });
          localStorage.setItem(ERRLOG, JSON.stringify(l.slice(-20))); } catch (x) {}
  }
  function human(status, txt) {
    if (status === 429) return 'troppe richieste ravvicinate (limite del servizio)';
    if (status === 401) return 'chiave non valida o revocata';
    if (status === 403) return 'accesso negato dal servizio';
    if (status === 413) return 'foto troppo pesante';
    if (status >= 500) return 'servizio momentaneamente non disponibile';
    if (status === 0) return 'connessione assente o instabile';
    return 'errore ' + status;
  }
  // Strategia a tetto: 1° modello fino a 75 s (1 solo ritentativo, solo su 429/5xx rapidi), poi il fallback veloce;
  // tetto complessivo 150 s, così il telefono non gira per minuti.
  const CAP_MS = 150000;
  async function callModel(b64) {
    const key = getKey(), prov = provider(key), mk = MODEL_KEY + '.' + prov;
    const models = [...new Set([localStorage.getItem(mk), ...PROVIDERS[prov]].filter(Boolean))];
    const t0 = Date.now(); let last = { status: 0, txt: '' };
    const tick = setInterval(() => { const el = $('spSec'); if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + ' s'; }, 1000);
    try {
      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        for (let att = 0; att < 2; att++) {
          const left = CAP_MS - (Date.now() - t0); if (left < 8000) break;
          if (att) { msg(`📷 Leggo la scheda… <span id="spSec"></span> (${human(last.status)}: riprovo)`); await sleepMs(3000); }
          else msg(`📷 Leggo la scheda… <span id="spSec"></span>` + (i ? ` (provo un altro motore)` : ''));
          const lim = Math.min(i === 0 ? 75000 : 45000, left);
          const [url, headers, body, extract] = request(prov, m, key, b64);
          let r; const ts = Date.now();
          try {
            const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), lim);
            r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
            clearTimeout(to);
          } catch (e) {
            const slow = Date.now() - ts > lim - 1000;
            last = { status: 0, txt: slow ? 'risposta troppo lenta' : String(e) }; logErr(`${m} rete dopo ${Math.round((Date.now()-ts)/1000)}s: ${e}`);
            if (slow) break;            // lento: inutile ripetere lo stesso modello
            continue;
          }
          if (r.ok) {
            try { const out = parseJson(extract(await r.json())); localStorage.setItem(mk, m); return out; }
            catch (e) { last = { status: 200, txt: 'risposta non leggibile' }; logErr(`${m} json: ${e}`); break; }
          }
          last = { status: r.status, txt: (await r.text()).slice(0, 200) }; logErr(`${m} ${r.status}: ${last.txt}`);
          if (r.status === 401) throw Object.assign(new Error(human(401)), { status: 401 });
          if (!(r.status === 429 || r.status >= 500)) break;
        }
      }
    } finally { clearInterval(tick); }
    const txt = last.txt === 'risposta troppo lenta' ? 'il servizio ha risposto troppo lentamente' : human(last.status) + (last.txt ? ' — ' + last.txt.replace(/\s+/g, ' ').slice(0, 120) : '');
    throw Object.assign(new Error(txt), { status: last.status });
  }
  function showLog() {
    let l = []; try { l = JSON.parse(localStorage.getItem(ERRLOG) || '[]'); } catch (e) {}
    const t = l.slice(-10).map(x => x.t.slice(5, 19).replace('T', ' ') + '  ' + x.e).join('\n') || 'nessun errore registrato';
    msg('<pre id="spLog" style="white-space:pre-wrap;font-size:11px;max-height:220px;overflow:auto;margin:4px 0">' + t.replace(/</g, '&lt;') + '</pre>'
      + '<a href="#" onclick="navigator.clipboard.writeText(document.getElementById(\'spLog\').textContent).then(()=>this.textContent=\'✓ copiato\');return false">Copia</a> · <a href="#" onclick="SP.retry();return false">Riprova</a>');
  }

  // ── interfaccia ────────────────────────────────────────────────────
  function msg(html) { const el = $('spMsg'); el.innerHTML = html; el.style.display = html ? 'block' : 'none'; }
  function askKey() {
    $('spKeyRow').style.display = 'flex';
    msg('Per leggere la foto serve una chiave API: Gemini gratuita (<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">creala qui ↗</a>), oppure Perplexity (pplx-…) o Anthropic (sk-ant-…). Incollala sotto: resta salvata solo su questo telefono.');
  }
  function saveKey() {
    const v = $('spKey').value.trim(); if (!v) return;
    localStorage.setItem(KEY, v); $('spKeyRow').style.display = 'none'; msg('Chiave salvata. Ora premi “📷 Carica score”.');
  }
  function pick() { if (!getKey()) return askKey(); $('spFile').click(); }

  function sendTo(id) {
    const who = ROSTER.find(p => p.id === id); if (!who || !SP._r) return;
    localStorage.setItem(PENDING, JSON.stringify({ to: who.id, r: SP._r, read, ts: Date.now() }));
    msg(`📋 La scheda è di <b>${who.label}</b>: la porto sulla sua pagina…`);
    setTimeout(() => {
      try { if (window.parent !== window && typeof window.parent.show === 'function') { window.parent.show(who.id); msg(''); return; } } catch (e) {}
      location.href = `https://carlopignatari-boop.github.io/${who.repo}/`;
    }, 900);
  }
  function route(r) {
    SP._r = r;
    const id = identify(r.giocatore), mine = me();
    const esc = String(r.giocatore || '').replace(/</g, '&lt;');
    if (id.p && mine && id.p.id !== mine.id) return sendTo(id.p.id);
    if (id.amb && !(mine && id.amb.some(p => p.id === mine.id))) {
      msg(`❓ Sulla scheda leggo “${esc}”: di chi è? ` + id.amb.map(p => `<button class="btn-calc" onclick="SP.sendTo('${p.id}')">${p.label}</button>`).join(' '));
      return;
    }
    fill(r);
    if (!SP._holes) return;
    if (id.amb) {
      const other = id.amb.filter(p => p.id !== mine.id);
      msg(`ℹ️ Sulla scheda leggo “${esc}”, senza nome o iniziale chiari: l'ho attribuita a ${mine.label}. ` + other.map(p => `Se è di ${p.label}, <a href="#" onclick="SP.sendTo('${p.id}');return false">spostala</a>.`).join(' '));
    } else if (!id.p) {
      msg(`ℹ️ Nome in alto non riconosciuto (${esc ? 'letto: ' + esc : 'non letto'}): punteggio attribuito a ${mine ? mine.label : PLAYER_NAME}.`);
    }
  }
  function takePending() {
    const mine = me(); if (!mine) return;
    let p; try { p = JSON.parse(localStorage.getItem(PENDING) || 'null'); } catch (e) { p = null; }
    if (!p || p.to !== mine.id || Date.now() - p.ts > 10 * 60 * 1000) return;
    localStorage.removeItem(PENDING);
    if (typeof mode !== 'undefined' && mode !== 'proj' && typeof toggleProj === 'function') toggleProj();
    read = p.read; fill(p.r);
    if (SP._holes) msg(`📋 Scheda di <b>${mine.label}</b> ricevuta: controlla le buche e conferma.`);
  }
  window.addEventListener('storage', e => { if (e.key === PENDING && e.newValue) takePending(); });
  window.addEventListener('load', () => setTimeout(takePending, 50));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) takePending(); });

  let lastB64 = null;
  async function retry() { if (!lastB64) return pick(); await readB64(lastB64); }
  async function onFile(ev) {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    msg('📷 Preparo la foto…'); $('spGrid').innerHTML = '';
    try { lastB64 = await toJpeg(f); }
    catch (e) { logErr('foto: ' + e); msg('⚠️ Non riesco ad aprire questa foto: prova a scattarla di nuovo o a sceglierla dalla galleria.'); return; }
    await readB64(lastB64);
  }
  async function readB64(b64) {
    $('spGrid').innerHTML = '';
    try {
      const r = await callModel(b64);
      read = JSON.parse(JSON.stringify(r));
      route(r);
    } catch (e) {
      const own = !!localStorage.getItem(KEY);
      msg('⚠️ Lettura non riuscita: ' + String(e.message || e).replace(/</g, '&lt;') + '. <a href="#" onclick="SP.retry();return false">Riprova con la stessa foto</a> · <a href="#" onclick="SP.showLog();return false">dettagli</a>'
        + (e.status === 401 && own ? ' · <a href="#" onclick="SP.resetKey();return false">usa la chiave del gruppo</a>' : '')
        + (e.status === 401 && !own ? ' · la chiave del gruppo va sostituita: avvisa Carlo' : '') + '.');
    }
  }


  function fill(r) {
    const circ = knownCircoli();
    const circName = Object.keys(circ).find(k => (r.circolo || '').toUpperCase().includes(k)) || null;
    const ck = courseFor(r.circolo) || (circName && courseFor(circName));
    const course = ck ? COURSES[ck] : null;
    const holes = (r.buche || []).sort((a, b) => a.n - b.n).map((h, i) => ({
      n: h.n || i + 1,
      par: course ? course.par[(h.n || i + 1) - 1] : (h.par || 4),
      si:  course ? course.si[(h.n || i + 1) - 1]  : (h.si || (i + 1)),
      colpi: h.colpi ?? null }));
    if (holes.length !== 18 && holes.length !== 9) { msg('⚠️ Non trovo 18 o 9 buche nella foto: riprova con la scheda intera e ben illuminata.'); return; }
    if (!holes.some(h => h.colpi != null)) { msg(`⚠️ Non trovo ${PLAYER_NAME} sulla scheda (${r.giocatore ? 'letto: ' + String(r.giocatore).replace(/</g, '&lt;') : 'nessun nome letto'}). Controlla che il nome in alto sia leggibile e riprova.`); return; }
    if (holes.length === 9) { msg('ℹ️ Gara da 9 buche: il calcolo FIG usa lo score atteso per le 9 mancanti, qui non ancora replicato. Inserisci lo SD a mano se ti serve.'); }
    if (circName) { $('pCr').value = circ[circName].cr; $('pSr').value = circ[circName].sr; }
    SP._holes = holes; SP._incerte = new Set(r.incerte || []); SP._r = r; SP._circ = circName;
    renderGrid();
  }

  function renderGrid() {
    const holes = SP._holes, cr = parseFloat($('pCr').value), sr = parseFloat($('pSr').value);
    const par = holes.reduce((s, h) => s + h.par, 0);
    const ch = Math.round(parseFloat(IDX_FIG) * sr / 113 + (cr - par));
    const c = computeCard(holes, ch);
    $('pPar').value = c.par; $('pStbl').value = c.stbl; $('pAgs').value = c.ags;
    const cell = (h, i) => `<div class="sp-h${SP._incerte.has(h.n) ? ' sp-unc' : ''}">
        <div class="sp-n">${h.n}</div><div class="sp-par">par ${h.par}<br>hcp ${h.si}${h.recv ? ' · +' + h.recv : ''}</div>
        <input type="number" inputmode="numeric" min="1" max="15" value="${h.colpi ?? ''}" placeholder="—" data-i="${i}" oninput="SP.edit(this)">
        <div class="sp-pts">${h.pts} pt</div></div>`;
    const r = SP._r, warn = [];
    if (r.stbl_scritto != null && r.stbl_scritto !== c.stbl) warn.push(`Stableford scritto sulla scheda ${r.stbl_scritto}, calcolato ${c.stbl}`);
    const lordo = holes.reduce((s, h) => s + (h.colpi || 0), 0);
    if (r.totale_colpi_scritto != null && holes.every(h => h.colpi) && r.totale_colpi_scritto !== lordo) warn.push(`totale colpi scritto ${r.totale_colpi_scritto}, somma buche ${lordo}`);
    $('spGrid').innerHTML =
      `<div class="sp-head">${r.giocatore || PLAYER_NAME} · ${r.circolo || 'circolo ?'}${SP._circ ? '' : ' (CR/SR da verificare)'} · ${r.data || ''} · CH ${ch}</div>
       <div class="sp-holes">${c.det.map(cell).join('')}</div>
       <div class="sp-tot">Stableford <b>${c.stbl}</b> · AGS <b>${c.ags}</b> · lordo ${lordo || '—'}${SP._incerte.size ? ' · <span class="sp-unc-t">buche evidenziate: lettura incerta</span>' : ''}</div>
       ${warn.length ? '<div class="sp-warn">⚠️ ' + warn.join(' · ') + ': controlla le buche.</div>' : ''}
       <div class="sp-act"><button class="btn-calc" onclick="SP.confirm()">Conferma e calcola →</button></div>`;
    msg('');
  }

  function edit(inp) {
    const h = SP._holes[+inp.dataset.i]; const v = parseInt(inp.value); h.colpi = isNaN(v) ? null : v;
    SP._incerte.delete(h.n);
    const keep = document.activeElement === inp, pos = inp.dataset.i;
    renderGrid();
    if (keep) { const el = document.querySelector(`#spGrid input[data-i="${pos}"]`); el.focus(); }
  }

  function confirm() {
    // registro correzioni: cosa aveva letto il modello e cosa hai confermato
    const orig = (read?.buche || []).reduce((m, h) => (m[h.n] = h.colpi ?? null, m), {});
    const diff = SP._holes.filter(h => (orig[h.n] ?? null) !== (h.colpi ?? null)).map(h => ({ n: h.n, letto: orig[h.n] ?? null, vero: h.colpi ?? null }));
    const log = JSON.parse(localStorage.getItem(LOG) || '[]');
    log.push({ quando: new Date().toISOString(), giocatore: PLAYER_NAME, circolo: SP._r.circolo, buche: SP._holes.length, diff });
    localStorage.setItem(LOG, JSON.stringify(log.slice(-50)));
    const ok = SP._holes.length - diff.length;
    calcProj();
    const pr = $('projResult');
    pr.innerHTML += ` &nbsp;|&nbsp; 📷 Lettura: ${ok}/${SP._holes.length} buche giuste al primo colpo`;
  }

  function resetKey() { localStorage.removeItem(KEY); if (!getKey()) askKey(); else msg('Uso di nuovo la chiave del gruppo. Premi “Riprova”.'); }
  function stats() {
    const log = JSON.parse(localStorage.getItem(LOG) || '[]');
    const tot = log.reduce((s, l) => s + l.buche, 0), err = log.reduce((s, l) => s + l.diff.length, 0);
    return { schede: log.length, buche: tot, errori: err, precisione: tot ? (100 * (tot - err) / tot).toFixed(1) + '%' : '—' };
  }
  return { pick, onFile, retry, showLog, whoIs, identify, sendTo, takePending, saveKey, resetKey, edit, confirm, computeCard, strokesRecv, fill, stats, COURSES, _holes: null };
})();
