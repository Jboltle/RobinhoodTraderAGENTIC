from conftest import make_discord_message
from listener.models import from_discord_message


def test_maps_core_fields_and_keeps_guild_only_in_raw():
    captured = from_discord_message(make_discord_message())

    assert captured.id == "900"
    assert captured.channel_id == "200"
    assert captured.author_id == "7"
    assert captured.author_name == "Alert Bot"
    assert captured.author_is_bot is True
    assert captured.content == "BUY SPY 500C"
    # No guild fields on the record itself; the raw snapshot retains identity.
    assert not hasattr(captured, "guild_id")
    assert captured.raw["guild"] == {"id": "100", "name": "Alpha Server"}


def test_embeds_and_attachments_serialize_via_to_dict():
    captured = from_discord_message(
        make_discord_message(
            embeds=({"title": "Alert", "description": "BTO QQQ 710p"},),
            attachments=("https://cdn.example/chart.png",),
        )
    )

    assert captured.embeds == [{"title": "Alert", "description": "BTO QQQ 710p"}]
    assert captured.attachments == [{"url": "https://cdn.example/chart.png"}]


def test_content_with_attachments_appends_urls():
    captured = from_discord_message(
        make_discord_message(content="chart below", attachments=("https://cdn.example/a.png",))
    )
    assert captured.content_with_attachments == "chart below\nhttps://cdn.example/a.png"

    attachment_only = from_discord_message(
        make_discord_message(content="", attachments=("https://cdn.example/a.png",))
    )
    assert attachment_only.content_with_attachments == "https://cdn.example/a.png"


def test_has_readable_content_gate():
    assert from_discord_message(make_discord_message(content="text")).has_readable_content
    assert from_discord_message(
        make_discord_message(content="", embeds=({"title": "Alert"},))
    ).has_readable_content
    assert from_discord_message(
        make_discord_message(content="", attachments=("https://cdn.example/a.png",))
    ).has_readable_content
    assert not from_discord_message(make_discord_message(content="   ")).has_readable_content
