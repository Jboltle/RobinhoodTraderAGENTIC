"""Entry point: wires the gateway listener to the archive. Capture only."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys

from dotenv import load_dotenv

from .config import REPO_ROOT, ConfigError, Settings, load_settings
from .db import Database
from .listener import MessageListener

log = logging.getLogger("listener")


class _RedactSecrets(logging.Filter):
    """Last line of defence against a secret reaching a log sink.

    The user token bypasses two-factor authentication, so anything that could
    echo it (a traceback, a connection error carrying a DSN) gets scrubbed at
    the handler.
    """

    def __init__(self, secrets: list[str]) -> None:
        super().__init__()
        self._secrets = [s for s in secrets if s and len(s) > 8]

    def filter(self, record: logging.LogRecord) -> bool:
        if self._secrets:
            text = record.getMessage()
            if any(s in text for s in self._secrets):
                for secret in self._secrets:
                    text = text.replace(secret, "***REDACTED***")
                record.msg = text
                record.args = ()
        return True


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    # discord.py-self is chatty at INFO about gateway internals.
    logging.getLogger("discord").setLevel(logging.WARNING)


def _install_redaction(settings: Settings) -> None:
    log_filter = _RedactSecrets([settings.token, settings.database_url])
    for handler in logging.getLogger().handlers:
        handler.addFilter(log_filter)


async def _run(settings: Settings) -> None:
    database = Database(settings.database_url)
    await database.connect()

    client = MessageListener(settings, database)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, lambda: asyncio.ensure_future(client.close()))

    try:
        # reconnect=True gives the library's own backoff and RESUME handling. A
        # hot reconnect loop is a strong automation signal, so this is never
        # reimplemented here.
        await client.start(settings.token, reconnect=True)
    finally:
        await client.close()
        await database.close()
        log.info("shutdown complete")


def main() -> int:
    # Same precedence as server/src/shared/config.ts: base .env first, then the
    # NODE_ENV profile; dotenv never overrides variables already set, and in
    # Docker (no files) both loads silently no-op.
    load_dotenv(REPO_ROOT / ".env")
    node_env = "production" if os.environ.get("NODE_ENV") == "production" else "development"
    load_dotenv(REPO_ROOT / f".env.{node_env}")

    _configure_logging(os.environ.get("LOG_LEVEL", "INFO"))

    try:
        settings = load_settings()
    except ConfigError as exc:
        log.error("configuration error: %s", exc)
        return 1

    _install_redaction(settings)

    try:
        asyncio.run(_run(settings))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
