import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { createCommandHandlers } from './command-handlers.js';
import type { RunnerControlClient } from './runner-client.js';
import type { BindingRecord, SessionRecord } from '../shared/db/repositories.js';
import { renderSessionMessage } from './message-renderer.js';
import { replaySessionEvents } from './replay-controller.js';
import { applyRunnerEvent, createRenderModel, startNewTurn, type BashDetailModel, type RunnerEventEnvelope, type SessionRenderModel } from './render-model.js';
import { resolveSessionDisplayName } from './session-display-name.js';
import { recoverStartupState } from './startup-recovery.js';

export type DiscordCommandDefinition = Readonly<{
  name: string;
  description: string;
  options?: ReadonlyArray<{
    type: 'string';
    name: string;
    description: string;
    required?: boolean;
  }>;
}>;

export type DiscordGateway = Readonly<{
  login(token: string): Promise<void>;
  destroy(): Promise<void>;
  on(eventName: 'interactionCreate' | 'messageCreate', handler: (value: unknown) => Promise<void>): void;
  registerCommands(commands: readonly DiscordCommandDefinition[]): Promise<void>;
  getChannel?(channelId: string): Promise<unknown | null>;
  getThreadChannel?(threadId: string): Promise<ThreadMessageChannel | null>;
}>;

type ThreadMessageChannel = Readonly<{
  isThread: () => boolean;
  send: (input: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }) => Promise<unknown>;
  edit?: (messageId: string, input: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }) => Promise<unknown>;
}>;

type CreatedThreadChannel = ThreadMessageChannel & Readonly<{
  id: string;
}>;

type BindingReader = Readonly<{
  getByThreadId(threadId: string): BindingRecord | null;
  upsert?(record: BindingRecord): void;
  listAll?(): readonly BindingRecord[];
  deleteByThreadId?(threadId: string): void;
}>; 

type SessionReader = Readonly<{
  listActive?(): readonly SessionRecord[];
}>;

type DeliveryStateStore = Readonly<{
  getBySessionId(sessionId: string): {
    sessionId: string;
    cursor: string;
    rootMessageId: string | null;
    deliveredToolCallIds?: readonly string[];
    updatedAt: string;
  } | null;
  save(record: {
    sessionId: string;
    cursor: string;
    rootMessageId: string | null;
    deliveredToolCallIds: readonly string[];
    updatedAt: string;
  }): void;
  deleteBySessionId?(sessionId: string): void;
  listSessionIds?(): readonly string[];
}>;

export type DiscordControlBot = Readonly<{
  start: () => Promise<void>;
  stop: () => Promise<void>;
}>;

export type DiscordControlBotDeps = Readonly<{
  token: string;
  clientId?: string;
  handlers: ReturnType<typeof createCommandHandlers>;
  runnerClient: Pick<RunnerControlClient, 'getPendingPrompt' | 'getSession' | 'health' | 'listEvents' | 'sendTurn' | 'subscribeEvents'>;
  bindings: BindingReader;
  sessions?: SessionReader;
  deliveryState?: DeliveryStateStore;
  discord: DiscordGateway;
  logger?: Pick<Console, 'info' | 'error'>;
  now?: () => string;
  random?: () => number;
}>; 

const COMMANDS: readonly DiscordCommandDefinition[] = [
  {
    name: 'session-new',
    description: 'Create a Claude runner session in a thread',
    options: [
      { type: 'string', name: 'cwd', description: 'Working directory', required: true },
      { type: 'string', name: 'name', description: 'Optional session display name', required: false },
      { type: 'string', name: 'model', description: 'Claude model', required: false },
      { type: 'string', name: 'effort', description: 'Reasoning effort: low, medium, high, max', required: false },
      { type: 'string', name: 'skills', description: 'Comma-separated Claude skills to preload', required: false }
    ]
  }
];

const SYSTEM_EMBED_COLOR = 0x6b7280;
const WAITING_PLACEHOLDERS = ['Typing...', 'Thinking...', 'Wondering...'] as const;

export function createDiscordControlBot(deps: DiscordControlBotDeps): DiscordControlBot {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date().toISOString());
  const models = new Map<string, SessionRenderModel>();
  const subscriptions = new Map<string, AbortController>();
  const waitingPlaceholders = new Map<string, string>();
  let started = false;

  return {
    async start() {
      if (deps.token.trim().length === 0) {
        throw new Error('DISCORD_TOKEN is required to start Discord control');
      }

      if (started) {
        return;
      }

      deps.discord.on('interactionCreate', async (value) => {
        try {
          await handleInteraction(deps, value);
        } catch (error) {
          logger.error(formatError(error));
          await replyWithInteractionError(value, error);
        }
      });
      deps.discord.on('messageCreate', async (value) => {
        try {
          await handleMessage(deps, value, models, subscriptions, waitingPlaceholders, now);
        } catch (error) {
          logger.error(formatError(error));
        }
      });
      await deps.discord.login(deps.token);
      await deps.discord.registerCommands(COMMANDS);
      pruneOrphanedDeliveryState(deps);
      await recoverExistingSessions(deps, models, subscriptions, waitingPlaceholders, now);

      started = true;
      logger.info(`Discord control connected for client ${deps.clientId ?? 'unknown-client'}.`);
    },
    async stop() {
      if (!started) {
        return;
      }

      started = false;
      for (const controller of subscriptions.values()) {
        controller.abort();
      }
      subscriptions.clear();
      clearAllWaitingPlaceholders(waitingPlaceholders);
      await deps.discord.destroy();
      logger.info('Discord control stopped.');
    }
  };
}

