import { createSessionContext } from '../shared/domain/session.js';
import type { AuditRecord } from '../shared/db/repositories.js';
import { assertPathWithinRoots, canManageSessions, resolveAllowedRoot } from '../shared/security.js';

type SessionAuditWriter = Readonly<{
  append(input: {
    action: string;
    actorType: 'user';
    actorId: string;
    source: string;
    sessionId: string | null;
    metadata: Record<string, string>;
    createdAt: string;
  }): AuditRecord;
}>;

type SessionAccess = Readonly<{
  canManageSessions(input: { userId: string; roles: string[] }): boolean;
}>;

type CommandRunnerClient = Readonly<{
  createSession(input: {
    channelId: string;
    context: ReturnType<typeof createSessionContext>;
  }): Promise<{ sessionId: string }>;
  resolvePrompt(input: {
    promptId: string;
    resolution: 'allow_once' | 'deny_once';
  }): Promise<{ status: 'resolved' | 'already_resolved' | 'stale' }>;
  answerQuestion(input: { promptId: string; answer: string }): Promise<void>;
}>;

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max']);

export type CommandHandlerDeps = Readonly<{
  runnerClient: CommandRunnerClient;
  audit: SessionAuditWriter;
  allowedRoots: readonly string[];
  access?: SessionAccess;
  now?: () => string;
}>;

type CreateSessionBaseInput = Readonly<{
  channelId: string;
  model: string;
  displayName?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  skills?: readonly string[];
  userId: string;
  roleIds: string[];
}>;

type DirectCreateSessionInput = CreateSessionBaseInput & Readonly<{
  cwd: string;
}>;

type CreateSessionInput = CreateSessionBaseInput & Readonly<{
  cwd?: string;
}>;

type CreatedSessionResult = Readonly<{
  sessionId: string;
}>;

type RequiresWorkdirResult = Readonly<{
  status: 'requires_workdir';
}>;

export function createCommandHandlers(deps: CommandHandlerDeps) {
  const audit = deps.audit;
  const access = deps.access ?? {
    canManageSessions(input) {
      return canManageSessions({
        userId: input.userId,
        roles: input.roles,
        allowedUserIds: [],
        allowedRoleIds: [],
      });
    },
  };

  const now = deps.now ?? (() => new Date().toISOString());

  function prepareCreateSession(input: DirectCreateSessionInput) {
    assertCanManage(access, input.userId, input.roleIds, 'create sessions');
    const cwd = assertPathWithinRoots(input.cwd, [...deps.allowedRoots]);
    const allowedRoot = resolveAllowedRoot(cwd, [...deps.allowedRoots]);
    const effort = normalizeEffort(input.effort);
    const skills = normalizeSkills(input.skills);

    return {
      cwd,
      allowedRoot,
      model: input.model,
      displayName: input.displayName,
      effort,
      skills,
      userId: input.userId,
      roleIds: input.roleIds,
    };
  }

  async function handleCreateSession(input: DirectCreateSessionInput): Promise<CreatedSessionResult>;
  async function handleCreateSession(input: CreateSessionInput): Promise<CreatedSessionResult | RequiresWorkdirResult>;
  async function handleCreateSession(
    input: CreateSessionInput,
  ): Promise<CreatedSessionResult | RequiresWorkdirResult> {
    if (!input.cwd) {
      assertCanManage(access, input.userId, input.roleIds, 'create sessions');
      return { status: 'requires_workdir' };
    }

    const prepared = prepareCreateSession({
      ...input,
      cwd: input.cwd,
    });

    const session = await deps.runnerClient.createSession({
      channelId: input.channelId,
      context: createSessionContext({
        cwd: prepared.cwd,
        allowedRoot: prepared.allowedRoot,
        model: prepared.model,
        runtimeOptions: {
          permissionMode: 'default',
          ...(prepared.effort ? { effort: prepared.effort } : {}),
          ...(prepared.skills.length > 0 ? { skills: prepared.skills } : {}),
        },
        createdBy: prepared.userId,
        ...(prepared.displayName ? { displayName: prepared.displayName } : {}),
      }),
    });

    audit.append({
      action: 'discord.session.create',
      actorType: 'user',
      actorId: input.userId,
      source: 'discord-control',
      sessionId: session.sessionId,
      metadata: {
        channelId: input.channelId,
        cwd: prepared.cwd,
        model: prepared.model,
      },
      createdAt: now(),
    });

    return { sessionId: session.sessionId };
  }

  return {
    prepareCreateSession,
    handleCreateSession,

    async handleResolvePrompt(input: {
      promptId: string;
      resolution: 'allow_once' | 'deny_once';
      userId: string;
      sessionId?: string;
      roleIds: string[];
    }): Promise<{ status: 'resolved' | 'already_resolved' | 'stale' }> {
      assertCanManage(access, input.userId, input.roleIds, 'resolve prompts');

      const result = await deps.runnerClient.resolvePrompt({
        promptId: input.promptId,
        resolution: input.resolution,
      });

      audit.append({
        action: 'discord.prompt.resolve',
        actorType: 'user',
        actorId: input.userId,
        source: 'discord-control',
        sessionId: input.sessionId ?? null,
        metadata: {
          promptId: input.promptId,
          resolution: input.resolution,
        },
        createdAt: now(),
      });

      return result;
    },

    async handleAnswerQuestion(input: {
      promptId: string;
      answer: string;
      userId: string;
      sessionId?: string;
      roleIds: string[];
    }): Promise<{ status: 'answered' }> {
      assertCanManage(access, input.userId, input.roleIds, 'answer questions');

      await deps.runnerClient.answerQuestion({
        promptId: input.promptId,
        answer: input.answer,
      });

      audit.append({
        action: 'discord.question.answer',
        actorType: 'user',
        actorId: input.userId,
        source: 'discord-control',
        sessionId: input.sessionId ?? null,
        metadata: {
          promptId: input.promptId,
          answer: input.answer,
        },
        createdAt: now(),
      });

      return { status: 'answered' };
    },
  };
}

function normalizeEffort(effort?: 'low' | 'medium' | 'high' | 'max') {
  if (!effort) {
    return undefined;
  }

  if (!EFFORT_LEVELS.has(effort)) {
    throw new Error(`Unsupported effort level: ${effort}`);
  }

  return effort;
}

function normalizeSkills(skills?: readonly string[]) {
  if (!skills) {
    return [];
  }

  const unique = new Set<string>();

  for (const skill of skills) {
    const normalized = skill.trim();
    if (normalized.length > 0) {
      unique.add(normalized);
    }
  }

  return [...unique];
}

function assertCanManage(
  access: SessionAccess,
  userId: string,
  roleIds: string[],
  action: string,
): void {
  if (!access.canManageSessions({ userId, roles: roleIds })) {
    throw new Error(`User is not authorized to ${action}`);
  }
}
