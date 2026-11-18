#!/usr/bin/env python3
"""Gather the day's Slack discussions the user took part in, as JSON (for the [Slack] section).

Replaces the Slack connector the cloud routine used: reads channel history with the
Tempo Logger bot token. The bot must be a member of each channel (/invite @Tempo Logger).

Env: SLACK_BOT_TOKEN, SLACK_USER_ID (the user's member id), SLACK_CHANNELS
     ("C039TK0Q346:product-dev-qa,C0911MBFNSX:delta-techops" — name optional),
     TARGET_DATE (YYYY-MM-DD, default yesterday in America/Sao_Paulo).
Output: {"date", "channels": [{"id", "name", "error", "discussions": [{"ts", "messages": [{"user", "name", "time", "text"}]}]}]}
Best-effort: per-channel errors are reported in the JSON, never fatal.
"""
import datetime, json, os, sys, time, urllib.parse, urllib.request

SP = datetime.timezone(datetime.timedelta(hours=-3))
TOKEN = os.environ.get("SLACK_BOT_TOKEN", "")
ME = os.environ.get("SLACK_USER_ID", "")
MAX_MSG_CHARS = 600
MAX_THREAD_MSGS = 30
_names = {}


def api(method, **params):
    url = f"https://slack.com/api/{method}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}", "User-Agent": "tempo-logger/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode())
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "unknown_error"))
    return data


def paged(method, key, **params):
    cursor = None
    while True:
        p = dict(params, limit=200)
        if cursor:
            p["cursor"] = cursor
        data = api(method, **p)
        for m in data.get(key, []):
            yield m
        cursor = (data.get("response_metadata") or {}).get("next_cursor")
        if not cursor:
            break
        time.sleep(0.3)


def name_of(uid):
    if not uid:
        return "?"
    if uid not in _names:
        try:
            u = api("users.info", user=uid)["user"]
            _names[uid] = u.get("real_name") or u.get("name") or uid
        except Exception:
            _names[uid] = uid
    return _names[uid]


def fmt(m):
    ts = float(m.get("ts", "0"))
    hhmm = datetime.datetime.fromtimestamp(ts, SP).strftime("%H:%M")
    text = (m.get("text") or "").replace("\n", " ").strip()
    if len(text) > MAX_MSG_CHARS:
        text = text[:MAX_MSG_CHARS] + "…"
    return {"user": m.get("user", ""), "name": name_of(m.get("user", "")), "time": hhmm, "text": text}


def channel_discussions(cid, oldest, latest):
    out = []
    for m in paged("conversations.history", "messages", channel=cid, oldest=oldest, latest=latest, inclusive="true"):
        if m.get("subtype") in ("channel_join", "channel_leave", "bot_message"):
            continue
        if m.get("reply_count"):
            try:
                replies = list(paged("conversations.replies", "messages", channel=cid, ts=m["ts"]))
            except Exception:
                replies = [m]
            if any(r.get("user") == ME for r in replies):
                out.append({"ts": m["ts"], "messages": [fmt(r) for r in replies[:MAX_THREAD_MSGS]]})
        elif m.get("user") == ME and not m.get("thread_ts"):
            out.append({"ts": m["ts"], "messages": [fmt(m)]})
    out.sort(key=lambda d: float(d["ts"]))
    return out


def main():
    date = os.environ.get("TARGET_DATE") or (datetime.datetime.now(SP) - datetime.timedelta(days=1)).date().isoformat()
    day = datetime.date.fromisoformat(date)
    oldest = datetime.datetime.combine(day, datetime.time(0, 0), SP).timestamp()
    latest = datetime.datetime.combine(day, datetime.time(23, 59, 59), SP).timestamp()
    result = {"date": date, "channels": []}
    if not TOKEN or not ME:
        result["error"] = "SLACK_BOT_TOKEN or SLACK_USER_ID missing"
        print(json.dumps(result, ensure_ascii=False))
        return
    for spec in [s.strip() for s in os.environ.get("SLACK_CHANNELS", "").split(",") if s.strip()]:
        cid, _, name = spec.partition(":")
        entry = {"id": cid, "name": name or cid, "error": None, "discussions": []}
        try:
            entry["discussions"] = channel_discussions(cid, f"{oldest:.6f}", f"{latest:.6f}")
        except Exception as e:
            entry["error"] = str(e)
        result["channels"].append(entry)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}", "channels": []}))
        sys.exit(0)
