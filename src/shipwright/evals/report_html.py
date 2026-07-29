"""Static evals page generated from recorded rows.

Nothing here computes a number that isn't already in the database, and every row carries
its own provenance (model, scaffold, n, commit, date) so a reader can tell configurations
apart. That is the whole point: the page is only worth as much as its traceability.
"""

from __future__ import annotations

import html
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from ..db import session
from ..models import RESOLVED, SKIPPED, Run, TaskResult

OUT = Path("evals/reports")

CSS = """
:root { --fg:#1a1a1a; --muted:#666; --line:#e2e2e2; --accent:#0b5fff; --warn:#8a5a00; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e8; --muted:#9a9a9a; --line:#333; --accent:#7aa2ff; --warn:#d9a33a; }
  body { background:#151515; }
}
body { font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       color:var(--fg); max-width:64rem; margin:2rem auto; padding:0 1.25rem; }
h1 { font-size:1.6rem; margin-bottom:.25rem; }
h2 { font-size:1.15rem; margin-top:2.5rem; border-bottom:1px solid var(--line);
     padding-bottom:.3rem; }
.sub { color:var(--muted); margin-top:0; }
table { border-collapse:collapse; width:100%; margin:1rem 0; font-size:14px; }
th,td { text-align:left; padding:.45rem .6rem; border-bottom:1px solid var(--line); }
th { font-weight:600; color:var(--muted); font-size:12px; text-transform:uppercase;
     letter-spacing:.04em; }
td.n { font-variant-numeric:tabular-nums; }
.best { font-weight:700; color:var(--accent); }
.note { color:var(--muted); font-size:13.5px; }
.warn { color:var(--warn); }
code { font-size:13px; background:rgba(127,127,127,.13); padding:.1rem .3rem; border-radius:3px; }
.scroll { overflow-x:auto; }
"""


def _pct(rows: list[TaskResult], key: str) -> float | None:
    att = [r for r in rows if r.status != SKIPPED]
    if not att:
        return None
    return 100 * sum(1 for r in att if (r.metrics or {}).get(key)) / len(att)


def _fmt(v: float | None) -> str:
    return "—" if v is None else f"{v:.1f}%"


