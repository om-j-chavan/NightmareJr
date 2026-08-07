import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel and start mirroring your Spotify playback.'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop mirroring and leave the voice channel.'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show what Spotify is currently playing.'),

  new SlashCommandBuilder()
    .setName('resync')
    .setDescription('Force an immediate re-sync if the audio has drifted.'),
].map((command) => command.toJSON());