function pruneOrphanedDeliveryState(deps: DiscordControlBotDeps): void {
  const listSessionIds = deps.deliveryState?.listSessionIds;
  const deleteBySessionId = deps.deliveryState?.deleteBySessionId;
  const listBindings = deps.bindings.listAll;

  if (!listSessionIds || !deleteBySessionId || !listBindings) {
    return;
  }

  const boundSessionIds = new Set(listBindings().map((binding) => binding.sessionId));

  for (const sessionId of listSessionIds()) {
    if (!boundSessionIds.has(sessionId)) {
      deleteBySessionId(sessionId);
    }
  }
}

async function handleInteraction(deps: DiscordControlBotDeps, value: unknown): Promise<void> {
  if (!isChatInputInteraction(value) && !isButtonInteraction(value)) {
    return;
  }

  if (isChatInputInteraction(value) && value.commandName === 'session-new') {
    deps.logger?.info?.(
      `Handling /session-new for user ${value.user.id} in channel ${String(value.channelId)}.`
    );
    const sourceChannel = (await deps.discord.getChannel?.(value.channelId)) ?? getOptionalInteractionChannel(value);
    const displayName = resolveSessionDisplayName({
      rawName: value.options.getString('name'),
      random: deps.random
    });
    const prepared = deps.handlers.prepareCreateSession({
      cwd: value.options.getString('cwd') ?? process.cwd(),
      model: value.options.getString('model') ?? 'sonnet',
      displayName,
      effort: parseEffortOption(value.options.getString('effort')),
      skills: parseSkillsOption(value.options.getString('skills')),
      userId: value.user.id,
      roleIds: getRoleIds(value.member)
    });
    deps.logger?.info?.(
      `Resolved source channel for /session-new: ${sourceChannel ? 'present' : 'missing'}.`
    );
    const thread = await ensureThreadChannel(sourceChannel, displayName);
    deps.logger?.info?.(`Created or reused thread ${thread.id} for /session-new.`);
    const session = await deps.handlers.handleCreateSession({
      channelId: thread.id,
      cwd: prepared.cwd,
      model: prepared.model,
      displayName: prepared.displayName,
      effort: prepared.effort,
      skills: prepared.skills,
      userId: prepared.userId,
      roleIds: prepared.roleIds
    });
    const bindingTimestamp = deps.now?.() ?? new Date().toISOString();
    deps.bindings.upsert?.({
      threadId: thread.id,
      sessionId: session.sessionId,
      createdAt: bindingTimestamp,
      updatedAt: bindingTimestamp
    });

    await sendChannelMessage(
      thread as ThreadMessageChannel,
      buildSessionSummaryMessage({
        sessionId: session.sessionId,
        displayName: prepared.displayName,
        cwd: prepared.cwd,
        model: prepared.model,
        effort: prepared.effort,
        skills: prepared.skills
      })
    );

    await value.reply({
      content: `Session ${session.sessionId} created in thread ${thread.id}.`,
      ephemeral: true
    });
    return;
  }

  if (isButtonInteraction(value)) {
    const bashDetail = parseBashDetailButtonId(value.customId);
    if (bashDetail) {
      const detail = await loadBashDetail(deps.runnerClient, bashDetail.sessionId, bashDetail.toolUseId);
      if (!detail) {
        await acknowledgeButton(value, 'Bash output is no longer available.');
        return;
      }

      await updateButtonMessage(
        value,
        bashDetail.mode === 'view'
          ? buildExpandedBashDetailMessage(bashDetail.sessionId, detail)
          : buildToolCompletedMessage(bashDetail.sessionId, detail)
      );
      return;
    }

    const parsed = parsePromptButtonId(value.customId);
    if (!parsed) {
      return;
    }

    await deps.handlers.handleResolvePrompt({
      promptId: parsed.promptId,
      resolution: parsed.resolution,
      userId: value.user.id,
      sessionId: parsed.sessionId,
      roleIds: getRoleIds(value.member)
    });

    await clearButtonMessage(value);
  }
}