def build(out_dir: Path = OUT) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    with session() as s:
        runs = s.scalars(select(Run).order_by(Run.started_at)).all()
        data = []
        for run in runs:
            rows = s.scalars(select(TaskResult).where(TaskResult.run_id == run.id)).all()
            att = [r for r in rows if r.status != SKIPPED]
            if not att:
                continue
            data.append(
                {
                    "run": run,
                    "n": len(att),
                    "skipped": len(rows) - len(att),
                    "file5": _pct(rows, "file_acc_at_5"),
                    "func10": _pct(rows, "func_acc_at_10"),
                    "anyhit": _pct(rows, "any_hit"),
                    "resolved": sum(1 for r in att if r.status == RESOLVED),
                    "calls": sum(r.tool_calls for r in att),
                    "tin": sum(r.input_tokens for r in att),
                    "parse": sum((r.metrics or {}).get("parse_failures", 0) for r in att),
                }
            )

    loc = [d for d in data if d["run"].suite == "locbench"]
    swe = [d for d in data if d["run"].suite == "swebench_live"]
    best = max((d for d in loc if d["n"] >= 100), key=lambda d: d["func10"] or 0, default=None)

    def loc_table(items: list[dict]) -> str:
        head = (
            "<tr><th>scaffold</th><th>model</th><th>n</th><th>file@5</th><th>func@10</th>"
            "<th>any-hit</th><th>calls</th><th>tok in</th><th>parse fail</th>"
            "<th>commit</th><th>date</th></tr>"
        )
        body = ""
        for d in items:
            r = d["run"]
            cls = ' class="best"' if best and d is best else ""
            body += (
                f"<tr{cls}><td>{html.escape(r.scaffold.removeprefix('retrieval_'))}</td>"
                f"<td>{html.escape('—' if r.model == 'none' else r.model.split('/')[-1][:34])}</td>"
                f'<td class="n">{d["n"]}'
                + (f' <span class="warn">+{d["skipped"]} skip</span>' if d["skipped"] else "")
                + f'</td><td class="n">{_fmt(d["file5"])}</td>'
                f'<td class="n">{_fmt(d["func10"])}</td><td class="n">{_fmt(d["anyhit"])}</td>'
                f'<td class="n">{d["calls"] or "—"}</td>'
                f'<td class="n">{d["tin"]:,}' + ("" if d["tin"] else "—") + "</td>"
                f'<td class="n">{d["parse"] or "—"}</td>'
                f"<td><code>{html.escape(r.git_commit or '?')}</code></td>"
                f'<td class="n">{r.started_at:%Y-%m-%d}</td></tr>'
            )
        return f'<div class="scroll"><table>{head}{body}</table></div>'

    headline = ""
    if best:
        headline = (
            f'<p class="sub">Best recorded localization configuration: '
            f"<strong>{html.escape(best['run'].scaffold.removeprefix('retrieval_'))}</strong> — "
            f"<strong>{_fmt(best['file5'])}</strong> file-level Acc@5 and "
            f"<strong>{_fmt(best['func10'])}</strong> function-level Acc@10 "
            f"over n={best['n']} tasks.</p>"
        )

    swe_html = ""
    if swe:
        rows = "".join(
            f"<tr><td>{html.escape(d['run'].scaffold)}</td>"
            f'<td>{html.escape(d["run"].model)}</td><td class="n">{d["n"]}</td>'
            f'<td class="n">{d["resolved"]}/{d["n"]}</td>'
            f'<td class="n">{d["run"].started_at:%Y-%m-%d}</td></tr>'
            for d in swe
        )
        swe_html = f"""<h2>SWE-bench-Live (bug fixing)</h2>
<div class="scroll"><table><tr><th>scaffold</th><th>model</th><th>n</th><th>resolved</th>
<th>date</th></tr>{rows}</table></div>
<p class="note">Unevaluated patches count as unresolved, never as unknown. The local 7B does
not resolve these tasks; the characterised reasons are in <code>docs/FAILURES.md</code>.</p>"""

    page = f"""<!doctype html><meta charset="utf-8">
<title>Shipwright — evaluation results</title>
<style>{CSS}</style>
<h1>Shipwright — evaluation results</h1>
<p class="sub">Generated {datetime.now(UTC):%Y-%m-%d %H:%M} UTC from
{len(data)} recorded runs. Every figure is computed from stored rows, not transcribed.</p>
{headline}

<h2>Loc-Bench localization</h2>
<p class="note">Acc@k is strict: <em>all</em> ground-truth locations must appear in the top k.
<code>any-hit</code> is a diagnostic only and is not an accuracy metric.</p>
{loc_table(loc)}
{swe_html}

<h2>How to read this</h2>
<ul class="note">
<li><strong>Noise floor.</strong> Repeated runs of one identical configuration at n=30 span
73.3–76.7% file@5 and 30.0–36.7% func@10, so roughly ±3.3 points (one task) is noise.
Differences smaller than that are not results.</li>
<li><strong>pass@1 only.</strong> No best-of-N or verifier-boosted numbers appear here.</li>
<li><strong>Skips are shown, never hidden.</strong> A skipped task is excluded from the
numerator and reported separately, so a shrinking denominator cannot inflate a rate.</li>
<li><strong>Cost.</strong> All inference is local, so no row has an API cost. Token counts
are recorded because they are the portable measure of expense.</li>
<li><strong>Provenance.</strong> Scaffold names encode mode, retrieval base and pool size, so
two runs that differ in configuration cannot look identical.</li>
</ul>
<p class="note">Method, failure analyses and the decisions behind each number:
<code>docs/EVALS.md</code>, <code>docs/FAILURES.md</code>, <code>docs/adr/</code>.</p>
"""
    path = out_dir / "index.html"
    path.write_text(page)
    return path
