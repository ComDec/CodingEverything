import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { createDiscordControlBot, listDiscordCommandDefinitions, type DiscordGateway } from './bot.js';
import { createCommandHandlers } from './command-handlers.js';
import { createHttpRunnerClient } from './runner-client.js';
import { getSessionManagerAllowlistWarning, parseAppConfig } from '../shared/config.js';
import { createDatabase } from '../shared/db/database.js';
import { createRepositories } from '../shared/db/repositories.js';
import { canManageSessions } from '../shared/security.js';

export async function startDiscordControlFromEnv(
  env: Record<string, string | undefined> = process.env
): Promise<ReturnType<typeof createDiscordControlBot>> {
  const config = parseAppConfig(env);
  const sessionManagerAllowlistWarning = getSessionManagerAllowlistWarning(config);
  if (sessionManagerAllowlistWarning) {
    console.warn(sessionManagerAllowlistWarning);
  }
  const database = createDatabase({ filename: config.runnerDatabasePath });
  const repositories = createRepositories(database);
  const runnerClient = createHttpRunnerClient({ origin: config.runnerOrigin });
  const handlers = createCommandHandlers({
    runnerClient,
    audit: repositories.audit,
    allowedRoots: config.allowedRoots,
    access: {
      canManageSessions(input) {
        return canManageSessions({
          userId: input.userId,
          roles: input.roles,
          allowedUserIds: config.sessionManagerUserIds,
          allowedRoleIds: config.sessionManagerRoleIds
        });
      }
    }
  });
  const bot = createDiscordControlBot({
    token: config.discordToken,
    clientId: config.discordClientId,
    handlers,
    runnerClient,
    bindings: repositories.bindings,
    sessions: repositories.sessions,
    deliveryState: repositories.deliveryState,
    discord: createDiscordGateway({
      token: config.discordToken,
      clientId: config.discordClientId,
      guildId: config.discordGuildId
    }),
    logger: console
  });

  await bot.start();
  return bot;
}

function createDiscordGateway(input: {
  token: string;
  clientId: string;
  guildId: string | null;
}): DiscordGateway {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });
  const rest = new REST({ version: '10' }).setToken(input.token);

  return {
    async login(token) {
      await client.login(token);
    },
    async destroy() {
      await client.destroy();
    },
    on(eventName, handler) {
      client.on(eventName, (value) => {
        void handler(value);
      });
    },
    async getThreadChannel(threadId) {
      const channel = await client.channels.fetch(threadId);
      if (!channel || !channel.isThread()) {
        return null;
      }

      return {
        isThread: () => channel.isThread(),
        send: (input) => channel.send(input as string | import('discord.js').MessageCreateOptions),
        edit: async (messageId, input) => {
          const message = await channel.messages.fetch(messageId);
          return message.edit(input as string | import('discord.js').MessageEditOptions);
        }
      };
    },
    async getChannel(channelId) {
      return client.channels.fetch(channelId);
    },
    async registerCommands(commands) {
      const body = commands.map((command) => ({
        name: command.name,
        description: command.description,
        options: command.options?.map((option) => ({
          type: 3,
          name: option.name,
          description: option.description,
          required: option.required ?? false
        })) ?? []
      }));

      if (input.guildId) {
        await rest.put(Routes.applicationGuildCommands(input.clientId, input.guildId), { body });
        return;
      }

      await rest.put(Routes.applicationCommands(input.clientId), { body });
    }
  };
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file://').href) {
  const bot = await startDiscordControlFromEnv();

  const shutdown = async () => {
    await bot.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

export { listDiscordCommandDefinitions };