async function handleMessage(
  deps: DiscordControlBotDeps,
  value: unknown,
  models: Map<string, SessionRenderModel>,
  subscriptions: Map<string, AbortController>,
  waitingPlaceholders: Map<string, string>,
  now: () => string
): Promise<void> {
  if (!isUserThreadMessage(value)) {
    return;
  }

  const binding = deps.bindings.getByThreadId(value.channelId);
  if (!binding) {
    return;
  }

  const channel = await resolveMessageThreadChannel(deps, value.channelId, value.channel);

  let model = await syncSessionModel(deps, binding.sessionId, models);

  const pendingPrompt = await deps.runnerClient.getPendingPrompt({ sessionId: binding.sessionId });
  if (pendingPrompt?.kind === 'question') {
    await deps.handlers.handleAnswerQuestion({
      promptId: pendingPrompt.promptId,
      answer: value.content,
      userId: value.author.id,
      sessionId: binding.sessionId,
      roleIds: getRoleIds(value.member)
    });
    models.delete(binding.sessionId);
    await sendChannelMessage(channel, `Answered question for session ${binding.sessionId}.`);
    return;
  }

  if (pendingPrompt?.kind === 'permission') {
    model = await sendRenderedMessages(channel, model, getWaitingPlaceholder(waitingPlaceholders, binding.sessionId, model));
    commitModel(deps, models, model, now);
    await sendPermissionPromptMessage(channel, binding.sessionId, pendingPrompt);
    return;
  }

  const session = await deps.runnerClient.getSession({ sessionId: binding.sessionId });
  if (session.state === 'running' && model.anchor.rootMessageId !== null) {
    await sendChannelMessage(channel, 'Assistant is still responding. Please wait.');
    return;
  }

  resetWaitingPlaceholder(waitingPlaceholders, binding.sessionId);
  model = startNewTurn(model, value.channelId);
  model = await sendRenderedMessages(channel, model, getWaitingPlaceholder(waitingPlaceholders, binding.sessionId, model));
  commitModel(deps, models, model, now);

  await ensureSessionStreaming(deps, binding.sessionId, channel, models, subscriptions, waitingPlaceholders, now);

  await deps.runnerClient.sendTurn({
    sessionId: binding.sessionId,
    prompt: value.content
  });

  const previousModel = model;
  model = await syncSessionModel(deps, binding.sessionId, models, model);
  if (model.text.trim().length > 0) {
    stopWaitingPlaceholder(waitingPlaceholders, binding.sessionId);
  }
  model = await sendRenderedMessages(channel, model, getWaitingPlaceholder(waitingPlaceholders, binding.sessionId, model));
  commitModel(deps, models, model, now);
  await sendNewToolCompletionCards(deps, channel, binding.sessionId, previousModel.lastConsumedEventSeq, model.lastConsumedEventSeq);

  const nextPrompt = await deps.runnerClient.getPendingPrompt({ sessionId: binding.sessionId });
  if (nextPrompt?.kind === 'permission') {
    await sendPermissionPromptMessage(channel, binding.sessionId, nextPrompt);
    return;
  }
}

async function recoverExistingSessions(
  deps: DiscordControlBotDeps,
  models: Map<string, SessionRenderModel>,
  subscriptions: Map<string, AbortController>,
  waitingPlaceholders: Map<string, string>,
  now: () => string
): Promise<void> {
  const bindings = deps.bindings.listAll?.();
  const sessions = deps.sessions?.listActive?.();

  if (!bindings || !sessions) {
    return;
  }

  const recovered = await recoverStartupState({
    bindings,
    sessions,
    rootAnchors: loadRootAnchors(deps, sessions),
    runnerClient: deps.runnerClient
  });

  for (const session of recovered.recoveredSessions) {
    models.set(session.sessionId, session.model);

    if (!session.threadId || !deps.discord.getThreadChannel) {
      continue;
    }

    let channel: ThreadMessageChannel | null = null;
    try {
      channel = await deps.discord.getThreadChannel(session.threadId);
    } catch (error) {
      deps.logger?.error?.(formatError(error));
      deps.bindings.deleteByThreadId?.(session.threadId);
      continue;
    }

    if (!channel) {
      deps.bindings.deleteByThreadId?.(session.threadId);
      continue;
    }

    resetWaitingPlaceholder(waitingPlaceholders, session.sessionId);
    await ensureSessionStreaming(deps, session.sessionId, channel, models, subscriptions, waitingPlaceholders, now);
  }
}

async function syncSessionModel(
  deps: DiscordControlBotDeps,
  sessionId: string,
  models: Map<string, SessionRenderModel>,
  initialModel?: SessionRenderModel
): Promise<SessionRenderModel> {
  const model = initialModel ?? models.get(sessionId) ?? createRenderModel({ sessionId });
  const replayed = await replaySessionEvents({
    sessionId,
    model,
    runnerClient: deps.runnerClient
  });
  models.set(sessionId, replayed.model);
  return replayed.model;
}

