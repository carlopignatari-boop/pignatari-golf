#!/usr/bin/env python3
"""
fetch_fig.py — Scarica dati gare da FIG areariservata.federgolf.it
e genera index.html aggiornato per GitHub Pages.
"""

import os
import sys
import json
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

FIG_URL = "https://areariservata.federgolf.it"
USERNAME = os.environ["FIG_USERNAME"]
PASSWORD = os.environ["FIG_PASSWORD"]


def login(page):
    print("Navigo su FIG...")
    page.goto(FIG_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(2000)

    # Se già loggato
    if "PIGNATARI" in page.content():
        print("Già loggato")
        return

    # Il sito fa redirect a un portale SSO esterno
    # Aspetto che la pagina si stabilizzi
    page.wait_for_load_state("networkidle", timeout=15000)
    current_url = page.url
    print(f"URL dopo redirect: {current_url}")

    # Cerca campi username/password
    content = page.content()
    if "PIGNATARI" in content:
        print("Loggato dopo redirect")
        return

    # Provo vari selettori per il form SSO
    for sel in ['input[name="Username"]', 'input[name="username"]',
                'input[id="Username"]', 'input[id="username"]',
                'input[type="text"]', 'input[type="email"]']:
        try:
            if page.locator(sel).count() > 0:
                page.fill(sel, USERNAME)
                print(f"Username inserito in {sel}")
                break
        except Exception:
            continue

    for sel in ['input[name="Password"]', 'input[name="password"]',
                'input[id="Password"]', 'input[id="password"]',
                'input[type="password"]']:
        try:
            if page.locator(sel).count() > 0:
                page.fill(sel, PASSWORD)
                print(f"Password inserita in {sel}")
                break
        except Exception:
            continue

    # Submit
    for sel in ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Entra")',
                'button:has-text("Login")', 'button:has-text("Accedi")']:
        try:
            if page.locator(sel).count() > 0:
                page.click(sel)
                print(f"Submit via {sel}")
                break
        except Exception:
            continue
    else:
        page.keyboard.press("Enter")

    page.wait_for_load_state("networkidle", timeout=15000)
    page.wait_for_timeout(2000)

    if "PIGNATARI" not in page.content():
        # Salvo screenshot per debug
        page.screenshot(path="scraper/debug_login.png")
        raise RuntimeError(f"Login FIG fallito. URL: {page.url}")

    print("Login OK")


