import { z } from 'zod';

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1).optional(),
  RUNNER_DATABASE_PATH: z.string().min(1),
  RUNNER_ORIGIN: z.string().url().default('http://127.0.0.1:3000'),
  ALLOWED_ROOTS: z.string().min(1),
  SESSION_MANAGER_USER_IDS: z.string().optional(),
  SESSION_MANAGER_ROLE_IDS: z.string().optional(),
  CLAUDE_MODEL: z.string().min(1).default('sonnet'),
  CLAUDE_CODE_EXECUTABLE: z.string().min(1).optional(),
  CLAUDE_EXECUTABLE: z.string().min(1).optional()
});

export type AppConfig = Readonly<{
  discordToken: string;
  discordClientId: string;
  discordGuildId: string | null;
  runnerDatabasePath: string;
  runnerOrigin: string;
  allowedRoots: readonly string[];
  sessionManagerUserIds: readonly string[];
  sessionManagerRoleIds: readonly string[];
  claudeModel: string;
  claudeCodeExecutable: string;
}>; 

export function parseAppConfig(
  env: Record<string, string | undefined>
): AppConfig {
  const parsed = envSchema.parse(env);

  return Object.freeze({
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID ?? null,
    runnerDatabasePath: parsed.RUNNER_DATABASE_PATH,
    runnerOrigin: parsed.RUNNER_ORIGIN,
    allowedRoots: splitCsv(parsed.ALLOWED_ROOTS),
    sessionManagerUserIds: splitCsv(parsed.SESSION_MANAGER_USER_IDS ?? ''),
    sessionManagerRoleIds: splitCsv(parsed.SESSION_MANAGER_ROLE_IDS ?? ''),
    claudeModel: parsed.CLAUDE_MODEL,
    claudeCodeExecutable:
      parsed.CLAUDE_CODE_EXECUTABLE ?? parsed.CLAUDE_EXECUTABLE ?? 'claude'
    });
}

export const parseConfig = parseAppConfig;

export function getSessionManagerAllowlistWarning(config: Pick<AppConfig, 'sessionManagerUserIds' | 'sessionManagerRoleIds'>): string | null {
  if (config.sessionManagerUserIds.length > 0 || config.sessionManagerRoleIds.length > 0) {
    return null;
  }

  return 'Discord control RBAC is locked down: set SESSION_MANAGER_USER_IDS or SESSION_MANAGER_ROLE_IDS or all command actions will be denied.';
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
