export const SessionState = {
  created: 'created',
  idle: 'idle',
  running: 'running',
  awaitingPermission: 'awaiting_permission',
  awaitingUserAnswer: 'awaiting_user_answer',
  interrupting: 'interrupting',
  completed: 'completed',
  failed: 'failed',
  recovering: 'recovering',
  closed: 'closed'
} as const;

export const SESSION_STATES = Object.values(SessionState);

export type SessionState = (typeof SessionState)[keyof typeof SessionState];

export type SessionRuntimeOptions = Readonly<{
  permissionMode: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  skills?: readonly string[];
}>;

export type SessionContext = Readonly<{
  cwd: string;
  allowedRoot: string;
  model: string;
  runtimeOptions: SessionRuntimeOptions;
  createdBy: string;
}>;

export type ApprovalMatcherInput = {
  scope: 'once' | 'workspace-write';
  target?: string;
};

export type ApprovalMatcher =
  | Readonly<{ scope: 'once' }>
  | Readonly<{ scope: 'workspace-write'; target: string }>;

export function createSessionContext(input: {
  cwd: string;
  allowedRoot: string;
  model: string;
  runtimeOptions: SessionRuntimeOptions;
  createdBy: string;
}): SessionContext {
  return Object.freeze({
    cwd: input.cwd,
    allowedRoot: input.allowedRoot,
    model: input.model,
    runtimeOptions: Object.freeze({
      ...input.runtimeOptions,
      ...(input.runtimeOptions.skills
        ? { skills: Object.freeze([...input.runtimeOptions.skills]) }
        : {})
    }),
    createdBy: input.createdBy
  });
}

export function createApprovalMatcher(
  input: ApprovalMatcherInput
): ApprovalMatcher {
  const target = normalizeScopeTarget(input.target);

  if (input.scope === 'workspace-write' && target) {
    return Object.freeze({ scope: 'workspace-write', target });
  }

  return Object.freeze({ scope: 'once' });
}

function normalizeScopeTarget(target?: string): string | null {
  if (!target) {
    return null;
  }

  const normalized = target.trim();
  return normalized.length > 0 ? normalized : null;
}