async function ensureSessionStreaming(
  deps: DiscordControlBotDeps,
  sessionId: string,
  channel: ThreadMessageChannel,
  models: Map<string, SessionRenderModel>,
  subscriptions: Map<string, AbortController>,
  waitingPlaceholders: Map<string, string>,
  now: () => string
): Promise<void> {
  if (subscriptions.has(sessionId)) {
    return;
  }

  const controller = new AbortController();
  subscriptions.set(sessionId, controller);

  try {
    const deliveryState = deps.deliveryState?.getBySessionId(sessionId) ?? null;
    let model = loadPersistedRenderModel(models.get(sessionId) ?? createRenderModel({ sessionId }), deliveryState);
    const replayed = await replaySessionEvents({
      sessionId,
      model,
      runnerClient: deps.runnerClient,
      reconstructActiveTurn: deliveryState?.rootMessageId !== null
    });
    model = replayed.model;
    commitModel(deps, models, model, now);

    if (replayed.replayedCount > 0) {
      const previousSeq = deliveryState ? Number(deliveryState.cursor ?? '0') : 0;
      model = await sendRenderedMessages(channel, model, getWaitingPlaceholder(waitingPlaceholders, sessionId, model));
      commitModel(deps, models, model, now);
      await sendNewToolCompletionCards(deps, channel, sessionId, previousSeq, model.lastConsumedEventSeq);
    }

    const replayPrompt = await deps.runnerClient.getPendingPrompt({ sessionId });
    if (replayPrompt?.kind === 'permission') {
      await sendPermissionPromptMessage(channel, sessionId, replayPrompt);
    }
    void continueSessionStreaming({
      deps,
      sessionId,
      channel,
      models,
      waitingPlaceholders,
      now,
      controller,
      subscriptions,
      model,
      deliveryState
    });
  } catch (error) {
    subscriptions.delete(sessionId);
    throw error;
  }
}

async function continueSessionStreaming(input: {
  deps: DiscordControlBotDeps;
  sessionId: string;
  channel: ThreadMessageChannel;
  models: Map<string, SessionRenderModel>;
  waitingPlaceholders: Map<string, string>;
  now: () => string;
  controller: AbortController;
  subscriptions: Map<string, AbortController>;
  model: SessionRenderModel;
  deliveryState:
    | {
        sessionId: string;
        cursor: string;
        rootMessageId: string | null;
        updatedAt: string;
      }
    | null;
}): Promise<void> {
  let model = input.model;

  try {
    for await (const envelope of input.deps.runnerClient.subscribeEvents({
      sessionId: input.sessionId,
      fromSeq: getSubscriptionStartSeq(model, input.deliveryState),
      abortSignal: input.controller.signal
    })) {
      const currentModel = input.models.get(input.sessionId) ?? model;
      model = applyRunnerEvent(currentModel, envelope);
      if (envelope.event.type === 'text.delta' || envelope.event.type === 'turn.completed') {
        stopWaitingPlaceholder(input.waitingPlaceholders, input.sessionId);
      }
      model = await sendRenderedMessages(
        input.channel,
        model,
        getWaitingPlaceholder(input.waitingPlaceholders, input.sessionId, model)
      );
      commitModel(input.deps, input.models, model, input.now);
      const deliveredToolCallId = await sendToolCompletionCard(
        input.deps,
        input.channel,
        input.sessionId,
        envelope
      );
      if (deliveredToolCallId) {
        markToolCardDelivered(input.deps, input.sessionId, deliveredToolCallId);
      }

      if (envelope.event.type === 'permission.requested') {
        const pendingPrompt = await input.deps.runnerClient.getPendingPrompt({ sessionId: input.sessionId });
        if (pendingPrompt?.kind === 'permission') {
          await sendPermissionPromptMessage(input.channel, input.sessionId, pendingPrompt);
        }
      }
    }
  } catch (error) {
    input.deps.logger?.error?.(formatError(error));
  } finally {
    input.subscriptions.delete(input.sessionId);
    stopWaitingPlaceholder(input.waitingPlaceholders, input.sessionId);
  }
}

async function resolveMessageThreadChannel(
  deps: DiscordControlBotDeps,
  threadId: string,
  rawChannel: ThreadMessageChannel
): Promise<ThreadMessageChannel> {
  if (deps.discord.getThreadChannel) {
    try {
      const wrapped = await deps.discord.getThreadChannel(threadId);
      if (wrapped) {
        return wrapped;
      }
    } catch (error) {
      deps.logger?.error?.(formatError(error));
    }
  }

  return rawChannel;
}

async function sendPermissionPromptMessage(
  channel: { send: (input: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }) => Promise<unknown> },
  sessionId: string,
  pendingPrompt: { promptId: string; text: string }
): Promise<void> {
  await sendChannelMessage(channel, buildPromptMessage(sessionId, pendingPrompt.promptId, pendingPrompt.text));
}