def parse_rows(page):
    print("Navigo su ShowGrid...")
    page.goto(f"{FIG_URL}/Risultati/ShowGrid", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle", timeout=15000)
    page.wait_for_timeout(1500)

    rows = page.query_selector_all("table tbody tr")
    print(f"Trovate {len(rows)} righe totali")

    pending_rows = []  # Valida=S ma SD non ancora elaborato (mostrate ma fuori perimetro)
    gare = []          # Valida=S con SD disponibile (perimetro reale FIG, max 20)

    for row in rows:
        cells = [td.inner_text().strip() for td in row.query_selector_all("td")]
        if len(cells) < 23:
            continue
        if cells[10].strip() != "S":
            continue

        def to_float(s):
            try:
                return float(s.replace(",", "."))
            except Exception:
                return None

        link_el = row.query_selector("td:first-child a")
        link = FIG_URL + link_el.get_attribute("href") if link_el else ""
        sd_raw = cells[18].strip()

        cr  = to_float(cells[13]) if len(cells) > 13 else None
        sr  = to_float(cells[14]) if len(cells) > 14 else None
        ags = to_float(cells[16])
        # SD stimato = (AGS - CR) * (113 / SR), arrotondato a 1 decimale
        sd_est = None
        if not sd_raw and ags and cr and sr and sr > 0:
            sd_est = round((ags - cr) * (113 / sr), 1)

        entry = {
            "data":    cells[0].strip(),
            "gara":    cells[3].strip(),
            "circolo": cells[6].strip(),
            "stbl":    to_float(cells[15]),
            "ags":     ags,
            "pcc":     to_float(cells[17]) if cells[17].strip() else None,
            "sd":      to_float(sd_raw) if sd_raw else None,
            "sd_est":  sd_est,
            "cr":      cr,
            "sr":      sr,
            "idxN":    to_float(cells[22]) if len(cells) > 22 else None,
            "idxV":    to_float(cells[21]) if len(cells) > 21 else None,
            "var":     to_float(cells[23]) if len(cells) > 23 else None,
            "pending": not bool(sd_raw),
            "link":    link,
            "top8":    False,
        }

        if not sd_raw:
            pending_rows.append(entry)
        else:
            gare.append(entry)
            if len(gare) >= 20:
                break

    all_rows = pending_rows + gare
    for i, g in enumerate(all_rows):
        g["n"] = i + 1

    top8_ids = {g["n"] for g in sorted(gare, key=lambda x: x["sd"])[:8]}
    for g in all_rows:
        g["top8"] = g["n"] in top8_ids

    print(f"Pending (SD non elaborato): {len(pending_rows)}")
    print(f"Gare nel perimetro FIG: {len(gare)}")
    return all_rows


def calc_stats(gare):
    best8 = [g for g in gare if g["top8"]]
    if not best8:
        return {}
    avg_sd   = sum(g["sd"] for g in best8) / len(best8)
    avg_stbl = sum(g["stbl"] for g in best8 if g["stbl"] is not None) / len(best8)
    best_sd  = min(g["sd"] for g in best8)
    idx_fig  = gare[0]["idxN"] if gare else None
    return {
        "n_best8":        len(best8),
        "avg_sd":         round(avg_sd, 1),
        "avg_stbl":       round(avg_stbl, 1),
        "best_sd":        round(best_sd, 1),
        "idx_fig":        idx_fig,
        "theoretical_idx": round(avg_sd, 1),
    }


def build_html(gare, stats, updated_at, nome):
    # ── dati di base ─────────────────────────────────────────────────────
    cr_def = next((g["cr"] for g in gare if g.get("cr")), 72.2)
    sr_def = next((g["sr"] for g in gare if g.get("sr")), 127)

    real_with_sd = [g for g in gare if not g.get("pending") and g.get("sd") is not None]
    real_top8_ids = set(
        g["n"] for g in sorted(real_with_sd, key=lambda g: g["sd"])[:8]
    )
    has_pending_est = any(g.get("sd_est") is not None for g in gare if g.get("pending"))

    btn_sim_style = "" if has_pending_est else 'style="display:none"'

    avg_sd   = stats["avg_sd"]
    best_sd  = stats["best_sd"]
    avg_stbl = stats["avg_stbl"]
    n_best8  = stats["n_best8"]
    idx_fig  = stats["idx_fig"]

    # ── righe tabella ─────────────────────────────────────────────────────
    rows = []
    for g in gare:
        n         = g["n"]
        is_best   = n in real_top8_ids
        is_pend   = bool(g.get("pending"))
        tr_cls    = 'class="best"' if is_best else ""

        sd_val    = g.get("sd")
        sd_est    = g.get("sd_est")
        if is_pend:
            sd_cell = '<span class="badge-warn">?</span>'
        elif sd_val is not None:
            sd_cell = f"{sd_val:.1f}"
        else:
            sd_cell = "—"

        if is_best:
            stato = '<span class="badge-ok">★ TOP 8</span>'
        elif is_pend:
            stato = '<span class="badge-warn">⚠ pending</span>'
        else:
            stato = ""

        var_   = g.get("var") or 0
        vc     = "var-neg" if var_ < 0 else "var-pos" if var_ > 0 else "var-neu"
        vs     = "—" if var_ == 0 else (f"+{var_:.1f}" if var_ > 0 else f"{var_:.1f}")
        stbl   = g["stbl"] if g.get("stbl") is not None else "NR"
        ags    = round(g["ags"]) if g.get("ags") is not None else "—"
        pcc    = g.get("pcc") if g.get("pcc") is not None else "—"
        idxN   = f"{g['idxN']:.1f}" if g.get("idxN") is not None else "—"
        link   = g.get("link", "#") or "#"
        cr     = g.get("cr", cr_def)
        sr     = g.get("sr", sr_def)
        sd_est_val = sd_est if sd_est is not None else ""

        rows.append(
            f'<tr {tr_cls} '
            f'data-n="{n}" '
            f'data-sd="{sd_val if sd_val is not None else ""}" '
            f'data-sd-est="{sd_est_val}" '
            f'data-pending="{str(is_pend).lower()}" '
            f'data-cr="{cr}" data-sr="{sr}" '
            f'data-stbl="{stbl}" data-ags="{ags}" '
            f'data-gara="{g["gara"]}" data-circolo="{g.get("circolo","")}">'
            f"<td>{n}</td>"
            f'<td>{g.get("data","")}</td>'
            f"<td>{g['gara']}</td>"
            f'<td>{g.get("circolo","")}</td>'
            f'<td class="num">{stbl}</td>'
            f'<td class="num">{ags}</td>'
            f'<td class="num">{pcc}</td>'
            f'<td class="num sd-cell">{sd_cell}</td>'
            f'<td class="num">{idxN}</td>'
            f'<td class="num"><span class="{vc}">{vs}</span></td>'
            f'<td class="top8-cell">{stato}</td>'
            f'<td class="link-cell"><a href="{link}" target="_blank" rel="noopener noreferrer">↗ scheda</a></td>'
            f"</tr>"
        )

    rows_html = "\n".join(rows)

    # ── pending note (modalità reale) ─────────────────────────────────────
    pend_names = [g["gara"] for g in gare if g.get("pending")]
    if pend_names:
        pend_note_html = (
            '<div class="note-box" id="pendingStatic">'
            "⚠️ SD non ancora elaborato da FIG per: "
            f"<strong>{', '.join(pend_names)}</strong>. "
            "Non incluse nel perimetro delle 20 gare."
            "</div>"
        )
    else:
        pend_note_html = ""

    # ── JS: costanti ─────────────────────────────────────────────────────
    js_rows = "Array.from(document.querySelectorAll('#tbody tr')).map(tr => ({"
    js_rows += """
  n:       tr.dataset.n,
  gara:    tr.dataset.gara,
  circolo: tr.dataset.circolo,
  sd:      tr.dataset.sd    !== '' ? parseFloat(tr.dataset.sd)    : null,
  sd_est:  tr.dataset.sdEst !== '' ? parseFloat(tr.dataset.sdEst) : null,
  pending: tr.dataset.pending === 'true',
  cr:      parseFloat(tr.dataset.cr),
  sr:      parseFloat(tr.dataset.sr),
  stbl:    tr.dataset.stbl !== 'NR' ? parseFloat(tr.dataset.stbl) : null,
  ags:     tr.dataset.ags  !== '—'  ? parseFloat(tr.dataset.ags)  : null,
  _tr:     tr,
}))"""

    # ── HTML completo (nessuna f-string per il blocco JS) ─────────────────
    parts = []
    parts.append(f"""<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{nome} — Ultime 20 gare</title>
<style>
:root{{
  --bg:#0f1117;--card:#1a1d27;--elevated:#23273a;--text:#e2e8f0;--muted:#8892a4;
  --accent:#60a5fa;--ok:#34d399;--warn:#fbbf24;--border:#2d3348;--radius:10px;
  --sim:#a78bfa;--proj:#fb923c;
}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:var(--bg);color:var(--text);padding:16px;font-size:14px;min-height:100vh}}
h1{{font-size:20px;font-weight:700;margin-bottom:4px}}
.subtitle{{color:var(--muted);font-size:12px;margin-bottom:14px}}
/* toolbar */
.toolbar{{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}}
.btn{{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;
  border:1px solid var(--border);background:var(--elevated);color:var(--text);
  transition:all .2s;display:inline-flex;align-items:center;gap:6px}}
.btn:hover{{opacity:.85}}
.btn-back{{border-color:var(--muted);color:var(--muted)}}
.btn-sim.active{{background:color-mix(in srgb,var(--sim) 20%,transparent);
  border-color:var(--sim);color:var(--sim)}}
.btn-proj.active{{background:color-mix(in srgb,var(--proj) 20%,transparent);
  border-color:var(--proj);color:var(--proj)}}
/* proiezione panel */
.proj-panel{{display:none;margin-bottom:16px;
  background:color-mix(in srgb,var(--proj) 8%,transparent);
  border:1px solid color-mix(in srgb,var(--proj) 35%,transparent);
  border-radius:var(--radius);padding:14px 16px}}
.proj-panel.open{{display:block}}
.proj-panel h3{{font-size:13px;font-weight:700;color:var(--proj);margin-bottom:10px}}
.proj-fields{{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px}}
.proj-field label{{display:block;font-size:11px;color:var(--muted);margin-bottom:4px;
  text-transform:uppercase}}
.proj-field input{{background:var(--elevated);border:1px solid var(--border);
  color:var(--text);padding:6px 10px;border-radius:6px;font-size:14px;
  font-weight:600;width:90px}}
.proj-field input:focus{{outline:none;border-color:var(--proj)}}
.btn-calc{{padding:7px 14px;border-radius:6px;font-size:13px;font-weight:700;
  cursor:pointer;border:none;background:var(--proj);color:#0f1117}}
.proj-result{{font-size:12px;color:var(--proj);margin-top:8px;line-height:1.7;display:none}}
.proj-result.show{{display:block}}
/* banner */
.banner{{display:none;border-radius:var(--radius);padding:9px 14px;
  font-size:12px;line-height:1.6;margin-bottom:14px}}
.banner.sim{{display:block;
  background:color-mix(in srgb,var(--sim) 8%,transparent);
  border:1px solid color-mix(in srgb,var(--sim) 35%,transparent);color:var(--sim)}}
.banner.proj{{display:block;
  background:color-mix(in srgb,var(--proj) 8%,transparent);
  border:1px solid color-mix(in srgb,var(--proj) 35%,transparent);color:var(--proj)}}
/* summary */
.summary{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));
  gap:12px;margin-bottom:20px}}
.card{{background:var(--card);border-radius:var(--radius);padding:14px 16px;
  border:1px solid var(--border);transition:border-color .2s}}
.card.hi {{border-color:var(--sim)}}
.card.hi2{{border-color:var(--proj)}}
.card-label{{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}}
.card-value{{font-size:26px;font-weight:800;color:var(--accent);
  line-height:1.1;margin:4px 0 2px;transition:color .2s}}
.card-value.hi {{color:var(--sim)}}
.card-value.hi2{{color:var(--proj)}}
.card-sub{{font-size:11px;color:var(--muted)}}
/* tabella */
.table-wrap{{overflow-x:auto;border-radius:var(--radius);border:1px solid var(--border)}}
table{{width:100%;border-collapse:collapse;min-width:700px}}
thead{{background:var(--elevated)}}
th{{padding:8px 10px;text-align:left;font-size:10px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.06em;
  border-bottom:1px solid var(--border);white-space:nowrap}}
td{{padding:7px 10px;border-bottom:1px solid var(--border);
  white-space:nowrap;vertical-align:middle}}
tr:last-child td{{border-bottom:none}}
tr.best    td:first-child{{border-left:3px solid var(--ok)}}
tr.best                  {{background:color-mix(in srgb,var(--ok)  8%,transparent)}}
tr.sim-best td:first-child{{border-left:3px solid var(--sim)}}
tr.sim-best              {{background:color-mix(in srgb,var(--sim) 8%,transparent)}}
tr.proj-best td:first-child{{border-left:3px solid var(--proj)}}
tr.proj-best             {{background:color-mix(in srgb,var(--proj)8%,transparent)}}
tr.out      {{opacity:.35}}
tr:not(.best):not(.sim-best):not(.proj-best) td:first-child{{border-left:3px solid transparent}}
.num{{text-align:right;font-variant-numeric:tabular-nums}}
.badge-ok  {{display:inline-block;background:var(--ok);  color:#0f1117;border-radius:4px;padding:1px 7px;font-size:10px;font-weight:700}}
.badge-warn{{display:inline-block;background:var(--warn);color:#0f1117;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700}}
.badge-sim {{display:inline-block;background:var(--sim); color:#0f1117;border-radius:4px;padding:1px 7px;font-size:10px;font-weight:700}}
.badge-proj{{display:inline-block;background:var(--proj);color:#0f1117;border-radius:4px;padding:1px 7px;font-size:10px;font-weight:700}}
.var-pos{{color:#f87171;font-size:12px}}
.var-neg{{color:var(--ok);font-size:12px}}
.var-neu{{color:var(--muted);font-size:12px}}
.link-cell a{{color:var(--accent);text-decoration:none;font-size:12px;opacity:.8}}
.link-cell a:hover{{opacity:1;text-decoration:underline}}
.legend{{margin-top:14px;font-size:11px;color:var(--muted);
  display:flex;flex-wrap:wrap;gap:14px;align-items:center}}
.leg{{display:flex;align-items:center;gap:6px}}
.dot{{width:10px;height:10px;border-radius:2px;display:inline-block}}
.note-box{{margin-top:14px;
  background:color-mix(in srgb,var(--warn) 10%,transparent);
  border:1px solid color-mix(in srgb,var(--warn) 40%,transparent);
  border-radius:var(--radius);padding:10px 14px;
  font-size:12px;color:var(--warn);line-height:1.6}}
</style>
</head>
<body>
<h1>🏌️ {nome} — Ultime 20 gare valide</h1>
<div class="subtitle">Dati reali FIG (Valida = S) · Aggiornato il {updated_at}</div>

<div class="toolbar">
  <button class="btn btn-back" id="btnBack" onclick="goReal()" style="display:none">← Dati reali</button>
  <button class="btn btn-sim" id="btnSim" onclick="toggleSim()" {btn_sim_style}>🔮 Simula gara odierna</button>
  <button class="btn btn-proj" id="btnProj" onclick="toggleProj()">📐 Proiezione nuova gara</button>
</div>

<div class="proj-panel" id="projPanel">
  <h3>📐 Inserisci i dati di una gara non ancora in FIG</h3>
  <div class="proj-fields">
    <div class="proj-field"><label>Stableford</label>
      <input type="number" id="pStbl" min="0" max="72" placeholder="es. 34" inputmode="numeric"></div>
    <div class="proj-field"><label>AGS</label>
      <input type="number" id="pAgs" placeholder="es. 101" inputmode="numeric"></div>
    <div class="proj-field"><label>CR</label>
      <input type="number" id="pCr" value="{cr_def}" step="0.1" inputmode="decimal"></div>
    <div class="proj-field"><label>SR</label>
      <input type="number" id="pSr" value="{sr_def}" inputmode="numeric"></div>
    <button class="btn-calc" onclick="calcProj()">Calcola →</button>
  </div>
  <div class="proj-result" id="projResult"></div>
</div>

<div class="banner" id="banner"></div>

<div class="summary" id="summary">
  <div class="card" id="cN">
    <div class="card-label">Gare nel calcolo</div>
    <div class="card-value" id="vN">{n_best8}<span style="font-size:14px;color:var(--muted)">/20</span></div>
    <div class="card-sub">migliori 8 SD</div>
  </div>
  <div class="card" id="cAvg">
    <div class="card-label">Media SD — Top 8</div>
    <div class="card-value" id="vAvg">{avg_sd}</div>
    <div class="card-sub">Score Differenziale medio</div>
  </div>
  <div class="card" id="cBest">
    <div class="card-label">Miglior SD</div>
    <div class="card-value" id="vBest">{best_sd}</div>
    <div class="card-sub">performance migliore</div>
  </div>
  <div class="card" id="cStbl">
    <div class="card-label">Media Stbl — Top 8</div>
    <div class="card-value" id="vStbl">{avg_stbl}</div>
    <div class="card-sub">punti Stableford medi</div>
  </div>
  <div class="card">
    <div class="card-label">Index attuale FIG</div>
    <div class="card-value">{idx_fig}</div>
    <div class="card-sub">ultimo elaborato</div>
  </div>
</div>

<div class="table-wrap">
<table>
<thead>
  <tr>
    <th>#</th><th>Data</th><th>Gara</th><th>Circolo</th>
    <th class="num">Stbl</th><th class="num">AGS</th><th class="num">PCC</th>
    <th class="num">SD</th><th class="num">Index</th><th class="num">Var.</th>
    <th>Stato</th><th>Scheda</th>
  </tr>
</thead>
<tbody id="tbody">
{rows_html}
</tbody>
</table>
</div>

<div class="legend" id="legend">
  <div class="leg"><span class="dot" style="background:var(--ok)"></span><span>Top 8 reali</span></div>
  <div class="leg"><span class="badge-warn" style="font-size:10px">?</span><span>SD non elaborato da FIG</span></div>
</div>
{pend_note_html}
""")

    # ── blocco JS: costruito con concatenazione, niente f-string ─────────
    parts.append("<script>\n")
    parts.append("const ROWS = ")
    parts.append(js_rows)
    parts.append(";\n")
    parts.append(f"const CR_DEF = {cr_def};\n")
    parts.append(f"const SR_DEF = {sr_def};\n")
    parts.append(f"const IDX_FIG = {repr(str(idx_fig))};\n")
    parts.append(f"const AVG_SD_REAL = {avg_sd};\n")
    parts.append("""
let mode = 'real';  // 'real' | 'sim' | 'proj'
let projRow = null;

function top8from(arr) {
  return new Set([...arr].sort((a,b) => a._sd - b._sd).slice(0,8).map(r => r.n));
}

function buildDataset() {
  const withSD  = ROWS.filter(r => !r.pending && r.sd != null);
  const pending = ROWS.filter(r =>  r.pending && r.sd_est != null);
  let perim = [], outN = null;

  if (mode === 'sim' && pending.length) {
    const p = pending[0];
    if (withSD.length >= 20) outN = withSD[19].n;
    perim = [{...p, _sd: p.sd_est}, ...withSD.slice(0,19).map(r => ({...r, _sd: r.sd}))];
  } else if (mode === 'proj' && projRow) {
    if (withSD.length >= 20) outN = withSD[19].n;
    perim = [{...projRow, _sd: projRow.sd_est}, ...withSD.slice(0,19).map(r => ({...r, _sd: r.sd}))];
  } else {
    perim = withSD.slice(0,20).map(r => ({...r, _sd: r.sd}));
  }
  return { perim, top8: top8from(perim), outN };
}

function calcStats(perim, top8) {
  const best = perim.filter(r => top8.has(r.n));
  if (!best.length) return { n:0, avg:'—', bestSD:'—', avgStbl:'—' };
  const avgSD = best.reduce((s,r) => s + r._sd, 0) / best.length;
  const stbls = best.map(r => r.stbl).filter(v => v != null);
  return {
    n:       best.length,
    avg:     avgSD.toFixed(1),
    bestSD:  Math.min(...best.map(r => r._sd)).toFixed(1),
    avgStbl: stbls.length ? (stbls.reduce((s,v)=>s+v,0)/stbls.length).toFixed(1) : '—',
  };
}

function render() {
  const { perim, top8, outN } = buildDataset();
  const st = calcStats(perim, top8);
  const hi  = mode === 'sim'  ? 'hi'  : mode === 'proj' ? 'hi2' : '';

  // ── stat cards ──────────────────────────────────────────────────────
  ['cN','cAvg','cBest','cStbl'].forEach(id => {
    const c = document.getElementById(id);
    c.className = 'card' + (hi ? ' '+hi : '');
  });
  ['vN','vAvg','vBest','vStbl'].forEach(id => {
    const v = document.getElementById(id);
    v.className = 'card-value' + (hi ? ' '+hi : '');
  });
  document.getElementById('vN').innerHTML =
    st.n + '<span style="font-size:14px;color:var(--muted)">/20</span>';
  document.getElementById('vAvg').textContent  = st.avg;
  document.getElementById('vBest').textContent = st.bestSD;
  document.getElementById('vStbl').textContent = st.avgStbl;

  // ── righe tabella ───────────────────────────────────────────────────
  // rimuovi riga proiezione virtuale precedente
  document.querySelectorAll('.vrow').forEach(r => r.remove());

  ROWS.forEach(r => {
    const tr     = r._tr;
    const inTop8 = top8.has(r.n);
    const isOut  = r.n === outN;

    tr.className = '';
    if      (isOut)               tr.classList.add('out');
    else if (inTop8 && mode==='sim')  tr.classList.add('sim-best');
    else if (inTop8 && mode==='proj') tr.classList.add('proj-best');
    else if (inTop8)              tr.classList.add('best');

    // SD cell
    const sdCell = tr.querySelector('.sd-cell');
    if (r.pending && mode === 'sim' && r.sd_est != null)
      sdCell.innerHTML = '<span class="badge-sim">' + r.sd_est.toFixed(1) + ' ~</span>';
    else if (r.pending)
      sdCell.innerHTML = '<span class="badge-warn">?</span>';
    else
      sdCell.textContent = r.sd != null ? r.sd.toFixed(1) : '—';

    // Stato cell
    const t8 = tr.querySelector('.top8-cell');
    if      (inTop8 && mode==='sim')  t8.innerHTML = '<span class="badge-sim">★ SIM</span>';
    else if (inTop8 && mode==='proj') t8.innerHTML = '<span class="badge-proj">★ SIM</span>';
    else if (inTop8)                  t8.innerHTML = '<span class="badge-ok">★ TOP 8</span>';
    else if (isOut)                   t8.innerHTML = '<span style="color:var(--muted);font-size:11px">↩ esce</span>';
    else if (r.pending)               t8.innerHTML = '<span class="badge-warn">⚠ pending</span>';
    else                              t8.innerHTML = '';
  });

  // riga virtuale proiezione
  if (mode === 'proj' && projRow) {
    const inTop8 = top8.has('PROJ');
    const tbody = document.getElementById('tbody');
    const tr = document.createElement('tr');
    tr.className = (inTop8 ? 'proj-best' : '') + ' vrow';
    tr.innerHTML =
      '<td>★</td><td>—</td><td><strong>GARA PROIETTATA</strong></td><td>—</td>' +
      '<td class="num">' + projRow.stbl + '</td>' +
      '<td class="num">' + projRow.ags  + '</td>' +
      '<td class="num">—</td>' +
      '<td class="num"><span class="badge-proj">' + projRow.sd_est.toFixed(1) + ' ~</span></td>' +
      '<td class="num">—</td><td class="num">—</td>' +
      '<td><span class="badge-proj">PROIEZ.</span></td><td>—</td>';
    tbody.insertBefore(tr, tbody.firstChild);
  }

  // ── banner ──────────────────────────────────────────────────────────
  const banner = document.getElementById('banner');
  const withSD = ROWS.filter(r => !r.pending && r.sd != null);
  const outRow = withSD.find(r => r.n === outN);
  if (mode === 'sim') {
    const p = ROWS.find(r => r.pending && r.sd_est != null);
    banner.className = 'banner sim';
    banner.innerHTML = '🔮 <strong>Simulazione gara odierna</strong> — SD stimato per <strong>'
      + (p ? p.gara : '?') + '</strong>: <strong>'
      + (p ? p.sd_est.toFixed(1) : '?') + '</strong>.'
      + (outRow ? ' Esce: <strong>' + outRow.gara + '</strong> (SD ' + outRow.sd.toFixed(1) + ').' : '');
  } else if (mode === 'proj' && projRow) {
    banner.className = 'banner proj';
    banner.innerHTML = '📐 <strong>Proiezione</strong> — SD stimato: <strong>'
      + projRow.sd_est.toFixed(1) + '</strong>'
      + ' (Stbl ' + projRow.stbl + ', AGS ' + projRow.ags
      + ', CR ' + projRow.cr + ', SR ' + projRow.sr + ').'
      + (outRow ? ' Esce: <strong>' + outRow.gara + '</strong> (SD ' + outRow.sd.toFixed(1) + ').' : '');
  } else {
    banner.className = 'banner';
    banner.innerHTML = '';
  }

  // ── pending note ────────────────────────────────────────────────────
  const pn = document.getElementById('pendingStatic');
  if (pn) pn.style.display = (mode === 'real') ? '' : 'none';

  // ── legend ──────────────────────────────────────────────────────────
  const leg = document.getElementById('legend');
  let legHTML =
    '<div class="leg"><span class="dot" style="background:var(--ok)"></span><span>Top 8 reali</span></div>';
  if (mode === 'sim')
    legHTML += '<div class="leg"><span class="dot" style="background:var(--sim)"></span><span>Top 8 simulate</span></div>';
  if (mode === 'proj')
    legHTML += '<div class="leg"><span class="dot" style="background:var(--proj)"></span><span>Top 8 proiettate</span></div>';
  legHTML += '<div class="leg"><span class="badge-warn" style="font-size:10px">?</span><span>SD non elaborato da FIG</span></div>';
  if (mode !== 'real')
    legHTML += '<div class="leg"><span style="color:var(--muted);font-size:11px">↩ esce</span><span>Esce dal perimetro</span></div>';
  leg.innerHTML = legHTML;

  // ── pulsanti ────────────────────────────────────────────────────────
  document.getElementById('btnBack').style.display = mode !== 'real' ? '' : 'none';
  document.getElementById('btnSim').classList.toggle('active', mode === 'sim');
  document.getElementById('btnProj').classList.toggle('active', mode === 'proj');
  document.getElementById('projPanel').classList.toggle('open', mode === 'proj');
}

function goReal() {
  mode = 'real'; projRow = null;
  document.getElementById('projResult').className = 'proj-result';
  render();
}
function toggleSim()  { mode = mode === 'sim'  ? 'real' : 'sim';  render(); }
function toggleProj() {
  if (mode === 'proj') { goReal(); return; }
  mode = 'proj'; render();
  document.getElementById('pStbl').focus();
}

function calcProj() {
  const stbl   = parseFloat(document.getElementById('pStbl').value);
  const agsRaw = document.getElementById('pAgs').value.trim();
  const cr     = parseFloat(document.getElementById('pCr').value) || CR_DEF;
  const sr     = parseFloat(document.getElementById('pSr').value) || SR_DEF;
  if (isNaN(stbl)) {
    document.getElementById('projResult').className = 'proj-result show';
    document.getElementById('projResult').innerHTML = '⚠️ Inserisci almeno lo Stableford.';
    return;
  }
  const ags   = agsRaw !== '' ? parseFloat(agsRaw) : 72 + (36 - stbl);
  const sdEst = parseFloat(((ags - cr) * 113 / sr).toFixed(1));
  projRow = { n:'PROJ', gara:'GARA PROIETTATA', stbl, ags, cr, sr, sd_est: sdEst };

  const withSD = ROWS.filter(r => !r.pending && r.sd != null);
  const old8   = withSD.slice(0,20).map(r=>r.sd).sort((a,b)=>a-b).slice(0,8);
  const oldAvg = (old8.reduce((s,v)=>s+v,0)/8).toFixed(1);
  const newArr = [sdEst, ...withSD.slice(0,19).map(r=>r.sd)].sort((a,b)=>a-b);
  const newAvg = (newArr.slice(0,8).reduce((s,v)=>s+v,0)/8).toFixed(1);
  const inTop8 = newArr.slice(0,8).includes(sdEst);
  const exitG  = withSD[19];
  const dir    = parseFloat(newAvg) < parseFloat(oldAvg) ? '📉 migliora' : '📈 peggiora';

  document.getElementById('projResult').className = 'proj-result show';
  document.getElementById('projResult').innerHTML =
    'SD stimato: <strong>' + sdEst.toFixed(1) + '</strong> &nbsp;|&nbsp; ' +
    (inTop8 ? '✅ <strong>Entra nelle Top 8</strong>' : '❌ Non entra nelle Top 8') +
    ' &nbsp;|&nbsp; Media Top 8: <strong>' + oldAvg + ' → ' + newAvg + '</strong> (' + dir + ')' +
    (exitG ? ' &nbsp;|&nbsp; Esce: <strong>' + exitG.gara + '</strong> (SD ' + exitG.sd.toFixed(1) + ')' : '');

  render();
}

render();
</script>
</body>
</html>
""")

    return "".join(parts)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()
        try:
            login(page)
            gare = parse_rows(page)
            stats = calc_stats(gare)
            print(f"Stats: {stats}")
            updated_at = datetime.now().strftime("%d/%m/%Y %H:%M")
            html = build_html(gare, stats, updated_at, "Pignatari")
            out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "index.html")
            with open(out, "w", encoding="utf-8") as f:
                f.write(html)
            print(f"index.html scritto ({len(html)} bytes)")
            debug_out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "last_run.json")
            with open(debug_out, "w") as f:
                json.dump({"gare": gare, "stats": stats, "updated_at": updated_at}, f, indent=2)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
