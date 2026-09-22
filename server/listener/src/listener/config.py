"""Environment-driven configuration.

The Listener reads the same repo-root .env as the TypeScript services and the
same channel/author variables the bot used, so there is exactly one config
surface: SUPABASE_DB_URL, DISCORD_USER_TOKEN, DISCORD_ALLOWED_CHANNEL_IDS,
DISCORD_ALLOWED_AUTHOR_IDS, DISCORD_RECAP_CHANNEL_IDS.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# server/listener/src/listener/config.py -> repo root is four levels up.
REPO_ROOT = Path(__file__).resolve().parents[4]


class ConfigError(Exception):
    """Raised when the environment is unusable."""


@dataclass(frozen=True)
class Settings:
    token: str
    database_url: str
    allowed_channel_ids: frozenset[str]
    # Empty means every author is allowed, matching isAllowed() in
    # server/src/shared/config.ts.
    allowed_author_ids: frozenset[str]
    recap_channel_ids: frozenset[str]

    @property
    def watched_channel_ids(self) -> frozenset[str]:
        return self.allowed_channel_ids | self.recap_channel_ids

    def is_recap_channel(self, channel_id: str) -> bool:
        return channel_id in self.recap_channel_ids

    def author_allowed(self, author_id: str) -> bool:
        return not self.allowed_author_ids or author_id in self.allowed_author_ids


def _id_list(env: dict[str, str] | os._Environ[str], name: str) -> frozenset[str]:
    """Comma-separated Discord IDs. Digits-only catches pasted mentions/typos."""
    out: set[str] = set()
    for part in (env.get(name) or "").split(","):
        text = part.strip()
        if not text:
            continue
        if not text.isdigit():
            raise ConfigError(f"{name}: {text!r} is not a Discord ID (digits only)")
        out.add(text)
    return frozenset(out)


def load_settings(environ: dict[str, str] | None = None) -> Settings:
    env = os.environ if environ is None else environ

    token = (env.get("DISCORD_USER_TOKEN") or "").strip()
    if not token:
        raise ConfigError(
            "DISCORD_USER_TOKEN is not set. This is a user token (the account reads "
            "as a member); see the README's self-bot risk section before setting it."
        )

    database_url = (env.get("SUPABASE_DB_URL") or "").strip()
    if not database_url:
        raise ConfigError("SUPABASE_DB_URL is not set")

    return Settings(
        token=token,
        database_url=database_url,
        allowed_channel_ids=_id_list(env, "DISCORD_ALLOWED_CHANNEL_IDS"),
        allowed_author_ids=_id_list(env, "DISCORD_ALLOWED_AUTHOR_IDS"),
        recap_channel_ids=_id_list(env, "DISCORD_RECAP_CHANNEL_IDS"),
    )
