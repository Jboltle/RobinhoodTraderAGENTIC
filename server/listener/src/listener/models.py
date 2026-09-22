"""Normalized message record: the exact shape stored in the messages table."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class CapturedMessage:
    """A single message, flattened for storage.

    No guild fields at the top level: nothing queries by guild, and the raw
    snapshot below retains it for any later backfill.
    """

    id: str
    channel_id: str
    channel_name: str | None
    author_id: str
    author_name: str
    author_is_bot: bool
    content: str
    embeds: list[dict[str, Any]]
    attachments: list[dict[str, Any]]
    raw: dict[str, Any]
    sent_at: datetime
    edited_at: datetime | None

    @property
    def content_with_attachments(self) -> str:
        """Content with attachment URLs appended as text — the stored form.

        Mirrors what the old discord.js bot serialized into envelope content,
        so the trader's flatten-and-parse sees the same text it always has.
        Discord signs attachment URLs and they expire within about a day; the
        archive keeps the attachment metadata separately in `attachments`.
        """
        urls = [str(a["url"]) for a in self.attachments if isinstance(a, dict) and a.get("url")]
        if not urls:
            return self.content
        joined = "\n".join(urls)
        return f"{self.content}\n{joined}".strip() if self.content else joined

    @property
    def has_readable_content(self) -> bool:
        """The capture gate: text (incl. attachment URLs) or at least one embed.

        Mirrors hasForwardableContent in the old bot — an embed-only alert card
        must still be captured because the trader flattens embeds at read.
        """
        return bool(self.content_with_attachments.strip()) or bool(self.embeds)


def _serialize(obj: Any) -> Any:
    to_dict = getattr(obj, "to_dict", None)
    return to_dict() if callable(to_dict) else None


def from_discord_message(message: Any) -> CapturedMessage:
    """Flatten a discord.Message into a CapturedMessage.

    Typed as Any so the module imports without the discord package present,
    which keeps the normalizer unit-testable against plain stubs.
    """
    guild = getattr(message, "guild", None)
    channel = getattr(message, "channel", None)
    author = message.author

    embeds = [d for d in (_serialize(e) for e in message.embeds) if d is not None]
    attachments = [d for d in (_serialize(a) for a in message.attachments) if d is not None]

    avatar = getattr(author, "display_avatar", None)
    avatar_url = str(avatar.url) if avatar is not None and getattr(avatar, "url", None) else None

    # A faithful snapshot of the message as the library exposed it. discord.py
    # does not retain the original gateway frame, so this is reconstructed
    # rather than captured verbatim; it exists so a later schema change can be
    # backfilled from stored data instead of waiting for the traffic to recur.
    # Guild identity lives only here — the table has no guild columns.
    raw: dict[str, Any] = {
        "id": str(message.id),
        "type": getattr(getattr(message, "type", None), "name", None),
        "content": message.content or "",
        "embeds": embeds,
        "attachments": attachments,
        "author": {
            "id": str(author.id),
            "name": getattr(author, "name", None),
            "global_name": getattr(author, "global_name", None),
            "display_name": getattr(author, "display_name", None),
            "bot": bool(getattr(author, "bot", False)),
            "avatar_url": avatar_url,
        },
        "guild": {
            "id": str(guild.id) if guild is not None else None,
            "name": getattr(guild, "name", None),
        },
        "channel": {
            "id": str(channel.id) if channel is not None else None,
            "name": getattr(channel, "name", None),
            "type": getattr(getattr(channel, "type", None), "name", None),
        },
        "jump_url": getattr(message, "jump_url", None),
        "webhook_id": str(message.webhook_id) if getattr(message, "webhook_id", None) else None,
        "pinned": bool(getattr(message, "pinned", False)),
        "tts": bool(getattr(message, "tts", False)),
        "reference_id": (
            str(message.reference.message_id)
            if getattr(message, "reference", None) and message.reference.message_id
            else None
        ),
    }

    return CapturedMessage(
        id=str(message.id),
        channel_id=str(channel.id) if channel is not None else "",
        channel_name=getattr(channel, "name", None),
        author_id=str(author.id),
        author_name=getattr(author, "display_name", None) or getattr(author, "name", "") or "",
        author_is_bot=bool(getattr(author, "bot", False)),
        content=message.content or "",
        embeds=embeds,
        attachments=attachments,
        raw=raw,
        sent_at=message.created_at,
        edited_at=getattr(message, "edited_at", None),
    )
