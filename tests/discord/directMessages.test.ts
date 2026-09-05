import { describe, it, expect, vi } from 'vitest';
import {
  createDirectMessageDelivery, createDirectMessageSender,
} from '../../src/discord/directMessages.ts';

/** Discord's code for a person whose settings do not allow the message. */
const CANNOT_SEND = 50007;

function clientWith(send: (payload: never) => Promise<unknown>) {
  const fetch = vi.fn(async (_id: string) => ({ send }));
  return { client: { users: { fetch } } as never, fetch };
}

describe('sending a direct message', () => {
  it('fetches the person and sends them the message', async () => {
    const send = vi.fn(async () => ({}));
    const { client, fetch } = clientWith(send);
    const sendDirectMessage = createDirectMessageSender(client);
    expect(await sendDirectMessage('204255221017214977', 'You are linked.')).toBe(true);
    expect(fetch).toHaveBeenCalledWith('204255221017214977');
    expect(send).toHaveBeenCalledWith('You are linked.');
  });

  it('says the message did not arrive when the person does not accept direct messages', async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error('Cannot send messages to this user'), { code: CANNOT_SEND }); });
    const { client } = clientWith(send);
    expect(await createDirectMessageSender(client)('204255221017214977', 'You are linked.')).toBe(false);
  });

  it('says the message did not arrive when Discord fails for any other reason', async () => {
    const send = vi.fn(async () => { throw new Error('Discord is having a bad day'); });
    const { client } = clientWith(send);
    expect(await createDirectMessageSender(client)('204255221017214977', 'You are linked.')).toBe(false);
  });
});

/**
 * The jobs need to tell one failure from another. A person who has closed
 * their direct messages is not a fault to retry: it is an answer, and section
 * 6.4 of the design has the bot switch their direct messages off rather than
 * write to them every week and fail every week. Anything else is a failure the
 * job leaves owed.
 */
describe('delivering a direct message a job sends', () => {
  it('says that the message was sent', async () => {
    const send = vi.fn(async () => ({}));
    const { client } = clientWith(send);
    const deliver = createDirectMessageDelivery(client);
    expect(await deliver('204255221017214977', { content: 'Your week on VIA' })).toBe('sent');
    expect(send).toHaveBeenCalledWith({ content: 'Your week on VIA', components: [] });
  });

  it('says that the person does not accept direct messages', async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error('Cannot send messages to this user'), { code: CANNOT_SEND }); });
    const { client } = clientWith(send);
    expect(await createDirectMessageDelivery(client)('204255221017214977', { content: 'Your week' }))
      .toBe('blocked');
  });

  it('says that something else went wrong, which is a message still owed', async () => {
    const send = vi.fn(async () => { throw new Error('Discord is having a bad day'); });
    const { client } = clientWith(send);
    expect(await createDirectMessageDelivery(client)('204255221017214977', { content: 'Your week' }))
      .toBe('failed');
  });

  it('carries the buttons a reply was built with', async () => {
    let payload: { components?: unknown[] } = {};
    const send = (async (given: { components?: unknown[] }) => { payload = given; return {}; }) as never;
    const { client } = clientWith(send);
    await createDirectMessageDelivery(client)('204255221017214977', {
      content: 'Your week',
      components: [{ kind: 'row', components: [{ kind: 'button', style: 'link', label: 'Open on VIA', url: 'https://viaillinois.com/events/10' }] }],
    });
    expect(payload.components).toHaveLength(1);
  });
});
