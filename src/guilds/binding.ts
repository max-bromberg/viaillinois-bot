import type { GuildStore } from './store.ts';
import type { OutboxHandlers } from '../outbox/consumer.ts';
import type { OutboxEntry, ViaClient } from '../via/client.ts';

/**
 * Keeping the web platform's picture of the bindings true, and doing what a
 * board says when they disconnect a server from their dashboard.
 *
 * The binding belongs here. It is a fact about a Discord server, the bot is
 * what is installed in it, and Guild_Installations is the record of it. The
 * web platform has no account on this database and is not meant to have one,
 * so a board looking at their own dashboard would have nothing to read unless
 * the bot said what it has. The reporter is what says it.
 *
 * The instruction travels the other way, through the outbox, because the web
 * platform cannot reach into this database either. A board that disconnects a
 * server on the website has the binding cleared here the next time the bot
 * reads its instructions.
 */

export interface BindingReporterOptions {
  guilds: GuildStore;
  via: ViaClient;
}

export function createBindingReporter({ guilds, via }: BindingReporterOptions) {
  /**
   * Say what this server is now, whatever that is.
   *
   * The report is the state rather than the change, so it is safe to call
   * after anything that might have moved a binding, and calling it twice says
   * the same thing twice rather than creating a second server.
   *
   * A server bound to all of ECE, or to a chosen set of organizations, belongs
   * to no single organization, so there is no board whose dashboard it would
   * appear on and it is reported as bound to nothing. The same goes for a
   * server that has not finished setup.
   */
  async function report(guildId: string, guildName: string): Promise<void> {
    try {
      const installation = await guilds.getInstallation(guildId);
      const rsoId = installation?.binding === 'rso' ? installation.rsoId : null;

      if (rsoId === null || rsoId === undefined) {
        await via.forgetGuildBinding(guildId);
        return;
      }

      await via.reportGuildBinding({
        guildId,
        rsoId,
        guildName,
        boundBy: installation?.boundBy ?? null,
      });
    } catch (err) {
      /*
       * The web platform being away is not a reason for the command that
       * triggered this to fail in front of the person running it. The binding
       * is already recorded here, which is what makes the bot work in that
       * server at all, and the mirror catches up the next time anything
       * reports. What is lost meanwhile is a line on a dashboard.
       */
      console.log(`reporting the binding of ${guildId} failed: ${(err as Error).message}`);
    }
  }

  /** Say that a server is bound to nothing, because the bot has left it. */
  async function forget(guildId: string): Promise<void> {
    try {
      await via.forgetGuildBinding(guildId);
    } catch (err) {
      console.log(`forgetting the binding of ${guildId} failed: ${(err as Error).message}`);
    }
  }

  return { report, forget };
}

export interface GuildBindingHandlerOptions {
  guilds: GuildStore;
}

export function createGuildBindingHandlers(
  { guilds }: GuildBindingHandlerOptions,
): OutboxHandlers {
  return {
    async 'guild.unbound'(entry: OutboxEntry): Promise<void> {
      const payload = (entry.payload ?? {}) as Record<string, unknown>;
      const guildId = String(payload.guild_id ?? '').trim();
      const rsoId = Number(payload.rso_id);

      if (!guildId) {
        console.log(`outbox entry ${entry.outboxId} carries no server to disconnect`);
        return;
      }

      const installation = await guilds.getInstallation(guildId);
      if (!installation) {
        // A server the bot is no longer in is nothing to clear. The board
        // disconnected it on the website and the website has already forgotten
        // it, so there is nothing owed here either.
        return;
      }

      /*
       * The instruction names the organization the board was acting for. A
       * server that has since been bound to a different organization is not
       * theirs to disconnect any more, and clearing it would quietly undo
       * somebody else's setup on the strength of an older instruction.
       */
      if (installation.rsoId !== rsoId) {
        console.log(
          `the instruction to disconnect ${guildId} named organization ${rsoId}, `
          + `which is not the one it is bound to, so it was left alone`,
        );
        return;
      }

      await guilds.setBinding(guildId, { binding: null });
      console.log(`${guildId} was disconnected from organization ${rsoId} on the website`);
    },
  };
}
