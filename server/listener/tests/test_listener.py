"""Capture-gate and delete-guard tests.

The delete guards compare stringified payload IDs against string sets; if the
str() coercion regressed, an int would never match and every delete would be
silently dropped. The classification tests pin the gate order inherited from
the old bot's classifyMessage: system drop, recap-channel priority (no author
gate), callout channel + author allowlist, thread parent matching.
"""

from types import SimpleNamespace

import pytest

from conftest import FakeDatabase, make_discord_message, make_settings
from listener.listener import MessageListener


def make_listener(settings=None) -> tuple[MessageListener, FakeDatabase]:
    db = FakeDatabase()
    return MessageListener(settings or make_settings(), db), db


# ---- Capture gates ---------------------------------------------------------------


async def test_captures_allowed_channel_message():
    listener, db = make_listener()
    await listener.on_message(make_discord_message())
    assert db.calls[0][0] == "store"
    assert db.calls[0][1].id == "900"


async def test_ignores_unwatched_channel():
    listener, db = make_listener()
    await listener.on_message(make_discord_message(channel_id=999))
    assert db.calls == []


async def test_ignores_system_message():
    listener, db = make_listener()
    await listener.on_message(make_discord_message(type_name="pins_add"))
    assert db.calls == []


async def test_author_allowlist_gates_callout_channels():
    settings = make_settings(allowed_authors={"7"})
    listener, db = make_listener(settings)

    await listener.on_message(make_discord_message(author_id=7))
    await listener.on_message(make_discord_message(message_id=901, author_id=8))

    assert [c[1].id for c in db.calls] == ["900"]


async def test_recap_channel_skips_author_gate():
    settings = make_settings(
        allowed_channels={"200"}, allowed_authors={"7"}, recap_channels={"300"}
    )
    listener, db = make_listener(settings)

    await listener.on_message(
        make_discord_message(channel_id=300, author_id=999, content="Daily recap")
    )

    assert db.calls[0][0] == "store"


async def test_thread_matches_via_parent_channel():
    listener, db = make_listener()
    await listener.on_message(make_discord_message(channel_id=555, parent_id=200))
    assert db.calls[0][0] == "store"


async def test_unreadable_message_is_dropped():
    listener, db = make_listener()
    await listener.on_message(make_discord_message(content="   "))
    assert db.calls == []


# ---- Edits -----------------------------------------------------------------------


async def test_edit_in_callout_channel_does_not_reset_processing():
    listener, db = make_listener()
    await listener.on_message_edit(None, make_discord_message())
    assert db.calls == [("edit", "900", False)]


async def test_edit_in_recap_channel_resets_processing():
    settings = make_settings(recap_channels={"300"})
    listener, db = make_listener(settings)
    await listener.on_message_edit(None, make_discord_message(channel_id=300))
    assert db.calls == [("edit", "900", True)]


async def test_edit_in_unwatched_channel_is_ignored():
    listener, db = make_listener()
    await listener.on_message_edit(None, make_discord_message(channel_id=999))
    assert db.calls == []


# ---- Deletes ---------------------------------------------------------------------


async def test_raw_delete_in_watched_channel_stringifies_id():
    listener, db = make_listener()
    # Discord hands these back as ints, the watched set holds strings.
    payload = SimpleNamespace(message_id=900, channel_id=200, guild_id=100)
    await listener.on_raw_message_delete(payload)
    assert db.calls == [("delete", "900")]


async def test_raw_delete_in_unwatched_channel_is_ignored():
    listener, db = make_listener()
    payload = SimpleNamespace(message_id=900, channel_id=999, guild_id=100)
    await listener.on_raw_message_delete(payload)
    assert db.calls == []


async def test_raw_bulk_delete_stringifies_every_id():
    listener, db = make_listener()
    payload = SimpleNamespace(message_ids={1, 2, 3}, channel_id=200, guild_id=100)
    await listener.on_raw_bulk_message_delete(payload)
    assert db.calls[0][0] == "bulk"
    assert sorted(db.calls[0][1]) == ["1", "2", "3"]


@pytest.mark.parametrize("channel_id", [200, "200"])
async def test_delete_guard_matches_int_or_str_channel(channel_id):
    listener, db = make_listener()
    payload = SimpleNamespace(message_id=5, channel_id=channel_id, guild_id=100)
    await listener.on_raw_message_delete(payload)
    assert db.calls == [("delete", "5")]