async function sendNewToolCompletionCards(
  deps: DiscordControlBotDeps,
  channel: { send: (input: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }) => Promise<unknown> },
  sessionId: string,
  previousSeq: number,
  nextSeq: number
): Promise<void> {
  if (nextSeq <= previousSeq) {
    return;
  }

  const events = await deps.runnerClient.listEvents({ sessionId, fromSeq: previousSeq + 1 });
  const deliveredToolCallIds: string[] = [];

  for (const envelope of events) {
    if (envelope.seq > nextSeq) {
      break;
    }

    const deliveredToolCallId = await sendToolCompletionCard(deps, channel, sessionId, envelope);
    if (deliveredToolCallId) {
      deliveredToolCallIds.push(deliveredToolCallId);
    }
  }

  if (deliveredToolCallIds.length > 0) {
    markToolCardsDelivered(deps, sessionId, deliveredToolCallIds);
  }
}

async function sendToolCompletionCard(
  deps: DiscordControlBotDeps,
  channel: { send: (input: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }) => Promise<unknown> },
  sessionId: string,
  envelope: RunnerEventEnvelope
): Promise<string | null> {
  if (envelope.event.type !== 'tool.completed') {
    return null;
  }

  if (hasDeliveredToolCard(deps, sessionId, envelope.event.toolUseId)) {
    return null;
  }

  await sendChannelMessage(channel, buildToolCompletedMessage(sessionId, envelope.event));
  return envelope.event.toolUseId;
}

function loadPersistedRenderModel(
  model: SessionRenderModel,
  deliveryState:
    | {
        sessionId: string;
        cursor: string;
        rootMessageId: string | null;
        updatedAt: string;
      }
    | null
): SessionRenderModel {
  if (!deliveryState) {
    return model;
  }

  if (deliveryState.rootMessageId) {
    return {
      ...model,
      anchor: { rootMessageId: deliveryState.rootMessageId }
    };
  }

  const parsedCursor = Number(deliveryState.cursor ?? '0');
  if (Number.isNaN(parsedCursor) || parsedCursor <= model.lastConsumedEventSeq) {
    return model;
  }

  return {
    ...model,
    lastConsumedEventSeq: parsedCursor
  };
}

function commitModel(
  deps: DiscordControlBotDeps,
  models: Map<string, SessionRenderModel>,
  model: SessionRenderModel,
  now: () => string
): void {
  models.set(model.sessionId, model);
  persistDeliveryState(deps, model, now);
}

function persistDeliveryState(
  deps: DiscordControlBotDeps,
  model: SessionRenderModel,
  now: () => string
): void {
  if (!deps.deliveryState) {
    return;
  }

  const existing = deps.deliveryState.getBySessionId(model.sessionId);
  const cursor = String(model.lastConsumedEventSeq);
  const rootMessageId = model.anchor.rootMessageId;
  const existingDeliveredToolCallIds = existing?.deliveredToolCallIds ?? [];
  const deliveredToolCallIds = rootMessageId === null ? [] : [...existingDeliveredToolCallIds];

  if (model.lastConsumedEventSeq <= 0 && rootMessageId === null && deliveredToolCallIds.length === 0) {
    return;
  }

  if (
    existing?.cursor === cursor &&
    existing.rootMessageId === rootMessageId &&
    areToolCallIdsEqual(existingDeliveredToolCallIds, deliveredToolCallIds)
  ) {
    return;
  }

  deps.deliveryState.save({
    sessionId: model.sessionId,
    cursor,
    rootMessageId,
    deliveredToolCallIds,
    updatedAt: now()
  });
}

function hasDeliveredToolCard(
  deps: DiscordControlBotDeps,
  sessionId: string,
  toolUseId: string
): boolean {
  return deps.deliveryState?.getBySessionId(sessionId)?.deliveredToolCallIds?.includes(toolUseId) ?? false;
}

function markToolCardDelivered(
  deps: DiscordControlBotDeps,
  sessionId: string,
  toolUseId: string
): void {
  if (!deps.deliveryState) {
    return;
  }

  const existing = deps.deliveryState.getBySessionId(sessionId);
  const deliveredToolCallIds = existing?.deliveredToolCallIds ?? [];
  if (!existing || deliveredToolCallIds.includes(toolUseId)) {
    return;
  }

  deps.deliveryState.save({
    ...existing,
    deliveredToolCallIds: [...deliveredToolCallIds, toolUseId],
    updatedAt: deps.now?.() ?? new Date().toISOString()
  });
}

function markToolCardsDelivered(
  deps: DiscordControlBotDeps,
  sessionId: string,
  toolUseIds: readonly string[]
): void {
  for (const toolUseId of toolUseIds) {
    markToolCardDelivered(deps, sessionId, toolUseId);
  }
}

function areToolCallIdsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function loadRootAnchors(
  deps: DiscordControlBotDeps,
  sessions: readonly SessionRecord[]
): Record<string, string> {
  const anchors: Record<string, string> = {};

  for (const session of sessions) {
    const rootMessageId = deps.deliveryState?.getBySessionId(session.id)?.rootMessageId;
    if (rootMessageId) {
      anchors[session.id] = rootMessageId;
    }
  }

  return anchors;
}

