"""Check MyQ garage doors and email an alert if any door has been open >45 min.

NOTE ON MYQ API ACCESS:
  Chamberlain shut down unofficial MyQ API access in late 2023 and actively
  blocks third-party clients. The `pymyq` library may fail to authenticate or
  return 403/401 errors. If that happens, alternatives include:
    - Using ratgdo hardware + Home Assistant + a webhook.
    - Running this against a self-hosted MyQ proxy.
  This script is structured so the MyQ fetcher can be swapped out.

State persistence:
  To avoid re-alerting every run for the same open session, we track the
  `state_updated` timestamp of the last door-open we alerted on in
  `state.json`, which the GitHub Actions workflow commits back to the repo.
"""

from __future__ import annotations

import asyncio
import json
import os
import smtplib
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path

import aiohttp
import pymyq

OPEN_THRESHOLD_MINUTES = 45
STATE_FILE = Path(__file__).parent / "state.json"


@dataclass
class DoorStatus:
    name: str
    state: str  # "open", "closed", etc.
    state_updated: datetime  # when state last changed

    @property
    def open_minutes(self) -> float:
        delta = datetime.now(timezone.utc) - self.state_updated
        return delta.total_seconds() / 60.0


async def fetch_doors() -> list[DoorStatus]:
    email = os.environ["MYQ_EMAIL"]
    password = os.environ["MYQ_PASSWORD"]
    async with aiohttp.ClientSession() as session:
        api = await pymyq.login(email, password, session)
        doors: list[DoorStatus] = []
        for device in api.covers.values():
            # pymyq exposes state_updated as a datetime for the last state change
            state_updated = getattr(device, "state_updated", None)
            if state_updated is None:
                # Fallback: use device's last-update attribute if present
                state_updated = datetime.now(timezone.utc)
            if state_updated.tzinfo is None:
                state_updated = state_updated.replace(tzinfo=timezone.utc)
            doors.append(
                DoorStatus(
                    name=device.name,
                    state=device.state,
                    state_updated=state_updated,
                )
            )
        return doors


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True))


def send_email(subject: str, body: str) -> None:
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ["SMTP_USER"]
    password = os.environ["SMTP_PASSWORD"]
    to_addr = os.environ["ALERT_TO"]
    from_addr = os.environ.get("ALERT_FROM", user)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg.set_content(body)

    with smtplib.SMTP(host, port) as smtp:
        smtp.starttls()
        smtp.login(user, password)
        smtp.send_message(msg)


def should_alert(door: DoorStatus, state: dict) -> bool:
    if door.state != "open":
        return False
    if door.open_minutes < OPEN_THRESHOLD_MINUTES:
        return False
    # Dedup: don't re-alert for the same open session.
    last_alerted = state.get("last_alerted", {}).get(door.name)
    current_marker = door.state_updated.isoformat()
    return last_alerted != current_marker


def record_alert(door: DoorStatus, state: dict) -> None:
    state.setdefault("last_alerted", {})[door.name] = door.state_updated.isoformat()


async def main() -> int:
    try:
        doors = await fetch_doors()
    except Exception as exc:
        print(f"ERROR: failed to fetch MyQ state: {exc}", file=sys.stderr)
        return 1

    if not doors:
        print("No covers found on MyQ account.")
        return 0

    state = load_state()
    alerts_sent = 0

    for door in doors:
        print(
            f"{door.name}: {door.state} "
            f"(since {door.state_updated.isoformat()}, "
            f"{door.open_minutes:.1f} min)"
        )
        if should_alert(door, state):
            subject = f"Garage door '{door.name}' has been open {int(door.open_minutes)} min"
            body = (
                f"Heads up — your garage door '{door.name}' has been open for "
                f"{int(door.open_minutes)} minutes "
                f"(since {door.state_updated.astimezone().strftime('%Y-%m-%d %H:%M %Z')}).\n\n"
                f"Threshold: {OPEN_THRESHOLD_MINUTES} minutes."
            )
            send_email(subject, body)
            record_alert(door, state)
            alerts_sent += 1
            print(f"  -> alert sent")
        # Clear dedup marker once door closes so next open session can alert
        if door.state == "closed":
            state.get("last_alerted", {}).pop(door.name, None)

    save_state(state)
    print(f"Done. Alerts sent: {alerts_sent}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
