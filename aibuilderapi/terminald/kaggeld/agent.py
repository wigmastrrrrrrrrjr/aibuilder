#!/usr/bin/env python3
"""Kaggle remote executor for the aibuilder AI terminal.

Runs inside a Kaggle Notebook (or any always-on Python host with internet).
It polls the aibuilder D1 relay for shell commands, executes them in a sandbox
folder, and posts the output + changed files back, so `run_command` lands here
instead of on Cloudflare's terminal daemon. See terminald/kaggeld/setup.sh
for the one-time setup (secrets + cells) and kterm.sql for the relay table.

Environment:
    KTERM_TOKEN   shared secret, same value as the worker's TERMINAL_TOKEN
    RELAY_URL     public worker origin, e.g. https://aibuilderapi.csomeone301.workers.dev
    KTERM_POLL    poll interval seconds (default 3)
    KTERM_ROOT    sandbox root (default: sandbox/ under CWD)
    KTERM_MAXOUT  max captured stdout bytes per command (default 30000)

Every path a command mentions must stay inside the job's project folder; the
same static containment rules as the Cloudflare jail are enforced here so the
AI can't reach outside its own project. Denials are answered as `blocked` and
never executed.
"""

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

TOKEN = os.environ.get("KTERM_TOKEN", "")
RELAY = (os.environ.get("RELAY_URL", "") or "").rstrip("/")
POLL = max(1, int(os.environ.get("KTERM_POLL", "3")))
MAX_OUT = int(os.environ.get("KTERM_MAXOUT", "30000"))
MAX_FILES = 300
MAX_SIZE = 2 * 1024 * 1024
AGENT = f"kaggle-{os.uname().nodename if hasattr(os, 'uname') else 'agent'}-{os.getpid()}"
UA = "aib-kaggle-agent/1.0"

JAIL_DEV = {"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/zero",
            "/dev/urandom", "/dev/random", "/dev/full", "/dev/tty"}


def http_json(method, path, body=None, timeout=60):
    url = RELAY + path
    if requests is not None:
        try:
            if method == "GET":
                r = requests.get(url, headers={"User-Agent": UA}, timeout=timeout)
            else:
                r = requests.post(url, json=body, headers={"User-Agent": UA}, timeout=timeout)
        except Exception as exc:
            raise RuntimeError("relay unreachable: %s" % exc)
        if r.status_code >= 500:
            raise RuntimeError("relay %d on %s" % (r.status_code, method))
        try:
            return r.json()
        except Exception:
            raise RuntimeError("relay non-json on %s" % method)
    # stdlib fallback (no requests installed)
    data = None
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if method != "GET":
        data = json.dumps(body or {}).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
        if resp.status >= 500:
            raise RuntimeError("relay %d on %s" % (resp.status, method))
        return json.loads(raw)
    except urllib.error.HTTPError as exc:
        if exc.code >= 500:
            raise RuntimeError("relay %d on %s" % (exc.code, method))
        return json.loads(exc.read().decode("utf-8", "replace"))
    except urllib.error.URLError as exc:
        raise RuntimeError("relay unreachable: %s" % exc.reason)


# ---- path containment (mirrors jailError in terminal.js) ---------------------

def resolve_jail_path(raw, base):
    if raw == "~" or raw.startswith("~/"):
        p = base + raw[1:]
    elif raw.startswith("/"):
        p = raw
    else:
        p = base + "/" + raw
    stack = []
    for seg in p.split("/"):
        if not seg or seg == ".":
            continue
        if seg == "..":
            if stack:
                stack.pop()
            else:
                return None
        else:
            stack.append(seg)
    return "/" + "/".join(stack)


