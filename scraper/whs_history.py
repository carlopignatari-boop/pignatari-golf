"""whs_history.py — legge dalla griglia FIG la storia completa delle gare valide (WHS, dal 15/12/2020)."""
from datetime import datetime

WHS_START = datetime(2020, 12, 15)


def _grab(page):
    return page.evaluate(
        "() => [...document.querySelectorAll('table tbody tr')]"
        ".map(r => [...r.children].filter(c => c.tagName === 'TD').map(td => td.innerText.trim()))"
        ".filter(c => c.length >= 23 && c[0].includes('/'))"
    )


def fetch_history(page):
    """Da chiamare con la pagina già su /Risultati/ShowGrid. Ritorna lista cronologica
    [{d, sd, iv, in}] delle gare con SD (Valida S = 18 buche, V = 9 buche)."""
    try:
        n0 = len(_grab(page))
        sel = [s for s in page.query_selector_all("select") if "1000" in s.inner_text()]
        if sel:
            sel[0].select_option("1000")
            for _ in range(30):
                page.wait_for_timeout(1500)
                try:
                    page.wait_for_load_state("networkidle", timeout=30000)
                    if len(_grab(page)) != n0:
                        break
                except Exception:
                    continue  # pagina in ricarica: riprovo
        rows = []
        for _ in range(10):
            try:
                rows = _grab(page)
                break
            except Exception:
                page.wait_for_timeout(1500)
    except Exception as e:
        print(f"Storia FIG non disponibile: {e}")
        return []

    def f(s):
        try:
            return float(s.replace(",", "."))
        except Exception:
            return None

    hist = []
    for c in rows:
        if c[10] not in ("S", "V") or not c[18]:
            continue
        try:
            if datetime.strptime(c[0], "%d/%m/%Y") < WHS_START:
                continue
        except ValueError:
            continue
        hist.append({"d": c[0], "sd": f(c[18]), "iv": f(c[21]), "in": f(c[22])})
    hist.reverse()  # cronologico
    print(f"Storia WHS: {len(hist)} gare con SD")
    return hist
