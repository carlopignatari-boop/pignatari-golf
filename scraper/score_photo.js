// score_photo.js — "Carica score": lettura della scheda con Gemini, Perplexity o Anthropic + calcolo WHS buca per buca.
// Contesto dato al modello (RAG leggero): campo noto (par e handicap di buca), nome del giocatore,
// errori di lettura già corretti su questo telefono. I conti li fa l'app, non il modello.
const SP = (() => {
  const KEY = 'figsync.gemini', MODEL_KEY = 'figsync.geminiModel', LOG = 'figsync.scorelog';
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
Giocatore da leggere: ${PLAYER_NAME} (cognome; se la scheda ha più giocatori usa SOLO la sua riga o colonna).
Leggi per ognuna delle 18 buche (o 9) i colpi lordi scritti dal marcatore. Una buca senza numero, con "X", "-", "/" o cancellata significa non completata: colpi = null.
Leggi anche par e handicap di buca stampati sulla scheda. Se il campo è uno di questi, usa questi valori stampati:
${corsi}
Riporta anche, se scritti, il totale colpi e il totale punti Stableford del giocatore, il nome del circolo e la data.
Per ogni buca in cui la cifra è dubbia mettila in "incerte".
${hints()}
Rispondi solo con JSON: {"giocatore":str,"circolo":str|null,"data":"gg/mm/aaaa"|null,"buche":[{"n":int,"par":int|null,"si":int|null,"colpi":int|null}],"totale_colpi_scritto":int|null,"stbl_scritto":int|null,"incerte":[int],"note":str}`;
  }

  // Fornitore riconosciuto dal prefisso della chiave: pplx- → Perplexity, sk-ant- → Anthropic, altrimenti Gemini.
  const PROVIDERS = {
    gemini: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    perplexity: ['google/gemini-3.6-flash', 'anthropic/claude-sonnet-5-5', 'openai/gpt-5.6-terra'],
    anthropic: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
  };
  function provider(key) { return key.startsWith('pplx-') ? 'perplexity' : key.startsWith('sk-ant-') ? 'anthropic' : 'gemini'; }
  function parseJson(txt) {
    txt = (txt || '{}').replace(/^\s*```(json)?/i, '').replace(/```\s*$/, '').trim();
    const i = txt.indexOf('{'), j = txt.lastIndexOf('}');
    return JSON.parse(i >= 0 && j > i ? txt.slice(i, j + 1) : txt);
  }
  function request(prov, m, key, b64) {
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
  async function callModel(b64) {
    const key = localStorage.getItem(KEY), prov = provider(key), mk = MODEL_KEY + '.' + prov;
    const models = [...new Set([localStorage.getItem(mk), ...PROVIDERS[prov]].filter(Boolean))];
    let lastErr = '';
    for (const m of models) {
      const [url, headers, body, extract] = request(prov, m, key, b64);
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (r.ok) { localStorage.setItem(mk, m); return parseJson(extract(await r.json())); }
      lastErr = `${prov} ${m}: ` + r.status + ' ' + (await r.text()).slice(0, 160);
      if (r.status === 401 || r.status === 403) break;  // chiave non valida: inutile provare altri modelli
    }
    throw new Error(lastErr);
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
  function pick() { if (!localStorage.getItem(KEY)) return askKey(); $('spFile').click(); }

  async function onFile(ev) {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    msg('📷 Leggo la scheda…'); $('spGrid').innerHTML = '';
    try {
      const b64 = await toJpeg(f);
      const r = await callModel(b64);
      read = JSON.parse(JSON.stringify(r));
      fill(r);
    } catch (e) {
      msg('⚠️ Lettura non riuscita: ' + String(e.message || e).replace(/</g, '&lt;') + (String(e).match(/40[013]/) ? ' — controlla la chiave (<a href="#" onclick="SP.resetKey();return false">cambiala</a>).' : ''));
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

  function resetKey() { localStorage.removeItem(KEY); askKey(); }
  function stats() {
    const log = JSON.parse(localStorage.getItem(LOG) || '[]');
    const tot = log.reduce((s, l) => s + l.buche, 0), err = log.reduce((s, l) => s + l.diff.length, 0);
    return { schede: log.length, buche: tot, errori: err, precisione: tot ? (100 * (tot - err) / tot).toFixed(1) + '%' : '—' };
  }
  return { pick, onFile, saveKey, resetKey, edit, confirm, computeCard, strokesRecv, fill, stats, COURSES, _holes: null };
})();