def jail_error(cmd, base):
    def deny(why):
        return ("blocked: %s. Nothing was executed. Every command must stay "
                "inside the project folder (your current directory) — use "
                "relative paths." % why)

    if re.search(r"\$\(|`|<\(|>\(", cmd):
        return deny("command/process substitution is not allowed")
    if re.search(r"(^|[;&|({]|\b(?:then|do|else)\b)\s*(eval|exec|source)\b", cmd):
        return deny("eval/exec/source is not allowed")
    if re.search(r"(^|[;&|({]|\b(?:then|do|else)\b)\s*\.\s+\S", cmd):
        return deny("sourcing a script is not allowed")
    if re.search(r"(^|[^\w.])(system|popen|child_process|subprocess|os\.system)\s*\(", cmd):
        return deny("spawning a subprocess from inline code is not allowed")
    if re.search(r"(^|[;&|({]|\b(?:then|do|else)\b)\s*(sudo|doas|su|chroot|unshare|nsenter|mount|umount|pivot_root|setpriv)\b", cmd):
        return deny("privilege/escalation commands are not allowed")
    if re.search(r"\b(mkfs|mke2fs|fdisk|parted|wipefs|shred)\b", cmd, re.I):
        return deny("disk-level commands are not allowed")
    if re.search(r"\bdd\b[^\n]*\bof=", cmd):
        return deny("dd writes are not allowed")
    inline = [
        re.compile(r"\b(node|bun|deno)\b[^\n]*\s(?:-e|--eval|-p|--print)(?:\s|=)"),
        re.compile(r"\bpython[0-9.]*\b[^\n]*\s-c(?:\s|$)"),
        re.compile(r"\b(perl|ruby)\b[^\n]*\s-[eE](?:\s|$)"),
        re.compile(r"\bphp\b[^\n]*\s-r(?:\s|$)"),
        re.compile(r"\b(sh|bash|zsh|dash|ksh)\b[^\n]*\s-c(?:\s|$)"),
    ]
    for re_ in inline:
        if re_.search(cmd):
            return deny("inline interpreter code cannot be verified (write a file and run it instead)")

    tokens = re.findall(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[^\s]+', cmd)
    for tok in tokens:
        quoted = False
        if (tok.startswith('"') and tok.endswith('"')) or (tok.startswith("'") and tok.endswith("'")):
            quoted = True
            tok = tok[1:-1]
        if not tok:
            continue
        m = re.match(r"^[A-Za-z_][A-Za-z0-9_]*=(.*)$", tok)
        if m:
            tok = m.group(1)
        if not tok:
            continue
        if tok.startswith("-") and tok != "-":
            eq = tok.find("=")
            if eq == -1:
                continue
            tok = tok[eq + 1:]
            if not tok:
                continue
        if tok in ("-", "."):
            continue
        if re.match(r"^[a-z][a-z0-9+.-]*://", tok, re.I):
            continue
        if tok in JAIL_DEV:
            continue
        if tok.startswith("~") and tok != "~" and not tok.startswith("~/"):
            return deny('"%s" points outside the project folder' % tok)
        pathish = (tok.startswith("/") or tok.startswith("~") or tok == ".."
                   or tok.startswith("../") or (not quoted and "/" in tok))
        if not pathish:
            continue
        resolved = re.sub(r"\$\{?HOME\}?", base, tok)
        resolved = re.sub(r"\$\{?PWD\}?", base, resolved)
        if re.search(r"[$`\\]", resolved):
            return deny('cannot verify that "%s" stays inside the project' % tok)
        norm = resolve_jail_path(resolved, base)
        if norm is None or (norm != base and not norm.startswith(base + "/")):
            return deny('"%s" is outside the project folder' % tok)
    return None


# ---- sandbox filesystem -----------------------------------------------------

def strip_escaping_links(root):
    """Delete symlinks inside the project that escape it (mirrors server)."""
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        for name in dirnames:
            p = os.path.join(dirpath, name)
            if os.path.islink(p):
                try:
                    real = os.path.realpath(p)
                    if not (real == root or real.startswith(root + os.sep)):
                        os.unlink(p)
                except OSError:
                    pass
        for name in filenames:
            p = os.path.join(dirpath, name)
            if os.path.islink(p):
                try:
                    real = os.path.realpath(p)
                    if not (real == root or real.startswith(root + os.sep)):
                        os.unlink(p)
                except OSError:
                    pass


def materialize(root, files):
    strip_escaping_links(root)
    for rel, content in (files or {}).items():
        if not rel or rel.startswith("/") or ".." in rel.split("/"):
            continue
        if not isinstance(content, str) or len(content) > MAX_SIZE or "\0" in content:
            continue
        abs_p = os.path.join(root, *rel.split("/"))
        if not abs_p.startswith(root + os.sep) and abs_p != root:
            continue
        os.makedirs(os.path.dirname(abs_p), exist_ok=True)
        with open(abs_p, "w", encoding="utf-8", newline="") as fh:
            fh.write(content)


def collect_files(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            p = os.path.join(dirpath, name)
            try:
                if os.path.islink(p):
                    continue
                if os.path.getsize(p) > MAX_SIZE:
                    continue
                rel = os.path.relpath(p, root).replace(os.sep, "/")
                with open(p, "rb") as fh:
                    data = fh.read()
                if b"\0" in data:
                    continue
                out[rel] = data.decode("utf-8")
            except OSError:
                continue
        if len(out) >= MAX_FILES:
            break
    return out


# ---- execution --------------------------------------------------------------

def run_job(job, root):
    pid = job.get("pid", "default")
    cmd = str(job.get("cmd", ""))[:2000]
    cwd = os.path.join(root, *[s for s in str(job.get("cwd") or "").split("/") if s]) if job.get("cwd") else root
    timeout = max(1, int(job.get("timeout_ms") or 30) / 1000.0)

    os.makedirs(cwd, exist_ok=True)
    materialize(root, job.get("files") or {})

    jail = jail_error(cmd, cwd)
    if jail:
        return {"id": job["id"], "output": jail, "code": 1, "blocked": True,
                "error": jail, "agent": AGENT, "result_files": collect_files(root)}

    if ".." in cwd.replace(os.sep, "/").split("/") or not cwd.startswith(root):
        return {"id": job["id"], "output": "", "code": 1, "blocked": True,
                "error": "blocked: cwd outside the project folder", "agent": AGENT}

    out = []
    proc = None
    try:
        proc = subprocess.Popen(
            ["/usr/bin/env", "bash", "-c", cmd],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=dict(os.environ, HOME=cwd),
            start_new_session=True,
        )
        timer = None
        try:
            timer = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                proc.kill()
            proc.wait(timeout=10)
            timer = 124  # timeout exit code convention
        tail = proc.stdout.read() if proc.stdout else b""
        out.append(tail)
        if len(out) and len(out[-1]) > MAX_OUT:
            out[-1] = out[-1][-MAX_OUT:]
    except Exception as exc:  # pragma: no cover
        if proc is not None:
            try:
                proc.kill()
            except Exception:
                pass
        return {"id": job["id"], "output": "", "code": 1, "blocked": False,
                "error": "agent failed to run: %s" % exc, "agent": AGENT,
                "result_files": collect_files(root)}

    text = b"".join(out).decode("utf-8", "replace")[-MAX_OUT:]
    return {"id": job["id"], "output": text, "code": timer if isinstance(timer, int) else 0,
            "blocked": False, "error": None, "agent": AGENT,
            "result_files": collect_files(root)}


# ---- main loop --------------------------------------------------------------

def main():
    if not TOKEN or not RELAY:
        print("KTERM_TOKEN and RELAY_URL are required", file=sys.stderr)
        sys.exit(2)
    root = os.path.abspath(os.environ.get("KTERM_ROOT", os.path.join(os.getcwd(), "sandbox")))
    os.makedirs(root, exist_ok=True)
    print("kaggle agent up: %s -> %s/api/kterm (root=%s, poll=%ss)" % (AGENT, RELAY, root, POLL), flush=True)

    while True:
        try:
            claims = http_json("GET", "/api/kterm/next?token=" + urllib.parse.quote(TOKEN) + "&agent=" + urllib.parse.quote(AGENT), timeout=POLL + 30)
        except Exception as exc:
            print("poll error: %s" % exc, file=sys.stderr, flush=True)
            time.sleep(POLL)
            continue

        job = claims.get("job")
        if not job:
            time.sleep(POLL)
            continue

        started = time.time()
        print("job %s pid=%s cmd=%r" % (job["id"], job.get("pid"), job.get("cmd", "")[:80]), flush=True)
        res = run_job(job, root)
        res["token"] = TOKEN
        try:
            http_json("POST", "/api/kterm/done", res, timeout=30)
        except RuntimeError as exc:
            # Result lost to the relay — drop it; the exec caller times out and
            # falls back to the Cloudflare daemon terminal.
            print("done post failed: %s" % exc, file=sys.stderr, flush=True)
        print("job %s done in %.1fs" % (job["id"], time.time() - started), flush=True)


if __name__ == "__main__":
    main()