import { eventSummary } from './eventCard.ts';
import type { Reply, ReplyRow } from '../discord/adapter.ts';
import type { ViaEvent } from '../via/client.ts';

/**
 * The list of what is coming up.
 *
 * One message, one compact row per event, a button per row that opens the
 * card, and a page control beneath. Five events fit on a page because Discord
 * allows five buttons in a row and five rows in a message, which leaves the
 * second row for Previous and Next.
 *
 * The rows are numbered and the buttons are labelled with the same numbers,
 * because a button labelled with a trimmed title stops matching its row as
 * soon as a title is long, and a student reading the third line should be able
 * to press the third button without reading either twice.
 */

/** How many events one page carries. */
export const PAGE_SIZE = 5;

export interface EventListOptions {
  events: readonly ViaEvent[];
  /** How many events match in all, which is what the page control counts against. */
  total: number;
  /** How far into the whole listing this page starts. */
  offset: number;
  /** What the listing was for, said in the first line. */
  heading: string;
  /** The identifier the Previous button carries, or null when there is no earlier page. */
  previousId: string | null;
  /** The identifier the Next button carries, or null when there is no later page. */
  nextId: string | null;
  /** The identifier the button that opens one event carries. */
  openId: (event: ViaEvent) => string;
}

export function renderEventList(options: EventListOptions): Reply {
  const { events, total, offset, heading, previousId, nextId, openId } = options;

  if (events.length === 0) {
    return {
      content: `${heading}\n\nThere is nothing coming up that matches what you asked for.`,
      components: [],
    };
  }

  const first = offset + 1;
  const last = offset + events.length;
  const lines = [
    heading,
    `Showing ${first} to ${last} of ${total}.`,
    '',
    ...events.map((event, index) => `${index + 1}. ${eventSummary(event, { withRso: true })}`),
  ];

  const rows: ReplyRow[] = [{
    kind: 'row',
    components: events.map((event, index) => ({
      kind: 'button' as const,
      style: 'secondary' as const,
      label: String(index + 1),
      customId: openId(event),
    })),
  }];

  // A listing that fits on one page has nothing to page through, and a control
  // whose two buttons are both dead is worse than no control.
  if (previousId !== null || nextId !== null) {
    rows.push({
      kind: 'row',
      components: [
        {
          kind: 'button',
          style: 'secondary',
          label: 'Previous',
          customId: previousId ?? 'events:page:none',
          disabled: previousId === null,
        },
        {
          kind: 'button',
          style: 'secondary',
          label: 'Next',
          customId: nextId ?? 'events:page:none',
          disabled: nextId === null,
        },
      ],
    });
  }

  return { content: lines.join('\n'), components: rows };
}
