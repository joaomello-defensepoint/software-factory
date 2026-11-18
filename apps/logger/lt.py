#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Deterministic log-time helper for Kimai. Modes:
  preview  -> gather + build description, print JSON {date,already_logged,description}; NO writes
  run      -> gather, dedup-guard, and create the entry (autonomous). Prints one status line.
  create <descfile> -> POST with a (possibly user-edited) description from file.
Secrets via env: ADO_PAT or ADO_TOKEN (az-minted bearer), KIMAI_TOKEN, LLAMA_API_KEY (optional). TARGET_DATE optional (YYYY-MM-DD).
Gathering failures (ADO, Llama) are reported in the JSON "warnings" list instead of being swallowed.
"""
import os, sys, json, base64, datetime, urllib.parse, urllib.request, urllib.error

ADO_PAT = os.environ.get("ADO_PAT", ""); ADO_TOKEN = os.environ.get("ADO_TOKEN", ""); KIMAI = os.environ["KIMAI_TOKEN"]; LLAMA = os.environ.get("LLAMA_API_KEY", "")
WARNINGS = []
ORG = "https://dev.azure.com/IndySoft"
REPOS = [("Calibrations.com-Windows", "IndySoft.EnterpriseKiosk"),
         ("Calibrations.com-Windows", "IndySoft.EnterpriseWeb"),
         ("Enterprise Customer Portal", "IndySoft.NewCustomerPortal")]
KIMAI_BASE = "https://tempo.defensepoint.com/api"
LLAMA_URL = "https://api.ag-llama.com/api/organizations/indysoft/my-work"
ME_EMAIL = "joao@defensepoint.com"; ME_AUTHOR = "João Mello"
SP = datetime.timezone(datetime.timedelta(hours=-3))  # America/Sao_Paulo (fixed, no DST since 2019)
UA = "log-time-bot/1.0"  # hosts sit behind Cloudflare, which 403s the default urllib UA (err 1010)
TOP_N = 5

def _get(url, headers, _retry=True):
    h = dict(headers); h["User-Agent"] = UA
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
            return json.loads(r.read().decode())
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:  # transient network blips: retry once
        if _retry and not isinstance(e, urllib.error.HTTPError):
            import time; time.sleep(2)
            return _get(url, headers, _retry=False)
        raise

def _ado(url):
    auth = "Bearer " + ADO_TOKEN if ADO_TOKEN else "Basic " + base64.b64encode(b":" + ADO_PAT.encode()).decode()
    return _get(url, {"Authorization": auth})

def _warn(where, e):
    msg = f"{where}: {type(e).__name__}: {e}"
    if msg not in WARNINGS:
        WARNINGS.append(msg)

def target_date():
    return os.environ.get("TARGET_DATE") or (datetime.datetime.now(SP) - datetime.timedelta(days=1)).date().isoformat()

def _sp_day(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(SP).date().isoformat()

def _size(c):
    cc = c.get("changeCounts") or {}
    return (cc.get("Add") or 0) + (cc.get("Edit") or 0) + (cc.get("Delete") or 0)

def gather(DATE):
    # ---- Azure commits: dedupe by subject, keep max files-changed ----
    sizes = {}  # subject -> max change count
    for proj, repo in REPOS:
        base = f"{ORG}/{urllib.parse.quote(proj)}/_apis/git/repositories/{repo}"
        d0, d1 = f"{DATE}T00:00:00", f"{DATE}T23:59:59"
        try:  # A) merged (default branch) by author + date
            a = _ado(f"{base}/commits?searchCriteria.author={urllib.parse.quote(ME_AUTHOR)}"
                     f"&searchCriteria.fromDate={d0}&searchCriteria.toDate={d1}&$top=500&api-version=7.1")
            for c in a.get("value", []):
                s = c["comment"].splitlines()[0].strip()
                sizes[s] = max(sizes.get(s, 0), _size(c))
        except Exception as e:
            _warn(f"ADO commits {repo}", e)
        frm = (datetime.date.fromisoformat(DATE) - datetime.timedelta(days=3)).isoformat()
        branches = set()
        try:  # B1) branches he pushed to recently
            pu = _ado(f"{base}/pushes?searchCriteria.fromDate={frm}T00:00:00&searchCriteria.toDate={d1}"
                      f"&searchCriteria.includeRefUpdates=true&$top=200&api-version=7.1")
            for pv in pu.get("value", []):
                if (pv.get("pushedBy") or {}).get("uniqueName", "") == ME_EMAIL:
                    for ru in pv.get("refUpdates") or []:
                        if ru.get("name", "").startswith("refs/heads/"):
                            branches.add(ru["name"][len("refs/heads/"):])
        except Exception as e:
            _warn(f"ADO pushes {repo}", e)
        for br in branches:  # B2) that day's commits on each (skip 404 = merged+deleted)
            try:
                cs = _ado(f"{base}/commits?searchCriteria.itemVersion.version={urllib.parse.quote(br, safe='')}"
                          f"&searchCriteria.itemVersion.versionType=branch"
                          f"&searchCriteria.fromDate={d0}&searchCriteria.toDate={d1}&$top=500&api-version=7.1")
            except Exception:
                continue
            for c in cs.get("value", []):
                au = c.get("author", {}) or {}
                if au.get("email", "").lower() == ME_EMAIL or au.get("name", "").startswith("João"):
                    s = c["comment"].splitlines()[0].strip()
                    sizes[s] = max(sizes.get(s, 0), _size(c))
    commit_top = [s for s, _ in sorted(sizes.items(), key=lambda kv: -kv[1])[:TOP_N]]

    # ---- Llama: my-work is org-wide (covers EAM + CUSTEQWORK), reported items updated that day ----
    llama_lines = []
    if LLAMA:
        try:
            rep = (_get(LLAMA_URL, {"X-API-Key": LLAMA}).get("data") or {}).get("reported", [])
            order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "TRIVIAL": 4}
            hits = sorted((it for it in rep if _sp_day(it["updatedAt"]) == DATE),
                          key=lambda it: order.get(it.get("priority"), 9))
            llama_lines = [f'{it["key"]} -> {it["summary"]}' for it in hits[:TOP_N]]
        except Exception as e:
            _warn("Llama my-work", e)

    already = kimai_existing(DATE)  # NOT best-effort — raises on failure (see run())
    return {"date": DATE, "already_logged": already, "commit_top": commit_top,
            "llama_lines": llama_lines, "meetings": _meetings(), "warnings": list(WARNINGS)}

def _meetings():
    # Google Calendar has no REST token; the skill gathers/filters meetings via the
    # MCP connector and passes them in via LT_MEETINGS (one formatted line each).
    # lt.py only formats them. Absent env -> no section (autonomous runs have none).
    return [l for l in os.environ.get("LT_MEETINGS", "").splitlines() if l.strip()]

def build_description(commit_top, llama_lines, meetings=()):
    parts = []
    if commit_top:
        parts.append("[Azure] Top commits (by size):\n" + "\n".join(commit_top))
    if llama_lines:
        parts.append("[Llama] Top worked items (by priority):\n" + "\n".join(llama_lines))
    if meetings:
        parts.append("[Calendar] Key meetings:\n" + "\n".join(meetings))
    return "\n\n".join(parts)

def kimai_existing(DATE):
    ts = _get(f"{KIMAI_BASE}/timesheets?project=12&begin={DATE}T00:00:00&end={DATE}T23:59:59",
              {"Authorization": "Bearer " + KIMAI})
    return ts[0].get("id") if ts else None

def create(DATE, desc):
    body = json.dumps({"begin": f"{DATE}T05:00:00-03:00", "end": f"{DATE}T13:00:00-03:00",
                       "project": 12, "activity": 7, "description": desc}).encode()
    req = urllib.request.Request(f"{KIMAI_BASE}/timesheets", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + KIMAI,
                                          "Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode()).get("id")

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "preview"
    DATE = target_date()
    try:
        if mode == "preview":
            g = gather(DATE)
            g["description"] = build_description(g["commit_top"], g["llama_lines"], g["meetings"])
            print(json.dumps(g, ensure_ascii=False, indent=2))
        elif mode == "run":
            g = gather(DATE)
            if g["already_logged"]:
                print(f"SKIPPED-DUPLICATE: {DATE} already logged (id {g['already_logged']})")
            elif not g["commit_top"] and not g["llama_lines"] and not g["meetings"]:
                print(f"SKIPPED-EMPTY: no activity for {DATE}")
            else:
                print(f"CREATED: {DATE} entry id {create(DATE, build_description(g['commit_top'], g['llama_lines'], g['meetings']))}")
        elif mode == "create":
            print(f"CREATED: {DATE} entry id {create(DATE, open(sys.argv[2], encoding='utf-8').read())}")
        else:
            sys.exit("unknown mode")
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}")
        sys.exit(1)
