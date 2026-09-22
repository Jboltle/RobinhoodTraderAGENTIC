"""Postgres access for the Listener.

supabase/migrations/ owns the schema; this module writes to it with
hand-written SQL. The column list below is a contract with the migration and
with server/src/trader/db/schema.ts — reconcile all three when it changes.

The Listener writes only capture columns. disposition/parse/processed_at
belong to the trader's poller, with one deliberate exception: an edit to a
recap-channel row resets them so the re-ingest picks up corrected numbers.
"""

from __future__ import annotations

import json
import logging

import asyncpg

from .models import CapturedMessage

log = logging.getLogger(__name__)

_INSERT_MESSAGE = """
INSERT INTO messages (
    id, channel_id, channel_name, author_id, author_name, author_is_bot,
    content, embeds, attachments, raw, sent_at, edited_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
ON CONFLICT (id) DO NOTHING
RETURNING id
"""

_UPDATE_MESSAGE = """
UPDATE messages
   SET content = $2, embeds = $3, attachments = $4, raw = $5, edited_at = $6
 WHERE id = $1
RETURNING id
"""

# Recap posts get edited through the day (services correct their numbers), and
# the corrected content must re-ingest. Clearing the processing marks puts the
# row back on the poller's work queue; content-hash dedupe on the recap side
# makes the replay idempotent. parse is cleared with disposition to satisfy the
# messages_parse_matches_disposition constraint (recap rows never carry one).
_UPDATE_MESSAGE_RESET_PROCESSING = """
UPDATE messages
   SET content = $2, embeds = $3, attachments = $4, raw = $5, edited_at = $6,
       disposition = NULL, parse = NULL, processed_at = NULL
 WHERE id = $1
RETURNING id
"""

_SOFT_DELETE_MESSAGE = """
UPDATE messages
   SET deleted_at = now()
 WHERE id = $1 AND deleted_at IS NULL
RETURNING id
"""


async def _register_codecs(conn: asyncpg.Connection) -> None:
    # asyncpg hands back jsonb as a string and refuses to encode dicts unless a
    # codec is registered on the connection.
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


class Database:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("Database.connect() has not been awaited")
        return self._pool

    async def connect(self) -> None:
        self._pool = await asyncpg.create_pool(
            self._dsn, min_size=1, max_size=5, init=_register_codecs
        )
        log.info("connected to postgres")

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    async def store_message(self, message: CapturedMessage) -> bool:
        """Insert a captured message. Returns False if it was already stored.

        A gateway resume replays events, so a repeat is expected rather than
        exceptional; the snowflake primary key makes it a no-op.
        """
        inserted = await self.pool.fetchval(
            _INSERT_MESSAGE,
            message.id,
            message.channel_id,
            message.channel_name,
            message.author_id,
            message.author_name,
            message.author_is_bot,
            message.content_with_attachments,
            message.embeds,
            message.attachments,
            message.raw,
            message.sent_at,
            message.edited_at,
        )
        return inserted is not None

    async def record_edit(self, message: CapturedMessage, *, reset_processing: bool) -> bool:
        """Apply an edit to an already-stored message. False if it is unknown.

        reset_processing (recap-channel rows) also clears the trader's marks so
        the poller re-ingests the corrected content. Callout-channel edits never
        re-trigger trades — the archive records the correction and nothing else.
        """
        statement = _UPDATE_MESSAGE_RESET_PROCESSING if reset_processing else _UPDATE_MESSAGE
        updated = await self.pool.fetchval(
            statement,
            message.id,
            message.content_with_attachments,
            message.embeds,
            message.attachments,
            message.raw,
            message.edited_at,
        )
        return updated is not None

    async def record_delete(self, message_id: str) -> bool:
        """Soft-delete a stored message. False if it was unknown or already deleted.

        The row is kept: a deleted alert is itself a signal, and the WHERE guard
        on deleted_at makes a repeated delete event a no-op rather than moving
        the timestamp each time the gateway replays it.
        """
        deleted = await self.pool.fetchval(_SOFT_DELETE_MESSAGE, message_id)
        return deleted is not None

    async def record_bulk_delete(self, message_ids: list[str]) -> int:
        """Soft-delete many messages at once, as when a channel is purged.

        Returns how many rows this actually flipped, which is only the ones we
        had stored; unknown IDs in the purge are ignored.
        """
        if not message_ids:
            return 0
        rows = await self.pool.fetch(
            "UPDATE messages SET deleted_at = now() "
            "WHERE id = ANY($1::text[]) AND deleted_at IS NULL RETURNING id",
            message_ids,
        )
        return len(rows)
