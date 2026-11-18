#!/usr/bin/env python3
"""Print the day's key meetings as "HH:MM Title" lines (for the [Calendar] section).

Auth: service account (env GCAL_SA_KEY = full JSON key), which must have the
target calendar shared with it ("See all event details").
Env: TARGET_DATE (YYYY-MM-DD, default yesterday in America/Sao_Paulo),
     GCAL_CALENDAR_ID (default joao@defensepoint.com).
Best-effort by design: any failure prints a warning to stderr and exits 0 with
no output, so the timesheet still logs without a [Calendar] section.

Token: uses google-auth when installed; otherwise signs the service-account JWT
with the system `openssl` binary (no third-party packages needed).
"""
import base64, datetime, json, os, subprocess, sys, tempfile, time, urllib.parse, urllib.request

SP = datetime.timezone(datetime.timedelta(hours=-3))
CAL_ID = os.environ.get("GCAL_CALENDAR_ID", "joao@defensepoint.com")
SKIP_TITLES = ("break", "lunch", "out of office", "ooo")
TOP_N = 3
SCOPE = "https://www.googleapis.com/auth/calendar.readonly"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _token_with_openssl(info):
    """RS256-signed JWT bearer grant using openssl; stdlib only."""
    now = int(time.time())
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = _b64url(json.dumps({"iss": info["client_email"], "scope": SCOPE, "aud": info["token_uri"],
                                 "iat": now, "exp": now + 3600}).encode())
    signing_input = f"{header}.{claims}".encode()
    fd, key_path = tempfile.mkstemp(prefix="gcal-", suffix=".pem")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(info["private_key"])
        os.chmod(key_path, 0o600)
        sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key_path], input=signing_input,
                             capture_output=True, check=True).stdout
    finally:
        try:
            os.unlink(key_path)
        except OSError:
            pass
    assertion = f"{header}.{claims}.{_b64url(sig)}"
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion}).encode()
    req = urllib.request.Request(info["token_uri"], data=body, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())["access_token"]


def access_token():
    info = json.loads(os.environ["GCAL_SA_KEY"])
    try:
        from google.oauth2 import service_account  # type: ignore
        from google.auth.transport.requests import Request  # type: ignore
    except ImportError:
        return _token_with_openssl(info)
    creds = service_account.Credentials.from_service_account_info(info, scopes=[SCOPE])
    creds.refresh(Request())
    return creds.token


def main():
    date = os.environ.get("TARGET_DATE") or (
        datetime.datetime.now(SP) - datetime.timedelta(days=1)).date().isoformat()
    q = urllib.parse.urlencode({
        "timeMin": f"{date}T00:00:00-03:00", "timeMax": f"{date}T23:59:59-03:00",
        "singleEvents": "true", "orderBy": "startTime", "maxResults": "50",
    })
    url = f"https://www.googleapis.com/calendar/v3/calendars/{urllib.parse.quote(CAL_ID)}/events?{q}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token()}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        items = json.loads(r.read().decode()).get("items", [])

    kept = []
    for e in items:
        if e.get("eventType", "default").lower() != "default" or e.get("status") == "cancelled":
            continue
        summary = e.get("summary", "")
        if not summary or any(s in summary.lower() for s in SKIP_TITLES):
            continue
        start = (e.get("start") or {}).get("dateTime")
        if not start:  # all-day events are not meetings
            continue
        if "summary" not in e and "attendees" not in e:  # free/busy-only share: no details
            print("WARNING: calendar share appears to be free/busy only", file=sys.stderr)
            return
        mine = next((a for a in e.get("attendees", []) if a.get("email", "").lower() == CAL_ID.lower()), None)
        organizer = (e.get("organizer") or {}).get("email", "").lower() == CAL_ID.lower()
        if not organizer and (mine is None or mine.get("responseStatus") != "accepted"):
            continue
        if not e.get("attendees") and not organizer:  # solo/personal block
            continue
        hhmm = datetime.datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(SP).strftime("%H:%M")  # py3.9: no "Z" support
        kept.append(f"{hhmm} {summary}")

    for line in kept[:TOP_N]:
        print(line)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"WARNING: calendar gathering failed ({type(e).__name__}: {e}); logging without [Calendar]",
              file=sys.stderr)
