"""Lokale webserver voor het Bos Machine dashboard.

Serveert het dashboard en bewaart geüploade CSV/mail-data op schijf in de
map "data", zodat een collega bij een herstart niet opnieuw hoeft te
uploaden.
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, render_template, request

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
STATE_FILE = DATA_DIR / "state.json"
CSV_DIR = DATA_DIR / "csv"
MAIL_DIR = DATA_DIR / "mail"


def _store_uploaded_files(target_dir: Path) -> list[str]:
    target_dir.mkdir(parents=True, exist_ok=True)
    stored = []
    for f in request.files.getlist("files"):
        # Path(...).name strips any directory component to prevent path traversal.
        name = Path(f.filename or "").name
        if not name:
            continue
        f.save(target_dir / name)
        stored.append(name)
    return stored


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024

    @app.get("/")
    def index():
        return render_template("dashboard.html")

    @app.get("/api/state")
    def get_state():
        if STATE_FILE.exists():
            try:
                return jsonify(json.loads(STATE_FILE.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                pass
        return jsonify({"batches": [], "filter": {}})

    @app.post("/api/state")
    def save_state():
        payload = request.get_json(silent=True) or {}
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(
            json.dumps(
                {"batches": payload.get("batches", []), "filter": payload.get("filter", {})},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return jsonify({"ok": True})

    @app.post("/api/upload/csv")
    def upload_csv():
        return jsonify({"ok": True, "stored": _store_uploaded_files(CSV_DIR)})

    @app.post("/api/upload/mail")
    def upload_mail():
        return jsonify({"ok": True, "stored": _store_uploaded_files(MAIL_DIR)})

    return app


def open_when_ready(host: str, port: int, timeout_s: float = 180.0) -> None:
    """Open de browser pas als de server verbindingen accepteert."""
    target = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((target, port), timeout=1):
                webbrowser.open(f"http://{target}:{port}/")
                return
        except OSError:
            time.sleep(0.25)


def launch_app() -> None:
    host = os.environ.get("BOS_SERVER_NAME", "127.0.0.1")
    port = int(os.environ.get("BOS_SERVER_PORT", "7862"))
    if os.environ.get("BOS_INBROWSER", "true").lower() in {"1", "true", "yes", "ja"}:
        threading.Thread(target=open_when_ready, args=(host, port), daemon=True).start()
    print(
        f"Opstarten duurt een paar seconden. Daarna staat het dashboard op http://{host}:{port}/",
        flush=True,
    )
    create_app().run(host=host, port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    launch_app()
