/**
 * Channel listening / filter tests — prove the bot forwards messages from
 * allow-listed channels and ignores everything else, without a live Discord
 * connection.
 */

import { describe, expect, it } from 'vitest';
import type { Message } from 'discord.js';

import { config } from '../../shared/config.js';
import {
  classifyMessage,
  hasForwardableContent,
  isAllowedDiscordChannel,
  shouldMirrorMessage,
  type MessageFilterConfig,
} from '../messageFilter.js';

// ---------------------------------------------------------------------------
// Minimal discord.js Message mock
// ---------------------------------------------------------------------------

interface MockMessageOpts {
  channelId?: string;
  parentId?: string | null;
  system?: boolean;
  webhookId?: string | null;
  author?: { id: string; bot?: boolean };
}

function mockMessage(opts: MockMessageOpts = {}): Message {
  return {
    id: 'msg-001',
    channelId: opts.channelId ?? 'chan-001',
    system: opts.system ?? false,
    webhookId: opts.webhookId ?? null,
    author: opts.author ?? { id: 'author-001', bot: false },
    channel: { parentId: opts.parentId ?? null },
  } as unknown as Message;
}

const ALLOW: MessageFilterConfig = {
  discordAllowedChannelIds: ['111', '222', '333'],
  discordAllowedAuthorIds: [],
};

// ---------------------------------------------------------------------------
// isAllowedDiscordChannel
// ---------------------------------------------------------------------------

describe('isAllowedDiscordChannel', () => {
  it('matches a directly allow-listed channel id', () => {
    expect(isAllowedDiscordChannel(mockMessage({ channelId: '222' }), ALLOW.discordAllowedChannelIds)).toBe(true);
  });

  it('matches a thread whose parent channel is allow-listed', () => {
    const msg = mockMessage({ channelId: 'thread-999', parentId: '333' });
    expect(isAllowedDiscordChannel(msg, ALLOW.discordAllowedChannelIds)).toBe(true);
  });

  it('rejects a channel that is not on the allow-list', () => {
    expect(isAllowedDiscordChannel(mockMessage({ channelId: '999' }), ALLOW.discordAllowedChannelIds)).toBe(false);
  });

  it('fails closed when the allow-list is empty', () => {
    expect(isAllowedDiscordChannel(mockMessage({ channelId: '222' }), [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyMessage — the full ordered filter chain
// ---------------------------------------------------------------------------

describe('classifyMessage', () => {
  it('forwards a normal message posted in an allow-listed channel', () => {
    const result = classifyMessage(mockMessage({ channelId: '111' }), ALLOW);
    expect(result).toEqual({ forward: true, reason: 'allowed' });
  });

  it('forwards a message from a thread under an allow-listed parent', () => {
    const result = classifyMessage(mockMessage({ channelId: 'thread-1', parentId: '222' }), ALLOW);
    expect(result.forward).toBe(true);
  });

  it('ignores messages from channels not on the allow-list', () => {
    const result = classifyMessage(mockMessage({ channelId: '999' }), ALLOW);
    expect(result).toEqual({ forward: false, reason: 'channel_not_allowed' });
  });

  it('ignores all messages when the channel allow-list is empty (fail-closed)', () => {
    const emptyCfg: MessageFilterConfig = {
      discordAllowedChannelIds: [],
      discordAllowedAuthorIds: [],
    };
    const result = classifyMessage(mockMessage({ channelId: '111' }), emptyCfg);
    expect(result).toEqual({ forward: false, reason: 'channel_not_allowed' });
  });

  it('ignores system messages', () => {
    const result = classifyMessage(mockMessage({ channelId: '111', system: true }), ALLOW);
    expect(result).toEqual({ forward: false, reason: 'system_message' });
  });

  it('forwards bot- and webhook-authored alert messages', () => {
    const bot = classifyMessage(mockMessage({ channelId: '111', author: { id: 'alertbot', bot: true } }), ALLOW);
    expect(bot).toEqual({ forward: true, reason: 'allowed' });

    const webhook = classifyMessage(mockMessage({ channelId: '111', webhookId: 'wh-1' }), ALLOW);
    expect(webhook).toEqual({ forward: true, reason: 'allowed' });
  });

  it('always ignores the bot’s own messages', () => {
    const result = classifyMessage(
      mockMessage({ channelId: '111', author: { id: 'self-bot', bot: true } }),
      ALLOW,
      'self-bot'
    );
    expect(result).toEqual({ forward: false, reason: 'self_author' });
  });

  it('empty author allow-list means every author is allowed', () => {
    const result = classifyMessage(mockMessage({ channelId: '111', author: { id: 'anyone' } }), ALLOW);
    expect(result.forward).toBe(true);
  });

  it('rejects authors not on a non-empty author allow-list', () => {
    const cfg: MessageFilterConfig = {
      discordAllowedChannelIds: ['111'],
      discordAllowedAuthorIds: ['trusted-user'],
    };
    const blocked = classifyMessage(mockMessage({ channelId: '111', author: { id: 'stranger' } }), cfg);
    expect(blocked).toEqual({ forward: false, reason: 'author_not_allowed' });

    const allowed = classifyMessage(mockMessage({ channelId: '111', author: { id: 'trusted-user' } }), cfg);
    expect(allowed.forward).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasForwardableContent
// ---------------------------------------------------------------------------

describe('hasForwardableContent', () => {
  it('rejects empty / whitespace-only content', () => {
    expect(hasForwardableContent('')).toBe(false);
    expect(hasForwardableContent('   \n\t ')).toBe(false);
  });

  it('accepts real content', () => {
    expect(hasForwardableContent('BTO $QQQ 710p 06/08 0.97')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldMirrorMessage
// ---------------------------------------------------------------------------

describe('shouldMirrorMessage', () => {
  it('does not mirror when no forward channel is configured', () => {
    expect(shouldMirrorMessage(mockMessage({ channelId: '111' }), null)).toBe(false);
  });

  it('does not mirror a message already in the forward channel', () => {
    expect(shouldMirrorMessage(mockMessage({ channelId: 'fwd' }), 'fwd')).toBe(false);
  });

  it('does not mirror a thread whose parent is the forward channel', () => {
    expect(shouldMirrorMessage(mockMessage({ channelId: 't', parentId: 'fwd' }), 'fwd')).toBe(false);
  });

  it('mirrors an allowed source message to a distinct forward channel', () => {
    expect(shouldMirrorMessage(mockMessage({ channelId: '111' }), 'fwd')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live configuration — every channel actually configured in .env forwards
// ---------------------------------------------------------------------------

describe('configured DISCORD_ALLOWED_CHANNEL_IDS', () => {
  const configured = config.discordAllowedChannelIds;

  // Use an allow-listed author (when one is configured) so this test isolates
  // the channel gate from the separate author allow-list.
  const allowedAuthorId = config.discordAllowedAuthorIds[0] ?? 'author-001';

  it.skipIf(configured.length === 0)(
    'forwards a normal message from each configured allow-listed channel',
    () => {
      for (const channelId of configured) {
        const result = classifyMessage(mockMessage({ channelId, author: { id: allowedAuthorId } }), {
          discordAllowedChannelIds: configured,
          discordAllowedAuthorIds: config.discordAllowedAuthorIds,
        });
        expect(result, `channel ${channelId} should be forwarded`).toEqual({
          forward: true,
          reason: 'allowed',
        });
      }
    }
  );
});