function getSubscriptionStartSeq(
  model: SessionRenderModel,
  deliveryState:
    | {
        sessionId: string;
        cursor: string;
        rootMessageId: string | null;
        updatedAt: string;
      }
    | null
): number {
  const persistedCursor = Number(deliveryState?.cursor ?? '0');
  const lastConsumedEventSeq = Math.max(
    model.lastConsumedEventSeq,
    Number.isNaN(persistedCursor) ? 0 : persistedCursor
  );
  return lastConsumedEventSeq + 1;
}

function buildPromptMessage(sessionId: string, promptId: string, text: string) {
  return {
    content: '',
    embeds: [
      {
        color: SYSTEM_EMBED_COLOR,
        description: `Approval needed for session ${sessionId}: ${text}`
      }
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildPromptButtonId('allow_once', promptId, sessionId))
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildPromptButtonId('deny_once', promptId, sessionId))
          .setLabel('Deny')
          .setStyle(ButtonStyle.Danger)
      )
    ]
  };
}

function buildToolCompletedMessage(
  sessionId: string,
  detail: ToolCompletionSummary
) {
  const isBash = detail.toolName === 'Bash';
  return {
    content: '',
    embeds: [
      {
        color: SYSTEM_EMBED_COLOR,
        description: summarizeToolCompletion(detail)
      }
    ],
    components: isBash
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildBashDetailButtonId(sessionId, detail.toolUseId))
              .setLabel('View Bash Output')
              .setStyle(ButtonStyle.Secondary)
          )
        ]
      : []
  };
}

type ToolCompletionSummary = Readonly<{
  toolUseId: string;
  toolName: string;
  command?: string;
  description?: string;
}>;

function summarizeToolCompletion(detail: Pick<ToolCompletionSummary, 'toolName' | 'command' | 'description'>): string {
  const description = detail.description?.trim();
  if (description) {
    return `${detail.toolName} - ${description}`;
  }

  const command = detail.command?.trim();
  if (command) {
    return `${detail.toolName} - \`${command}\``;
  }

  return `${detail.toolName} - ${detail.toolName}`;
}

function buildSessionSummaryMessage(input: {
  sessionId: string;
  displayName: string;
  cwd: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  skills: readonly string[];
}) {
  const lines = [
    `Session ${input.sessionId}`,
    `name: ${input.displayName}`,
    `cwd: ${input.cwd}`,
    `model: ${input.model}`,
    `effort: ${input.effort ?? 'default'}`,
    `skills: ${input.skills.length > 0 ? input.skills.join(', ') : 'none'}`
  ];

  return {
    content: '',
    embeds: [
      {
        color: SYSTEM_EMBED_COLOR,
        description: lines.join('\n')
      }
    ]
  };
}

export function buildPromptButtonId(
  resolution: 'allow_once' | 'deny_once',
  promptId: string,
  sessionId: string
): string {
  return `prompt:${resolution}:${promptId}:${sessionId}`;
}

export function buildBashDetailButtonId(sessionId: string, toolUseId: string, mode: 'view' | 'hide' = 'view'): string {
  return `bash:${mode}:${sessionId}:${toolUseId}`;
}

function parsePromptButtonId(customId: string): {
  resolution: 'allow_once' | 'deny_once';
  promptId: string;
  sessionId: string;
} | null {
  const match = customId.match(/^prompt:(allow_once|deny_once):([^:]+):(.+)$/);
  if (!match) {
    return null;
  }

  return {
    resolution: match[1] as 'allow_once' | 'deny_once',
    promptId: match[2],
    sessionId: match[3]
  };
}

function parseBashDetailButtonId(customId: string): {
  mode: 'view' | 'hide';
  sessionId: string;
  toolUseId: string;
} | null {
  const match = customId.match(/^bash:(view|hide):([^:]+):(.+)$/);
  if (!match) {
    return null;
  }

  return {
    mode: match[1] as 'view' | 'hide',
    sessionId: match[2],
    toolUseId: match[3]
  };
}

async function loadBashDetail(
  runnerClient: DiscordControlBotDeps['runnerClient'],
  sessionId: string,
  toolUseId: string
): Promise<BashDetailModel | null> {
  const events = await runnerClient.listEvents({ sessionId, fromSeq: 1 });

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === 'tool.completed' && event.toolUseId === toolUseId && event.toolName === 'Bash') {
      return {
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        command: event.command,
        description: event.description,
        output: event.output,
        stdout: event.stdout,
        stderr: event.stderr,
        isError: event.isError
      };
    }
  }

  return null;
}

function formatBashDetailMessage(detail: BashDetailModel): string {
  const label = detail.command ? `\`${detail.command}\`` : 'Bash';
  const output = detail.output || 'No output';
  return `Bash output for ${label}\n\`\`\`text\n${truncateForCodeBlock(output)}\n\`\`\``;
}

