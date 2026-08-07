import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { entersState, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { createLogger } from '../logger.js';
import { describeTrack } from '../spotify/client.js';
import type { SyncEngine } from '../sync.js';

const log = createLogger('bot');

const SPOTIFY_GREEN = 0x1db954;

export function createBot(sync: SyncEngine): Client {
  const client = new Client({
    // GuildVoiceStates is required to read which channel a member is in.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  client.once(Events.ClientReady, (ready) => {
    log.info(`Logged in as ${ready.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      await handleCommand(interaction, sync);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Command /${interaction.commandName} failed: ${message}`);
      await reply(interaction, `Something went wrong: ${message}`);
    }
  });

  // Surface sync activity back into the channel the user last interacted with.
  sync.on('resolveFailed', (track, error) => {
    log.warn(`Skipping "${describeTrack(track)}": ${error.message}`);
  });

  sync.on('error', (error) => {
    log.error(`Sync error: ${error.message}`);
  });

  return client;
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  sync: SyncEngine,
): Promise<void> {
  switch (interaction.commandName) {
    case 'join':
      return handleJoin(interaction, sync);
    case 'leave':
      return handleLeave(interaction, sync);
    case 'nowplaying':
      return handleNowPlaying(interaction, sync);
    case 'resync':
      return handleResync(interaction, sync);
    default:
      return reply(interaction, 'Unknown command.');
  }
}

async function handleJoin(
  interaction: ChatInputCommandInteraction,
  sync: SyncEngine,
): Promise<void> {
  const member = interaction.member as GuildMember | null;
  const channel = member?.voice.channel;

  if (!channel || !interaction.guild) {
    return reply(interaction, 'Join a voice channel first, then run `/join`.');
  }

  await interaction.deferReply();

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: interaction.guild.id,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    connection.destroy();
    await interaction.editReply('Could not connect to the voice channel in time.');
    return;
  }

  sync.attach(connection);

  await interaction.editReply(
    `Connected to **${channel.name}**. Now mirroring your Spotify — play something and it will follow.`,
  );
}

async function handleLeave(
  interaction: ChatInputCommandInteraction,
  sync: SyncEngine,
): Promise<void> {
  if (!sync.isActive) {
    return reply(interaction, 'Not currently connected.');
  }
  sync.detach();
  await interaction.reply('Disconnected and stopped mirroring.');
}

async function handleNowPlaying(
  interaction: ChatInputCommandInteraction,
  sync: SyncEngine,
): Promise<void> {
  const track = sync.nowPlaying;
  if (!track) {
    return reply(interaction, 'Nothing is playing on Spotify right now.');
  }

  const embed = new EmbedBuilder()
    .setColor(SPOTIFY_GREEN)
    .setTitle(track.name)
    .setDescription(track.artists.join(', ') || 'Unknown artist')
    .addFields(
      { name: 'Album', value: track.album || '—', inline: true },
      { name: 'Position', value: formatDuration(sync.player.position()), inline: true },
      { name: 'Length', value: formatDuration(track.durationMs), inline: true },
    );

  if (track.artworkUrl) embed.setThumbnail(track.artworkUrl);
  if (track.externalUrl) embed.setURL(track.externalUrl);

  await interaction.reply({ embeds: [embed] });
}

async function handleResync(
  interaction: ChatInputCommandInteraction,
  sync: SyncEngine,
): Promise<void> {
  if (!sync.isActive) {
    return reply(interaction, 'Not currently connected. Run `/join` first.');
  }
  sync.forceResync();
  await reply(interaction, 'Re-syncing with Spotify.');
}

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(content);
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
