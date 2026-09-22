"""The Listener: a Discord gateway client (user token, reads as a member) that
captures watched-channel messages into the shared `messages` table.

Capture only — no forwarding, no parsing. The trader's poller consumes the
rows; the database is the entire interface between the two services.
"""
