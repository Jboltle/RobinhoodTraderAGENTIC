"""Adapter from Discord gateway events to the messages table.

Capture gates mirror the old bot's classifyMessage (bot/messageFilter.ts):
system messages drop, recap channels win over the callout list and skip the
author gate, callout channels apply the author allowlist, threads match via
their parent channel. Two deliberate differences: no self-author drop (the
Listener never posts, so there is no mirror loop to prevent, and a user token's
"self" may be a legitimate test Caller), and unreadable messages are dropped
here rather than downstream (nothing else ever sees them).
"""

from __future__ import annotations

import logging
from typing import Any

import discord

from .config import Settings
from .db import Database
from .models import from_discord_message

log = logging.getLogger(__name__)

# discord.py message type names the bot treated as non-system (types 0 and 19).
_USER_MESSAGE_TYPES = frozenset({"default", "reply"})

# discord.ChannelType.news is what the client calls an Announcement channel.
_ANNOUNCEMENT = "news"


class MessageListener(discord.Client):
    def __init__(self, settings: Settings, database: Database, **options: Any) -> None:
        # Guild member chunking on connect is a large burst of traffic that this
        # service has no use for: everything needed is on the message itself.
        options.setdefault("chunk_guilds_at_startup", False)
        super().__init__(**options)
        self._settings = settings
        self._db = database

    # ---- Gates ---------------------------------------------------------------

    def _channel_ids(self, message: Any) -> tuple[str, str | None]:
        """A message's channel id and, when inside a thread, the parent's."""
        channel = getattr(message, "channel", None)
        channel_id = str(getattr(channel, "id", ""))
        parent = getattr(channel, "parent_id", None)
        return channel_id, str(parent) if parent else None

    def _classify(self, message: Any) -> str | None:
        """'recap' | 'callout' when the message should be captured, else None."""
        type_name = getattr(getattr(message, "type", None), "name", "")
        if type_name not in _USER_MESSAGE_TYPES:
            return None

        channel_id, parent_id = self._channel_ids(message)
        recap = self._settings.recap_channel_ids
        if channel_id in recap or (parent_id in recap if parent_id else False):
            return "recap"

        allowed = self._settings.allowed_channel_ids
        if channel_id not in allowed and (parent_id not in allowed if parent_id else True):
            return None
        if not self._settings.author_allowed(str(message.author.id)):
            return None
        return "callout"

    def _watched(self, channel_id: str) -> bool:
        return channel_id in self._settings.watched_channel_ids

    # ---- Gateway events --------------------------------------------------------

    async def on_ready(self) -> None:
        who = getattr(self.user, "name", "unknown")
        watched = self._settings.watched_channel_ids
        log.info("connected as %s, watching %d channel(s)", who, len(watched))
        if not watched:
            log.warning(
                "no channels configured (DISCORD_ALLOWED_CHANNEL_IDS / "
                "DISCORD_RECAP_CHANNEL_IDS); the Listener will capture nothing"
            )

        for channel_id in sorted(watched):
            channel = self.get_channel(int(channel_id))
            if channel is None:
                log.warning(
                    "channel %s is not visible to this account. Check the ID and "
                    "confirm the account can still read that channel.",
                    channel_id,
                )
                continue

            kind = getattr(getattr(channel, "type", None), "name", "")
            log.info("  #%s (%s)", getattr(channel, "name", channel_id), kind or "unknown")

            if kind == _ANNOUNCEMENT:
                # Worth surfacing loudly: an Announcement channel can be mirrored
                # with Discord's built-in Follow button, which needs no token and
                # carries no Terms of Service exposure.
                log.warning(
                    "  #%s is an Announcement channel. Discord's native Follow "
                    "feature can mirror it into your server with no account "
                    "automation.",
                    getattr(channel, "name", channel_id),
                )

    async def on_message(self, message: discord.Message) -> None:
        kind = self._classify(message)
        if kind is None:
            return

        captured = from_discord_message(message)
        if not captured.has_readable_content:
            return

        if await self._db.store_message(captured):
            log.info(
                "captured %s (%s) from #%s by %s (%d embeds)",
                captured.id,
                kind,
                captured.channel_name or captured.channel_id,
                captured.author_name,
                len(captured.embeds),
            )

    async def on_message_edit(self, _before: discord.Message, after: discord.Message) -> None:
        # Alerts get corrected, and the correction is the signal. No author
        # gate: the UPDATE only matches rows the create already stored.
        channel_id, parent_id = self._channel_ids(after)
        if not (self._watched(channel_id) or (parent_id and self._watched(parent_id))):
            return
        recap = self._settings.is_recap_channel(channel_id) or (
            parent_id is not None and self._settings.is_recap_channel(parent_id)
        )
        if await self._db.record_edit(from_discord_message(after), reset_processing=recap):
            log.info("recorded edit to %s", after.id)

    async def on_raw_message_delete(self, payload: discord.RawMessageDeleteEvent) -> None:
        # Raw rather than on_message_delete: the raw event fires even for a
        # message that was never in the client cache, and the stored row is
        # keyed by ID so no content is needed to mark it deleted.
        if not self._watched(str(payload.channel_id)):
            return
        if await self._db.record_delete(str(payload.message_id)):
            log.info("marked %s as deleted", payload.message_id)

    async def on_raw_bulk_message_delete(
        self, payload: discord.RawBulkMessageDeleteEvent
    ) -> None:
        # A channel purge arrives as one bulk event rather than many singles.
        if not self._watched(str(payload.channel_id)):
            return
        if marked := await self._db.record_bulk_delete(
            [str(mid) for mid in payload.message_ids]
        ):
            log.info("marked %d message(s) as deleted (bulk)", marked)
