import { REST, Routes } from 'discord.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { commands } from './commands.js';

const log = createLogger('deploy');

/**
 * Registers slash commands with Discord.
 *
 * Guild-scoped registration appears instantly; global registration can take up
 * to an hour to propagate. Set DISCORD_GUILD_ID while developing.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const rest = new REST().setToken(config.DISCORD_TOKEN);

  const route = config.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID)
    : Routes.applicationCommands(config.DISCORD_CLIENT_ID);

  await rest.put(route, { body: commands });

  log.info(
    `Registered ${commands.length} commands ${
      config.DISCORD_GUILD_ID ? `to guild ${config.DISCORD_GUILD_ID}` : 'globally (may take ~1h)'
    }`,
  );
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