function buildExpandedBashDetailMessage(sessionId: string, detail: BashDetailModel) {
  return {
    content: '',
    embeds: [
      {
        color: SYSTEM_EMBED_COLOR,
        description: formatBashDetailMessage(detail)
      }
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildBashDetailButtonId(sessionId, detail.toolUseId, 'hide'))
          .setLabel('Hide Bash Output')
          .setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function truncateForCodeBlock(text: string, maxLength = 1500): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...`;
}

async function ensureThreadChannel(channel: unknown, threadName: string): Promise<CreatedThreadChannel> {
  if (isThreadChannel(channel)) {
    return channel;
  }

  const maybeChannel = channel as {
    threads?: {
      create?: (input: { name: string }) => Promise<CreatedThreadChannel>;
    };
  };

  if (!maybeChannel.threads?.create) {
    throw new Error('Discord channel cannot create threads');
  }

  return maybeChannel.threads.create({ name: threadName });
}

function getRoleIds(member: unknown): string[] {
  const cache = (member as { roles?: { cache?: Map<string, { id: string }> | { values(): Iterable<{ id: string }> } } })?.roles?.cache;
  if (!cache) {
    return [];
  }

  if (cache instanceof Map) {
    return Array.from(cache.values()).map((role) => role.id);
  }

  return Array.from(cache.values()).map((role) => role.id);
}

async function acknowledgeButton(
  interaction: {
    reply?: (input: { content?: string; embeds?: unknown[]; ephemeral: boolean }) => Promise<void>;
    update?: (input: { content?: string; embeds?: unknown[]; components?: unknown[] }) => Promise<void>;
  },
  content: string
): Promise<void> {
  if (interaction.update) {
      await interaction.update(normalizeDiscordObjectMessage({ content: '', embeds: [buildSystemEmbed(content)], components: [] }));
      return;
  }

  if (interaction.reply) {
    await interaction.reply({
      ...normalizeDiscordObjectMessage({ content: '', embeds: [buildSystemEmbed(content)] }),
      ephemeral: true
    });
  }
}

async function updateButtonMessage(
  interaction: {
    reply?: (input: { content?: string; embeds?: unknown[]; ephemeral: boolean }) => Promise<void>;
    update?: (input: { content?: string; embeds?: unknown[]; components?: unknown[] }) => Promise<void>;
    deferUpdate?: () => Promise<void>;
    message?: { delete?: () => Promise<void> };
  },
  input: { content?: string; embeds?: unknown[]; components?: unknown[] }
): Promise<void> {
  if (interaction.update) {
    await interaction.update(normalizeDiscordObjectMessage(input));
    return;
  }

  if (interaction.reply) {
    await interaction.reply({
      ...normalizeDiscordObjectMessage(input),
      ephemeral: true
    });
  }
}

async function clearButtonMessage(
  interaction: {
    reply?: (input: { content?: string; embeds?: unknown[]; ephemeral: boolean }) => Promise<void>;
    update?: (input: { content?: string; embeds?: unknown[]; components?: unknown[] }) => Promise<void>;
    deferUpdate?: () => Promise<void>;
    message?: { delete?: () => Promise<void> };
  }
): Promise<void> {
  if (interaction.deferUpdate && interaction.message?.delete) {
    await interaction.deferUpdate();
    await interaction.message.delete();
    return;
  }

  if (interaction.update) {
    await interaction.update({ embeds: [], components: [] });
    return;
  }

  if (interaction.reply) {
    await interaction.reply({ content: 'Handled.', ephemeral: true });
  }
}

async function sendChannelMessage(
  channel: { send: (input: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }) => Promise<unknown> },
  input: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }
): Promise<void> {
  await channel.send(typeof input === 'string' ? input : normalizeDiscordObjectMessage(input));
}

function normalizeDiscordObjectMessage(input: {
  content?: string;
  components?: unknown[];
  embeds?: unknown[];
  flags?: number;
}): { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number } {
  const next = { ...input };

  if (next.content === '') {
    delete next.content;
  }

  if (Array.isArray(next.embeds) && next.embeds.length === 0) {
    delete next.embeds;
  }

  if (next.embeds === undefined) {
    delete next.embeds;
  }

  if (next.components === undefined) {
    delete next.components;
  }

  if (next.flags === undefined) {
    delete next.flags;
  }

  return next;
}

function buildSystemEmbed(description: string) {
  return {
    color: SYSTEM_EMBED_COLOR,
    description
  };
}

function parseEffortOption(value: string | null): 'low' | 'medium' | 'high' | 'max' | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'max') {
    return normalized;
  }

  return undefined;
}

function parseSkillsOption(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function sendRenderedMessages(
  channel: { send: (input: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }) => Promise<unknown> },
  model: SessionRenderModel,
  waitingPlaceholder?: string
): Promise<SessionRenderModel> {
  const renderedMessages = renderSessionMessage(model, { waitingPlaceholder });
  let nextModel = model;

  for (const [index, rendered] of renderedMessages.entries()) {
    const renderedInput = {
      content: rendered.content,
      embeds: rendered.embeds.length > 0 ? [...rendered.embeds] : undefined,
      components: rendered.components ? [...rendered.components] : undefined,
      flags: rendered.flags
    };

    if (index === 0) {
      nextModel = await upsertRootMessage(channel as ThreadMessageChannel, nextModel, renderedInput);
      continue;
    }

    await sendChannelMessage(channel, renderedInput);
  }

  return nextModel;
}

function getWaitingPlaceholder(
  waitingPlaceholders: Map<string, string>,
  sessionId: string,
  model: SessionRenderModel
): string | undefined {
  if (model.text.trim().length > 0) {
    return undefined;
  }

  return waitingPlaceholders.get(sessionId);
}

function resetWaitingPlaceholder(
  waitingPlaceholders: Map<string, string>,
  sessionId: string
): void {
  waitingPlaceholders.set(
    sessionId,
    WAITING_PLACEHOLDERS[Math.floor(Math.random() * WAITING_PLACEHOLDERS.length)]
  );
}

function stopWaitingPlaceholder(
  waitingPlaceholders: Map<string, string>,
  sessionId: string
): void {
  waitingPlaceholders.delete(sessionId);
}

function clearAllWaitingPlaceholders(waitingPlaceholders: Map<string, string>): void {
  waitingPlaceholders.clear();
}

async function upsertRootMessage(
  channel: ThreadMessageChannel,
  model: SessionRenderModel,
  input: { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number }
): Promise<SessionRenderModel> {
  const rootMessageId = model.anchor.rootMessageId;
  const normalizedInput = normalizeDiscordObjectMessage(input);

  if (rootMessageId && channel.edit) {
    const { flags, ...editInput } = normalizedInput;

    try {
      await channel.edit(rootMessageId, flags === MessageFlags.IsComponentsV2 ? editInput : normalizedInput);
      return model;
    } catch (error) {
      if (flags !== MessageFlags.IsComponentsV2) {
        throw error;
      }
    }
  }

  const sent = await channel.send(normalizedInput);
  const sentMessageId = getSentMessageId(sent);
  if (!sentMessageId) {
    return model;
  }

  return {
    ...model,
    anchor: { rootMessageId: sentMessageId }
  };
}

function getSentMessageId(value: unknown): string | null {
  if (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof (value as { id: unknown }).id === 'string'
  ) {
    return (value as { id: string }).id;
  }

  return null;
}

function isThreadChannel(value: unknown): value is CreatedThreadChannel {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'isThread' in value &&
    typeof (value as { isThread: unknown }).isThread === 'function' &&
    (value as { isThread: () => boolean }).isThread()
  );
}

function isChatInputInteraction(value: unknown): value is {
  isChatInputCommand: () => boolean;
  commandName: string;
  channel: unknown;
  channelId: string;
  user: { id: string };
  member: unknown;
  options: { getString(name: string): string | null };
  reply(input: { content: string; ephemeral: boolean }): Promise<void>;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isChatInputCommand' in value &&
    typeof (value as { isChatInputCommand: unknown }).isChatInputCommand === 'function' &&
    (value as { isChatInputCommand: () => boolean }).isChatInputCommand()
  );
}

async function replyWithInteractionError(value: unknown, error: unknown): Promise<void> {
  if (!isChatInputInteraction(value)) {
    return;
  }

  try {
    await value.reply({
      content: formatErrorForUser(error),
      ephemeral: true
    });
  } catch {
    // Ignore secondary reply errors; the original error is already logged.
  }
}

function formatErrorForUser(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'The request failed.';
}

function getOptionalInteractionChannel(value: { channel?: unknown }): unknown {
  try {
    return value.channel;
  } catch {
    return null;
  }
}

function isButtonInteraction(value: unknown): value is {
  isButton: () => boolean;
  customId: string;
  user: { id: string };
  member: unknown;
  reply?: (input: { content?: string; ephemeral: boolean }) => Promise<void>;
  update?: (input: { content?: string; embeds?: unknown[]; components?: unknown[] }) => Promise<void>;
  deferUpdate?: () => Promise<void>;
  message?: { delete?: () => Promise<void> };
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isButton' in value &&
    typeof (value as { isButton: unknown }).isButton === 'function' &&
    (value as { isButton: () => boolean }).isButton()
  );
}

function isUserThreadMessage(value: unknown): value is {
  author: { bot: boolean; id: string };
  content: string;
  channelId: string;
  channel: { isThread: () => boolean; send: (input: string | { content?: string; components?: unknown[]; embeds?: unknown[]; flags?: number }) => Promise<unknown> };
  member: unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'author' in value &&
    'channel' in value &&
    'channelId' in value &&
    'content' in value &&
    !(value as { author: { bot: boolean } }).author.bot &&
    typeof (value as { channel: { isThread: () => boolean } }).channel.isThread === 'function' &&
    (value as { channel: { isThread: () => boolean } }).channel.isThread()
  );
}

export function listDiscordCommandDefinitions(): readonly DiscordCommandDefinition[] {
  return COMMANDS;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}
