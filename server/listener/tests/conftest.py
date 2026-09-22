from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from listener.config import Settings


class FakeDatabase:
    """Records calls; stands in for db.Database in listener tests."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def store_message(self, captured) -> bool:
        self.calls.append(("store", captured))
        return True

    async def record_edit(self, captured, *, reset_processing: bool) -> bool:
        self.calls.append(("edit", captured.id, reset_processing))
        return True

    async def record_delete(self, message_id: str) -> bool:
        self.calls.append(("delete", message_id))
        return True

    async def record_bulk_delete(self, message_ids: list[str]) -> int:
        self.calls.append(("bulk", message_ids))
        return len(message_ids)


def make_settings(
    *,
    allowed_channels: set[str] = frozenset({"200"}),
    allowed_authors: set[str] = frozenset(),
    recap_channels: set[str] = frozenset(),
) -> Settings:
    return Settings(
        token="t" * 40,
        database_url="postgresql://x/y",
        allowed_channel_ids=frozenset(allowed_channels),
        allowed_author_ids=frozenset(allowed_authors),
        recap_channel_ids=frozenset(recap_channels),
    )


def make_discord_message(
    *,
    message_id: int = 900,
    channel_id: int = 200,
    parent_id: int | None = None,
    author_id: int = 7,
    content: str = "BUY SPY 500C",
    embeds: tuple[dict, ...] = (),
    attachments: tuple[str, ...] = (),
    type_name: str = "default",
) -> SimpleNamespace:
    """A stub shaped like discord.Message, read via getattr everywhere."""
    channel = SimpleNamespace(
        id=channel_id, name="signals", type=SimpleNamespace(name="text")
    )
    if parent_id is not None:
        channel.parent_id = parent_id
    return SimpleNamespace(
        id=message_id,
        guild=SimpleNamespace(id=100, name="Alpha Server"),
        channel=channel,
        author=SimpleNamespace(
            id=author_id,
            name="Alert Bot",
            global_name=None,
            display_name="Alert Bot",
            bot=True,
            display_avatar=None,
        ),
        content=content,
        embeds=[SimpleNamespace(to_dict=lambda d=e: dict(d)) for e in embeds],
        attachments=[
            SimpleNamespace(to_dict=lambda u=url: {"url": u}) for url in attachments
        ],
        created_at=datetime(2026, 9, 21, 12, 0, tzinfo=UTC),
        edited_at=None,
        type=SimpleNamespace(name=type_name),
        webhook_id=None,
        pinned=False,
        tts=False,
        reference=None,
        jump_url=None,
    )


@pytest.fixture
def fake_db() -> FakeDatabase:
    return FakeDatabase()
