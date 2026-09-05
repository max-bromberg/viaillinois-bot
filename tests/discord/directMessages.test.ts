import { describe, it, expect, vi } from 'vitest';
import { createDirectMessageSender } from '../../src/discord/directMessages.ts';

/** Discord's code for a person whose settings do not allow the message. */
const CANNOT_SEND = 50007;

function clientWith(send: (content: string) => Promise<unknown>) {
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
