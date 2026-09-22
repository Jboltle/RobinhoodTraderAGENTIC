import pytest

from listener.config import ConfigError, load_settings

BASE_ENV = {
    "DISCORD_USER_TOKEN": "t" * 40,
    "SUPABASE_DB_URL": "postgresql://postgres:postgres@127.0.0.1:54332/postgres",
}


def test_parses_id_lists_and_watched_union():
    settings = load_settings(
        {
            **BASE_ENV,
            "DISCORD_ALLOWED_CHANNEL_IDS": "200, 201",
            "DISCORD_ALLOWED_AUTHOR_IDS": "7",
            "DISCORD_RECAP_CHANNEL_IDS": "300",
        }
    )
    assert settings.allowed_channel_ids == {"200", "201"}
    assert settings.watched_channel_ids == {"200", "201", "300"}
    assert settings.is_recap_channel("300")
    assert not settings.is_recap_channel("200")


def test_empty_author_list_allows_everyone():
    settings = load_settings(BASE_ENV)
    assert settings.author_allowed("anyone")

    scoped = load_settings({**BASE_ENV, "DISCORD_ALLOWED_AUTHOR_IDS": "7"})
    assert scoped.author_allowed("7")
    assert not scoped.author_allowed("8")


def test_missing_token_raises():
    with pytest.raises(ConfigError, match="DISCORD_USER_TOKEN"):
        load_settings({"SUPABASE_DB_URL": "postgresql://x/y"})


def test_missing_database_url_raises():
    with pytest.raises(ConfigError, match="SUPABASE_DB_URL"):
        load_settings({"DISCORD_USER_TOKEN": "t" * 40})


def test_non_digit_id_rejected():
    with pytest.raises(ConfigError, match="digits only"):
        load_settings({**BASE_ENV, "DISCORD_ALLOWED_CHANNEL_IDS": "<#200>"})
