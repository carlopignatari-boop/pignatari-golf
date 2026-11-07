// Motore WHS — replica del calcolo Handicap Index FIG (Regole di Handicap WHS, rev. 2024)
'use strict';
const r1 = x => Math.round((x + 1e-9) * 10) / 10;       // arrotondamento al decimo (metà per eccesso)
// Tabella 5.2a: [n migliori, correzione] per numero di SD disponibili
function table(n) {
  if (n >= 20) return [8, 0];
  if (n === 19) return [7, 0];
  if (n >= 17) return [6, 0];
  if (n >= 15) return [5, 0];
  if (n >= 12) return [4, 0];
  if (n >= 9)  return [3, 0];
  if (n >= 7)  return [2, 0];
  if (n === 6) return [2, -1];
  if (n === 5) return [1, 0];
  if (n === 4) return [1, -1];
  if (n === 3) return [1, -2];
  return [0, 0];
}
const parseDate = s => { const [d, m, y] = s.split('/').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const DAY = 86400000;

/**
 * scores: array cronologico {date:'gg/mm/aaaa', sd:Number, hiAtPlay?:Number}
 * opts: { seedHistory: [{date, hi}] per Low HI iniziale, capOrder: 'esr-then-cap' | 'cap-then-esr', maxHI: 54 }
 * Ritorna per ogni score: { hi, raw, best:[indici], esr, corr:[per score], lowHI, cap }
 */
function compute(scores, opts = {}) {
  const maxHI = opts.maxHI ?? 54;
  const rec = [];                 // {date, sd, adj}
  const hiHist = [...(opts.seedHistory || [])].map(h => ({ t: parseDate(h.date).getTime(), hi: h.hi }));
  let hi = opts.startHI ?? null;
  const lowAnchor = opts.lowAnchor ?? 'prev', lowDays = opts.lowDays ?? 366, lowCarry = opts.lowCarry ?? false, capOnRounded = opts.capOnRounded ?? true;
  let prevT = null;
  const out = [];
  for (const s of scores) {
    const t = parseDate(s.date).getTime();
    const hiPlay = s.hiAtPlay ?? hi;
    rec.push({ date: s.date, sd: s.sd, adj: 0 });
    // ESR (5.9): confronto con l'index al momento del gioco
    let esr = 0;
    if (hiPlay != null) {
      const diff = r1(hiPlay - s.sd);
      if (diff >= 10) esr = -2; else if (diff >= 7) esr = -1;
    }
    if (esr) rec.slice(-20).forEach(x => x.adj += esr);
    const last = rec.slice(-20);
    const [k, adjT] = table(last.length);
    if (!k) { out.push({ hi: null }); continue; }
    const vals = last.map((x, i) => ({ v: r1(x.sd + x.adj), i })).sort((a, b) => a.v - b.v).slice(0, k);
    const avgU = vals.reduce((a, b) => a + b.v, 0) / k + adjT;
    let calc = r1(avgU);
    const raw = calc;
    const base = capOnRounded ? calc : avgU;
    // Low HI: minimo index nei 365 giorni precedenti la data dello score più recente (serve record di 20)
    let lowHI = null, cap = '';
    if (rec.length >= 20) {
      // index in vigore nella finestra: quelli calcolati nei 365 giorni + quello già in vigore all'inizio della finestra
      const anchor = lowAnchor === 'prev' && prevT != null ? prevT : t;
      const w0 = anchor - lowDays * DAY;
      const hs = hiHist.filter(h => h.t >= w0 && h.t < t).map(h => h.hi);
      const before = hiHist.filter(h => h.t < w0);
      if (lowCarry && before.length) hs.push(before[before.length - 1].hi);
      if (hs.length) lowHI = Math.min(...hs);
    }
    if (lowHI != null && r1(base - lowHI) > 3.0) {
      const soft = r1(lowHI + 3 + (base - lowHI - 3) / 2);
      calc = Math.min(soft, r1(lowHI + 5)); cap = calc === r1(lowHI + 5) ? 'hard' : 'soft';
    }
    hi = Math.min(calc, maxHI);
    hiHist.push({ t, hi }); prevT = t;
    out.push({ hi, raw, best: vals.map(v => rec.length - last.length + v.i), esr, lowHI, cap, corr: rec.map(x => x.adj) });
  }
  return { out, rec };
}
if (typeof module !== 'undefined') module.exports = { compute, table, r1 };
