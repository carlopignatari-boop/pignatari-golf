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

        entry = {
            "data":    cells[0].strip(),
            "gara":    cells[3].strip(),
            "circolo": cells[6].strip(),
            "stbl":    to_float(cells[15]),
            "ags":     to_float(cells[16]),
            "pcc":     to_float(cells[17]) if cells[17].strip() else None,
            "sd":      to_float(sd_raw) if sd_raw else None,
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
        "avg_sd":         round(avg_sd, 2),
        "avg_stbl":       round(avg_stbl, 1),
        "best_sd":        round(best_sd, 1),
        "idx_fig":        idx_fig,
        "theoretical_idx": round(avg_sd * 0.96, 1),
    }


def render_html(gare, stats, updated_at):
    rows_html = ""
    for g in gare:
        tr_class = ' class="best"' if g["top8"] else ""
        var = g["var"] or 0.0
        vc  = "var-neg" if var < 0 else ("var-pos" if var > 0 else "var-neu")
        vs  = "—" if var == 0 else (f"+{var:.1f}" if var > 0 else f"{var:.1f}")
        sd_cell   = '<span class="badge-warn">?</span>' if g["pending"] else (f'{g["sd"]:.1f}' if g["sd"] is not None else "—")
        top8_cell = '<span class="badge">★ TOP 8</span>' if g["top8"] else ""
        pcc_cell  = str(int(g["pcc"])) if g["pcc"] is not None else "—"
        stbl_cell = str(int(g["stbl"])) if g["stbl"] is not None else "—"
        ags_cell  = str(int(g["ags"])) if g["ags"] is not None else "—"
        idx_cell  = f'{g["idxN"]:.1f}' if g["idxN"] is not None else "—"
        rows_html += f"""
        <tr{tr_class}>
          <td>{g['n']}</td><td>{g['data']}</td><td>{g['gara']}</td><td>{g['circolo']}</td>
          <td class="num">{stbl_cell}</td><td class="num">{ags_cell}</td><td class="num">{pcc_cell}</td>
          <td class="num">{sd_cell}</td><td class="num">{idx_cell}</td>
          <td class="num"><span class="{vc}">{vs}</span></td>
          <td>{top8_cell}</td>
          <td class="link-cell"><a href="{g['link']}" target="_blank" rel="noopener noreferrer">↗ scheda</a></td>
        </tr>"""

    pending = [g for g in gare if g["pending"]]
    pending_note = ""
    if pending:
        names = ", ".join(g["gara"] for g in pending)
        pending_note = (
            f'<div class="note-box">⚠️ SD non ancora elaborato da FIG per: <strong>{names}</strong>. '
            f'Non incluse nel calcolo Top 8. '
            f'Index teorico attuale: {stats["avg_sd"]:.2f} × 0.96 = <strong>{stats["theoretical_idx"]}</strong> '
            f'(vs {stats["idx_fig"]} FIG).</div>'
        )

    return f"""<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pignatari — Ultime 20 gare</title>
<style>
  :root{{--bg:#0f1117;--card:#1a1d27;--elevated:#23273a;--text:#e2e8f0;--muted:#8892a4;
    --accent:#60a5fa;--ok:#34d399;--warn:#fbbf24;--border:#2d3348;--radius:10px}}
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);padding:16px;font-size:14px;min-height:100vh}}
  h1{{font-size:20px;font-weight:700;margin-bottom:4px}}
  .subtitle{{color:var(--muted);font-size:12px;margin-bottom:18px}}
  .summary{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}}
  .stat-card{{background:var(--card);border-radius:var(--radius);padding:14px 16px;border:1px solid var(--border)}}
  .stat-label{{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}}
  .stat-value{{font-size:26px;font-weight:800;color:var(--accent);line-height:1.1;margin:4px 0 2px}}
  .stat-sub{{font-size:11px;color:var(--muted)}}
  .table-wrap{{overflow-x:auto;border-radius:var(--radius);border:1px solid var(--border)}}
  table{{width:100%;border-collapse:collapse;min-width:700px}}
  thead{{background:var(--elevated)}}
  th{{padding:8px 10px;text-align:left;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border);white-space:nowrap}}
  td{{padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap;vertical-align:middle}}
  tr:last-child td{{border-bottom:none}}
  tr.best{{background:color-mix(in srgb,var(--ok) 8%,transparent)}}
  tr.best td:first-child{{border-left:3px solid var(--ok)}}
  tr:not(.best) td:first-child{{border-left:3px solid transparent}}
  .num{{text-align:right;font-variant-numeric:tabular-nums}}
  .badge{{display:inline-block;background:var(--ok);color:#0f1117;border-radius:4px;padding:1px 7px;font-size:10px;font-weight:700}}
  .badge-warn{{display:inline-block;background:var(--warn);color:#0f1117;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700}}
  .var-pos{{color:#f87171;font-size:12px}}.var-neg{{color:var(--ok);font-size:12px}}.var-neu{{color:var(--muted);font-size:12px}}
  .link-cell a{{color:var(--accent);text-decoration:none;font-size:12px;opacity:.8}}
  .link-cell a:hover{{opacity:1;text-decoration:underline}}
  .legend{{margin-top:14px;font-size:11px;color:var(--muted);display:flex;flex-wrap:wrap;gap:14px;align-items:center}}
  .leg-item{{display:flex;align-items:center;gap:6px}}
  .dot-ok{{width:10px;height:10px;background:var(--ok);border-radius:2px;display:inline-block}}
  .note-box{{margin-top:14px;background:color-mix(in srgb,var(--warn) 10%,transparent);border:1px solid color-mix(in srgb,var(--warn) 40%,transparent);border-radius:var(--radius);padding:10px 14px;font-size:12px;color:var(--warn);line-height:1.6}}
</style>
</head>
<body>
<h1>🏌️ Pignatari — Ultime 20 gare valide (Valida = S)</h1>
<div class="subtitle">Dati reali da FIG · Aggiornato automaticamente il {updated_at}</div>
<div class="summary">
  <div class="stat-card"><div class="stat-label">Gare nel calcolo</div><div class="stat-value">{stats['n_best8']}<span style="font-size:14px;color:var(--muted)">/20</span></div><div class="stat-sub">migliori 8 SD (Valida=S)</div></div>
  <div class="stat-card"><div class="stat-label">Media SD — Top 8</div><div class="stat-value">{stats['avg_sd']:.2f}</div><div class="stat-sub">Score Differenziale medio</div></div>
  <div class="stat-card"><div class="stat-label">Miglior SD</div><div class="stat-value">{stats['best_sd']:.1f}</div><div class="stat-sub">performance migliore</div></div>
  <div class="stat-card"><div class="stat-label">Media Stbl — Top 8</div><div class="stat-value">{stats['avg_stbl']:.1f}</div><div class="stat-sub">punti Stableford medi</div></div>
  <div class="stat-card"><div class="stat-label">Index attuale FIG</div><div class="stat-value">{stats['idx_fig']}</div><div class="stat-sub">ultima gara elaborata</div></div>
</div>
<div class="table-wrap">
  <table>
    <thead>
      <tr><th>#</th><th>Data</th><th>Gara</th><th>Circolo</th>
        <th class="num">Stbl</th><th class="num">AGS</th><th class="num">PCC</th>
        <th class="num">SD</th><th class="num">Index</th><th class="num">Var.</th>
        <th>Top 8</th><th>Scheda</th></tr>
    </thead>
    <tbody>{rows_html}</tbody>
  </table>
</div>
<div class="legend">
  <div class="leg-item"><span class="dot-ok"></span><span>8 SD più bassi — usate per il calcolo handicap</span></div>
  <div class="leg-item"><span class="badge-warn">?</span><span>SD non ancora elaborato da FIG</span></div>
</div>
{pending_note}
</body>
</html>"""


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
            html = render_html(gare, stats, updated_at)
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
