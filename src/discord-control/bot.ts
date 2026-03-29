import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { createCommandHandlers } from './command-handlers.js';
import type { RunnerControlClient } from './runner-client.js';
import type { BindingRecord, SessionRecord } from '../shared/db/repositories.js';
import type { RunnerWorkdirScanCandidate, RunnerWorkdirView } from '../shared/contracts/runner-api.js';
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

type SessionNewWizardBootstrap = Readonly<{
  instanceId: string;
  initiatorId: string;
  sourceChannelId: string;
  displayName: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  skills: readonly string[];
}>;

type SessionNewWizardAction = 'history' | 'search' | 'manual';

type SessionNewWizardConfigAction = 'model' | 'effort' | 'skills' | 'create' | 'back';

type SessionModelOption = 'haiku' | 'sonnet' | 'opus';

type SessionNewWizardState = SessionNewWizardBootstrap & Readonly<{
  activeAction?: SessionNewWizardAction;
  activeConfigAction?: Exclude<SessionNewWizardConfigAction, 'create'>;
  historyItems?: readonly RunnerWorkdirView[];
  historyPage?: number;
  scanItems?: readonly RunnerWorkdirScanCandidate[];
  scanOffset?: number;
  scanNextOffset?: number | null;
  selectedPath?: Readonly<{
    path: string;
    source: SessionNewWizardAction;
  }>;
  selectedWorkdirDisplayName?: string;
  expiresAt: string;
}>; 

type SessionNewWizardLookup =
  | Readonly<{ status: 'active'; state: SessionNewWizardState }>
  | Readonly<{ status: 'forbidden'; state: SessionNewWizardState }>
  | Readonly<{ status: 'expired' | 'missing' }>;

const SESSION_NEW_WIZARD_TTL_MS = 10 * 60 * 1000;
const HISTORY_PAGE_SIZE = 25;
const SCAN_PAGE_SIZE = 25;
const SESSION_MODEL_OPTIONS: readonly SessionModelOption[] = ['haiku', 'sonnet', 'opus'];
const SESSION_EFFORT_OPTIONS = ['default', 'low', 'medium', 'high', 'max'] as const;

export type DiscordControlBot = Readonly<{
  start: () => Promise<void>;
  stop: () => Promise<void>;
}>;

export type DiscordControlBotDeps = Readonly<{
  token: string;
  clientId?: string;
  handlers: ReturnType<typeof createCommandHandlers>;
  runnerClient: Pick<RunnerControlClient, 'getPendingPrompt' | 'getSession' | 'health' | 'listEvents' | 'scanWorkdirs' | 'sendTurn' | 'subscribeEvents'> & (
    Readonly<{
      listWorkdirs: NonNullable<RunnerControlClient['listWorkdirs']>;
      saveWorkdir: NonNullable<RunnerControlClient['saveWorkdir']>;
    }>
    | Readonly<{
      listWorkdirs?: undefined;
      saveWorkdir?: undefined;
    }>
  );
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
      { type: 'string', name: 'cwd', description: 'Working directory', required: false },
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
  const sessionNewWizards = new Map<string, SessionNewWizardState>();
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
          await handleInteraction(
            deps,
            value,
            sessionNewWizards,
            now,
            () => randomUUID()
          );
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

async function handleInteraction(
  deps: DiscordControlBotDeps,
  value: unknown,
  sessionNewWizards: Map<string, SessionNewWizardState>,
  now: () => string,
  createSessionNewWizardId: () => string
): Promise<void> {
  if (!isChatInputInteraction(value) && !isButtonInteraction(value) && !isStringSelectInteraction(value) && !isModalSubmitInteraction(value)) {
    return;
  }

  if (isButtonInteraction(value) || isStringSelectInteraction(value) || isModalSubmitInteraction(value)) {
    pruneExpiredSessionNewWizards(sessionNewWizards, now);
  }

  if (isChatInputInteraction(value) && value.commandName === 'session-new') {
    const cwd = value.options.getString('cwd');
    const displayName = resolveSessionDisplayName({
      rawName: value.options.getString('name'),
      random: deps.random,
    });
    const model = value.options.getString('model') ?? 'sonnet';
    const effort = parseEffortOption(value.options.getString('effort'));
    const skills = parseSkillsOption(value.options.getString('skills'));

    if (!cwd) {
      const session = await deps.handlers.handleCreateSession({
        channelId: value.channelId,
        model,
        displayName,
        effort,
        skills,
        userId: value.user.id,
        roleIds: getRoleIds(value.member),
      });

      if (isRequiresWorkdirResult(session)) {
        pruneExpiredSessionNewWizards(sessionNewWizards, now);
        const instanceId = createSessionNewWizardId();
        sessionNewWizards.set(instanceId, {
          instanceId,
          initiatorId: value.user.id,
          sourceChannelId: value.channelId,
          displayName,
          model,
          effort,
          skills,
          expiresAt: computeWizardExpiration(now()),
        });
        await value.reply({
          ...buildSessionNewWizardMessage(instanceId, value.user.id, value.channelId),
          ephemeral: true,
        });
        return;
      }

      throw new Error('Session creation requires a working directory selection.');
    }

    deps.logger?.info?.(
      `Handling /session-new for user ${value.user.id} in channel ${String(value.channelId)}.`
    );
    const sourceChannel = (await deps.discord.getChannel?.(value.channelId)) ?? getOptionalInteractionChannel(value);
    const prepared = deps.handlers.prepareCreateSession({
      channelId: value.channelId,
      cwd,
      model,
      displayName,
      effort,
      skills,
      userId: value.user.id,
      roleIds: getRoleIds(value.member),
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
        displayName: prepared.displayName ?? displayName,
        cwd: prepared.cwd,
        model: prepared.model,
        effort: prepared.effort,
        skills: prepared.skills,
      })
    );

    await value.reply({
      content: `Session ${session.sessionId} created in thread ${thread.id}.`,
      ephemeral: true
    });
    return;
  }

  if (isButtonInteraction(value)) {
    const sessionNewWizard = parseSessionNewWizardButtonId(value.customId);
    if (sessionNewWizard) {
      const lookup = lookupSessionNewWizardState(sessionNewWizards, sessionNewWizard.instanceId, value.user.id, now);
      if (lookup.status === 'forbidden') {
        await replyWithEphemeralWizardMessage(value, buildSessionNewWizardForbiddenMessage());
        return;
      }

      if (lookup.status !== 'active' || lookup.state.activeAction || lookup.state.sourceChannelId !== sessionNewWizard.channelId) {
        await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
        return;
      }

      if (sessionNewWizard.action === 'manual') {
        await showSessionNewManualModal(value, sessionNewWizard.instanceId);
        return;
      }

      if (sessionNewWizard.action === 'history') {
        const listWorkdirs = deps.runnerClient.listWorkdirs;
        if (!listWorkdirs) {
          sessionNewWizards.delete(sessionNewWizard.instanceId);
          await updateButtonMessage(value, buildSimpleWizardMessage('Saved workdir history is unavailable right now.'));
          return;
        }

        let historyItems: readonly RunnerWorkdirView[];
        try {
          historyItems = await listWorkdirs();
        } catch {
          sessionNewWizards.delete(sessionNewWizard.instanceId);
          await updateButtonMessage(value, buildSimpleWizardMessage('Saved workdir history is unavailable right now.'));
          return;
        }
        if (historyItems.length === 0) {
          sessionNewWizards.delete(sessionNewWizard.instanceId);
          await updateButtonMessage(value, buildSimpleWizardMessage('No saved workdirs are available yet.'));
          return;
        }

        const nextState = {
          ...lookup.state,
          activeAction: sessionNewWizard.action,
          historyItems,
          historyPage: 0,
          selectedPath: undefined,
          expiresAt: computeWizardExpiration(now())
        };
        sessionNewWizards.set(sessionNewWizard.instanceId, nextState);
        await updateButtonMessage(value, buildHistoryPickerMessage(sessionNewWizard.instanceId, nextState));
        return;
      }

      const scanWorkdirs = deps.runnerClient.scanWorkdirs;
      if (!scanWorkdirs) {
        sessionNewWizards.delete(sessionNewWizard.instanceId);
        await updateButtonMessage(value, buildSimpleWizardMessage('Directory search is unavailable right now.'));
        return;
      }

      let scanResult: { items: readonly RunnerWorkdirScanCandidate[]; nextOffset: number | null };
      try {
        scanResult = await scanWorkdirs({ offset: 0, limit: SCAN_PAGE_SIZE });
      } catch {
        sessionNewWizards.delete(sessionNewWizard.instanceId);
        await updateButtonMessage(value, buildSimpleWizardMessage('Directory search is unavailable right now.'));
        return;
      }

      if (scanResult.items.length === 0) {
        sessionNewWizards.delete(sessionNewWizard.instanceId);
        await updateButtonMessage(value, buildSimpleWizardMessage('No new working directories were found.'));
        return;
      }

      const nextState = {
        ...lookup.state,
        activeAction: sessionNewWizard.action,
        scanItems: scanResult.items,
        scanOffset: 0,
        scanNextOffset: scanResult.nextOffset,
        selectedPath: undefined,
        expiresAt: computeWizardExpiration(now())
      };
      sessionNewWizards.set(sessionNewWizard.instanceId, nextState);
      await updateButtonMessage(value, buildScanPickerMessage(sessionNewWizard.instanceId, nextState));
      return;
    }

    const historyPage = parseSessionNewWizardHistoryPageButtonId(value.customId);
    if (historyPage) {
      const lookup = lookupSessionNewWizardState(sessionNewWizards, historyPage.instanceId, value.user.id, now);
      if (lookup.status === 'forbidden') {
        await replyWithEphemeralWizardMessage(value, buildSessionNewWizardForbiddenMessage());
        return;
      }

      if (lookup.status !== 'active' || lookup.state.activeAction !== 'history' || !lookup.state.historyItems) {
        await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
        return;
      }

      const currentPage = lookup.state.historyPage ?? 0;
      const pageCount = Math.max(1, Math.ceil(lookup.state.historyItems.length / HISTORY_PAGE_SIZE));
      const nextPage = historyPage.direction === 'next'
        ? Math.min(pageCount - 1, currentPage + 1)
        : Math.max(0, currentPage - 1);
      const nextState = {
        ...lookup.state,
        historyPage: nextPage,
        expiresAt: computeWizardExpiration(now())
      };
      sessionNewWizards.set(historyPage.instanceId, nextState);
      await updateButtonMessage(value, buildHistoryPickerMessage(historyPage.instanceId, nextState));
      return;
    }

    const scanPage = parseSessionNewWizardScanPageButtonId(value.customId);
    if (scanPage) {
      const lookup = lookupSessionNewWizardState(sessionNewWizards, scanPage.instanceId, value.user.id, now);
      if (lookup.status === 'forbidden') {
        await replyWithEphemeralWizardMessage(value, buildSessionNewWizardForbiddenMessage());
        return;
      }

      if (lookup.status !== 'active' || lookup.state.activeAction !== 'search' || !lookup.state.scanItems) {
        await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
        return;
      }

      const scanWorkdirs = deps.runnerClient.scanWorkdirs;
      if (!scanWorkdirs) {
        sessionNewWizards.delete(scanPage.instanceId);
        await updateButtonMessage(value, buildSimpleWizardMessage('Directory search is unavailable right now.'));
        return;
      }

      const currentOffset = lookup.state.scanOffset ?? 0;
      const nextOffset = scanPage.direction === 'next'
        ? lookup.state.scanNextOffset
        : Math.max(0, currentOffset - SCAN_PAGE_SIZE);
      if (nextOffset === null || nextOffset === undefined) {
        await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
        return;
      }

      let scanResult: { items: readonly RunnerWorkdirScanCandidate[]; nextOffset: number | null };
      try {
        scanResult = await scanWorkdirs({ offset: nextOffset, limit: SCAN_PAGE_SIZE });
      } catch {
        sessionNewWizards.delete(scanPage.instanceId);
        await updateButtonMessage(value, buildSimpleWizardMessage('Directory search is unavailable right now.'));
        return;
      }

      if (scanResult.items.length === 0) {
        sessionNewWizards.delete(scanPage.instanceId);
        await updateButtonMessage(value, buildSimpleWizardMessage('No new working directories were found.'));
        return;
      }

      const nextState = {
        ...lookup.state,
        scanItems: scanResult.items,
        scanOffset: nextOffset,
        scanNextOffset: scanResult.nextOffset,
        expiresAt: computeWizardExpiration(now())
      };
      sessionNewWizards.set(scanPage.instanceId, nextState);
      await updateButtonMessage(value, buildScanPickerMessage(scanPage.instanceId, nextState));
      return;
    }

    const configButton = parseSessionNewWizardConfigButtonId(value.customId);
    if (configButton) {
      const lookup = lookupSessionNewWizardState(sessionNewWizards, configButton.instanceId, value.user.id, now);
      if (lookup.status === 'forbidden') {
        await replyWithEphemeralWizardMessage(value, buildSessionNewWizardForbiddenMessage());
        return;
      }

      if (lookup.status !== 'active') {
        await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
        return;
      }

      if (configButton.action !== 'back' && !lookup.state.selectedPath) {
        await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
        return;
      }

      const selectedPath = lookup.state.selectedPath;

      if (configButton.action === 'model') {
        const nextState: SessionNewWizardState = {
          ...lookup.state,
          activeConfigAction: 'model',
          expiresAt: computeWizardExpiration(now()),
        };
        sessionNewWizards.set(configButton.instanceId, nextState);
        await updateButtonMessage(value, buildSessionNewWizardModelMessage(configButton.instanceId, nextState));
        return;
      }

      if (configButton.action === 'effort') {
        const nextState: SessionNewWizardState = {
          ...lookup.state,
          activeConfigAction: 'effort',
          expiresAt: computeWizardExpiration(now()),
        };
        sessionNewWizards.set(configButton.instanceId, nextState);
        await updateButtonMessage(value, buildSessionNewWizardEffortMessage(configButton.instanceId, nextState));
        return;
      }

      if (configButton.action === 'skills') {
        await showSessionNewSkillsModal(value, configButton.instanceId, lookup.state.skills);
        return;
      }

      if (configButton.action === 'back') {
        const nextState: SessionNewWizardState = {
          ...lookup.state,
          activeAction: undefined,
          activeConfigAction: undefined,
          historyItems: undefined,
          historyPage: undefined,
          scanItems: undefined,
          scanOffset: undefined,
          scanNextOffset: undefined,
          expiresAt: computeWizardExpiration(now()),
        };
        sessionNewWizards.set(configButton.instanceId, nextState);
        if (lookup.state.activeAction === 'history' || lookup.state.activeAction === 'search') {
          await updateButtonMessage(
            value,
            buildSessionNewWizardMessage(
              configButton.instanceId,
              lookup.state.initiatorId,
              lookup.state.sourceChannelId,
            ),
          );
        } else {
          await updateButtonMessage(value, buildSessionNewWizardOptionsMessage(configButton.instanceId, nextState));
        }
        return;
      }

      const saveWorkdir = deps.runnerClient.saveWorkdir;
      if (!saveWorkdir) {
        sessionNewWizards.delete(configButton.instanceId);
        await updateButtonMessage(value, buildHistorySaveUnavailableMessage());
        return;
      }

      try {
        await saveWorkdir({
          path: selectedPath!.path,
          displayName: lookup.state.selectedWorkdirDisplayName,
          createdBy: value.user.id,
        });
      } catch {
        sessionNewWizards.delete(configButton.instanceId);
        await updateButtonMessage(value, buildHistorySaveUnavailableMessage());
        return;
      }

      sessionNewWizards.delete(configButton.instanceId);
      const session = await createThreadBackedSessionFromWizard(
        deps,
        lookup.state,
        selectedPath!.path,
        getRoleIds(value.member),
      );
      await updateButtonMessage(value, buildSimpleWizardMessage(`Session ${session.sessionId} created in thread ${session.threadId}.`));
      return;
    }

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

    const promptId = parsed.promptId ?? (await resolvePendingPermissionPromptId(deps.runnerClient, parsed.sessionId));
    if (!promptId) {
      await clearButtonMessage(value);
      return;
    }

    await deps.handlers.handleResolvePrompt({
      promptId,
      resolution: parsed.resolution,
      userId: value.user.id,
      sessionId: parsed.sessionId,
      roleIds: getRoleIds(value.member)
    });

    await clearButtonMessage(value);
    return;
  }

  if (isStringSelectInteraction(value)) {
    const parsed = parseSessionNewWizardSelectId(value.customId);
    if (!parsed) {
      return;
    }

    const lookup = lookupSessionNewWizardState(sessionNewWizards, parsed.instanceId, value.user.id, now);
    if (lookup.status === 'forbidden') {
      await replyWithEphemeralWizardMessage(value, buildSessionNewWizardForbiddenMessage());
      return;
    }

    if (lookup.status !== 'active') {
      await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
      return;
    }

    const selectedValue = value.values[0]?.trim();
    if (!selectedValue) {
      await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
      return;
    }

    if (parsed.action === 'model') {
      if (!SESSION_MODEL_OPTIONS.includes(selectedValue as SessionModelOption)) {
        await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
        return;
      }

      const nextState: SessionNewWizardState = {
        ...lookup.state,
        model: selectedValue as SessionModelOption,
        activeConfigAction: undefined,
        expiresAt: computeWizardExpiration(now()),
      };
      sessionNewWizards.set(parsed.instanceId, nextState);
      await updateButtonMessage(value, buildSessionNewWizardOptionsMessage(parsed.instanceId, nextState));
      return;
    }

    if (parsed.action === 'effort') {
      const nextState: SessionNewWizardState = {
        ...lookup.state,
        effort: selectedValue === 'default' ? undefined : parseEffortOption(selectedValue),
        activeConfigAction: undefined,
        expiresAt: computeWizardExpiration(now()),
      };
      sessionNewWizards.set(parsed.instanceId, nextState);
      await updateButtonMessage(value, buildSessionNewWizardOptionsMessage(parsed.instanceId, nextState));
      return;
    }

    if (lookup.state.activeAction !== parsed.action) {
      await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
      return;
    }

    if (parsed.action === 'history') {
      const selectedItem = lookup.state.historyItems?.find((item) => item.id === selectedValue);
      if (!selectedItem) {
        await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
        return;
      }

      const nextState: SessionNewWizardState = {
        ...lookup.state,
        activeAction: undefined,
        selectedPath: {
          path: selectedItem.path,
          source: 'history',
        },
        selectedWorkdirDisplayName: selectedItem.displayName?.trim() || basename(selectedItem.path),
        expiresAt: computeWizardExpiration(now()),
      };
      sessionNewWizards.set(parsed.instanceId, nextState);
      await updateButtonMessage(value, buildSessionNewWizardOptionsMessage(parsed.instanceId, nextState));
      return;
    }

    const selectedScanItem = parsed.action === 'search'
      ? resolveScanSelection(lookup.state, selectedValue)
      : null;
    if (parsed.action === 'search' && !selectedScanItem) {
      await acknowledgeButton(value, 'Session setup expired. Please run /session-new again.');
      return;
    }

    const nextState: SessionNewWizardState = {
      ...lookup.state,
      selectedPath: {
        path: selectedScanItem?.path ?? selectedValue,
        source: parsed.action
      },
      expiresAt: computeWizardExpiration(now())
    };
    sessionNewWizards.set(parsed.instanceId, nextState);

    if (parsed.action === 'search') {
      await showSessionNewRenameModal(value, parsed.instanceId, selectedScanItem?.path ?? selectedValue);
      return;
    }

    await updateButtonMessage(value, buildSessionNewWizardOptionsMessage(parsed.instanceId, nextState));
    return;
  }

  if (isModalSubmitInteraction(value)) {
    const parsed = parseSessionNewWizardModalId(value.customId);
    if (!parsed) {
      return;
    }

    const lookup = lookupSessionNewWizardState(sessionNewWizards, parsed.instanceId, value.user.id, now);
    if (lookup.status === 'forbidden') {
      await replyWithWizardMessage(value, buildSessionNewWizardForbiddenMessage());
      return;
    }

    if (lookup.status !== 'active') {
      await replyWithWizardMessage(value, buildSessionNewWizardExpiredMessage());
      return;
    }

    if (parsed.action === 'manual') {
      const cwd = value.fields.getTextInputValue('cwd').trim();
      if (!cwd) {
        await replyWithWizardMessage(value, buildManualWorkdirRequiredMessage());
        return;
      }

      const nextState: SessionNewWizardState = {
        ...lookup.state,
        activeAction: undefined,
        selectedPath: {
          path: cwd,
          source: 'manual',
        },
        selectedWorkdirDisplayName: basename(cwd),
        expiresAt: computeWizardExpiration(now()),
      };
      sessionNewWizards.set(parsed.instanceId, nextState);
      await replyWithWizardMessage(value, buildSessionNewWizardOptionsMessage(parsed.instanceId, nextState));
      return;
    }

    if (parsed.action === 'skills') {
      const nextState: SessionNewWizardState = {
        ...lookup.state,
        activeConfigAction: undefined,
        skills: parseSkillsOption(value.fields.getTextInputValue('skills')),
        expiresAt: computeWizardExpiration(now()),
      };
      sessionNewWizards.set(parsed.instanceId, nextState);
      await replyWithWizardMessage(value, buildSessionNewWizardOptionsMessage(parsed.instanceId, nextState));
      return;
    }

    if (!lookup.state.selectedPath) {
      await replyWithWizardMessage(value, buildSessionNewWizardExpiredMessage());
      return;
    }

    const displayName = value.fields.getTextInputValue('displayName').trim();
    const resolvedDisplayName = await resolveScannedWorkdirDisplayName(deps, lookup.state.selectedPath.path, displayName);
    const nextState: SessionNewWizardState = {
      ...lookup.state,
      activeAction: undefined,
      selectedWorkdirDisplayName: resolvedDisplayName,
      expiresAt: computeWizardExpiration(now()),
    };
    sessionNewWizards.set(parsed.instanceId, nextState);
    await replyWithWizardMessage(value, buildSessionNewWizardOptionsMessage(parsed.instanceId, nextState));
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
    } else {
      const renderedPrompt = toPermissionPromptMessage(model.activePrompt);
      if (renderedPrompt) {
        await sendPermissionPromptMessage(channel, sessionId, renderedPrompt);
      }
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
  let deliveryState = input.deliveryState;

  try {
    while (!input.controller.signal.aborted) {
      try {
        for await (const envelope of input.deps.runnerClient.subscribeEvents({
          sessionId: input.sessionId,
          fromSeq: getSubscriptionStartSeq(model, deliveryState),
          abortSignal: input.controller.signal
        })) {
          deliveryState = null;
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
            await sendPermissionPromptMessage(input.channel, input.sessionId, {
              promptId: envelope.event.runtimePromptId ?? envelope.event.requestId,
              text: envelope.event.prompt,
            });
          }
        }
      } catch (error) {
        if (input.controller.signal.aborted) {
          break;
        }

        input.deps.logger?.error?.(formatError(error));
        continue;
      }

      break;
    }
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

function buildSessionNewWizardMessage(instanceId: string, userId: string, channelId: string) {
  return {
    embeds: [buildSystemEmbed('Choose how to pick a working directory before choosing model, effort, and skills.')],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardButtonId('history', instanceId, userId, channelId))
          .setLabel('Use history')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardButtonId('search', instanceId, userId, channelId))
          .setLabel('Search new')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardButtonId('manual', instanceId, userId, channelId))
          .setLabel('Manual input')
          .setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function buildSimpleWizardMessage(description: string) {
  return {
    embeds: [buildSystemEmbed(description)],
    components: []
  };
}

function buildHistoryPickerMessage(instanceId: string, state: SessionNewWizardState) {
  const historyItems = state.historyItems ?? [];
  const currentPage = state.historyPage ?? 0;
  const start = currentPage * HISTORY_PAGE_SIZE;
  const pageItems = historyItems.slice(start, start + HISTORY_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(historyItems.length / HISTORY_PAGE_SIZE));
  const components: unknown[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`session-new:select:history:${instanceId}`)
        .setPlaceholder('Choose a saved working directory')
        .addOptions(
          pageItems.map((item) => ({
            label: truncateDiscordSelectText(item.displayName?.trim() || item.path),
            value: item.id,
            description: item.displayName?.trim() ? truncateDiscordSelectText(item.path) : undefined,
          }))
        )
    )
  ];

  const buttons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId(buildSessionNewWizardConfigButtonId(instanceId, 'back'))
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  ];
  if (pageCount > 1) {
    if (currentPage > 0) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardHistoryPageButtonId(instanceId, 'previous'))
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (currentPage < pageCount - 1) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardHistoryPageButtonId(instanceId, 'next'))
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
      );
    }
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));

  return {
    embeds: [buildSystemEmbed('Choose a saved working directory for the new session.')],
    components
  };
}

function buildHistoryPickerUnavailableMessage(instanceId: string, state: SessionNewWizardState) {
  return {
    ...buildHistoryPickerMessage(instanceId, state),
    embeds: [buildSystemEmbed('Saved workdir is unavailable right now. Please choose another directory.')]
  };
}

function buildScanPickerMessage(instanceId: string, state: SessionNewWizardState) {
  const scanItems = state.scanItems ?? [];
  const scanOffset = state.scanOffset ?? 0;
  const components: unknown[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`session-new:select:search:${instanceId}`)
        .setPlaceholder('Choose a newly discovered working directory')
        .addOptions(
          scanItems.map((item, index) => ({
            label: truncateDiscordSelectText(item.displayName.trim() || item.path),
            value: buildSessionNewWizardScanSelectValue(scanOffset, index),
            description: item.displayName.trim() ? truncateDiscordSelectText(item.path) : undefined,
          }))
        )
    )
  ];

  const buttons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId(buildSessionNewWizardConfigButtonId(instanceId, 'back'))
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  ];
  if (scanOffset > 0) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(buildSessionNewWizardScanPageButtonId(instanceId, 'previous'))
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (state.scanNextOffset !== null && state.scanNextOffset !== undefined) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(buildSessionNewWizardScanPageButtonId(instanceId, 'next'))
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));

  return {
    embeds: [buildSystemEmbed('Choose a newly discovered working directory for the new session.')],
    components
  };
}

function buildSessionNewWizardOptionsMessage(instanceId: string, state: SessionNewWizardState) {
  const selectedPath = state.selectedPath?.path ?? '(missing)';
  const skills = state.skills.length > 0 ? state.skills.join(', ') : 'none';
  const lines = [
    'Review session options before creating the new session.',
    `workdir: ${selectedPath}`,
    `model: ${state.model}`,
    `effort: ${state.effort ?? 'default'}`,
    `skills: ${skills}`,
  ];

  return {
    embeds: [buildSystemEmbed(lines.join('\n'))],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardConfigButtonId(instanceId, 'model'))
          .setLabel('Model')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardConfigButtonId(instanceId, 'effort'))
          .setLabel('Effort')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardConfigButtonId(instanceId, 'skills'))
          .setLabel('Skills')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardConfigButtonId(instanceId, 'create'))
          .setLabel('Create session')
          .setStyle(ButtonStyle.Primary)
      )
    ]
  };
}

function buildSessionNewWizardModelMessage(instanceId: string, state: SessionNewWizardState) {
  return {
    embeds: [buildSystemEmbed(`Choose a model for the new session.\ncurrent: ${state.model}`)],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildSessionNewWizardConfigSelectId('model', instanceId))
          .setPlaceholder('Choose a model')
          .addOptions(
            SESSION_MODEL_OPTIONS.map((model) => ({
              label: model,
              value: model,
              default: state.model === model,
            }))
          )
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardConfigButtonId(instanceId, 'back'))
          .setLabel('Back')
          .setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function buildSessionNewWizardEffortMessage(instanceId: string, state: SessionNewWizardState) {
  const currentEffort = state.effort ?? 'default';

  return {
    embeds: [buildSystemEmbed(`Choose an effort level for the new session.\ncurrent: ${currentEffort}`)],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildSessionNewWizardConfigSelectId('effort', instanceId))
          .setPlaceholder('Choose an effort level')
          .addOptions(
            SESSION_EFFORT_OPTIONS.map((effort) => ({
              label: effort,
              value: effort,
              default: currentEffort === effort,
            }))
          )
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSessionNewWizardConfigButtonId(instanceId, 'back'))
          .setLabel('Back')
          .setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function buildSessionNewWizardStubMessage(action: SessionNewWizardAction, bootstrap: SessionNewWizardBootstrap) {
  const label = action === 'history' ? 'History picker' : 'Directory search';
  const effort = bootstrap.effort ?? 'default';
  const skills = bootstrap.skills.length > 0 ? bootstrap.skills.join(', ') : 'none';

  return {
    embeds: [buildSystemEmbed(`${label} coming soon for ${bootstrap.model} (effort: ${effort}, skills: ${skills}).`)],
    components: []
  };
}

function buildHistorySaveUnavailableMessage() {
  return buildSimpleWizardMessage('Saved workdir is unavailable right now. Please choose another directory.');
}

function buildManualWorkdirRequiredMessage() {
  return buildSimpleWizardMessage('Working directory is required.');
}

function buildSessionNewWizardExpiredMessage() {
  return {
    embeds: [buildSystemEmbed('Session setup expired. Please run /session-new again.')],
    components: []
  };
}

function buildSessionNewWizardForbiddenMessage() {
  return {
    embeds: [buildSystemEmbed('Only the user who started this session setup can use it.')],
    components: []
  };
}

function truncateDiscordSelectText(value: string, maxLength = 100): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
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

async function createThreadBackedSessionFromWizard(
  deps: DiscordControlBotDeps,
  wizard: SessionNewWizardBootstrap,
  cwd: string,
  roleIds: readonly string[]
): Promise<{ sessionId: string; threadId: string }> {
  const sourceChannel = await deps.discord.getChannel?.(wizard.sourceChannelId);
  const thread = await ensureThreadChannel(sourceChannel, wizard.displayName);
  const session = await deps.handlers.handleCreateSession({
    channelId: thread.id,
    cwd,
    model: wizard.model,
    displayName: wizard.displayName,
    effort: wizard.effort,
    skills: wizard.skills,
    userId: wizard.initiatorId,
    roleIds: [...roleIds]
  });

  await sendChannelMessage(
    thread as ThreadMessageChannel,
    buildSessionSummaryMessage({
      sessionId: session.sessionId,
      displayName: wizard.displayName,
      cwd,
      model: wizard.model,
      effort: wizard.effort,
      skills: wizard.skills
    })
  );

  return {
    sessionId: session.sessionId,
    threadId: thread.id
  };
}

async function resolveScannedWorkdirDisplayName(
  deps: DiscordControlBotDeps,
  path: string,
  submittedDisplayName: string
): Promise<string> {
  if (submittedDisplayName.length > 0) {
    return submittedDisplayName;
  }

  const listWorkdirs = deps.runnerClient.listWorkdirs;
  if (listWorkdirs) {
    try {
      const existingWorkdir = (await listWorkdirs()).find((item) => item.path === path);
      const existingDisplayName = existingWorkdir?.displayName?.trim();
      if (existingDisplayName) {
        return existingDisplayName;
      }
    } catch {
      // Fall back to the scanned path basename when history lookup is unavailable.
    }
  }

  return basename(path);
}

async function resolvePendingPermissionPromptId(
  runnerClient: Pick<RunnerControlClient, 'getPendingPrompt'>,
  sessionId: string,
): Promise<string | null> {
  const pendingPrompt = await runnerClient.getPendingPrompt({ sessionId });
  if (!pendingPrompt || pendingPrompt.kind !== 'permission') {
    return null;
  }

  return pendingPrompt.promptId;
}

function toPermissionPromptMessage(
  prompt:
    | SessionRenderModel['activePrompt']
    | { kind: 'permission'; promptId: string; runtimePromptId?: string; text: string }
    | null
    | undefined,
): { promptId: string; text: string } | null {
  if (!prompt || prompt.kind !== 'permission') {
    return null;
  }

  return {
    promptId: prompt.runtimePromptId ?? prompt.promptId,
    text: prompt.text,
  };
}

async function showSessionNewRenameModal(
  interaction: {
    showModal?: (input: ModalBuilder) => Promise<void>;
    update?: (input: { content?: string; embeds?: unknown[]; components?: unknown[] }) => Promise<void>;
    reply?: (input: { content?: string; embeds?: unknown[]; components?: unknown[]; ephemeral: boolean }) => Promise<void>;
  },
  instanceId: string,
  path: string
): Promise<void> {
  if (interaction.showModal) {
    await interaction.showModal(buildSessionNewWizardRenameModal(instanceId, path));
    return;
  }

  await updateButtonMessage(interaction, buildSimpleWizardMessage(`Rename the saved workdir for ${path} to continue.`));
}

async function showSessionNewManualModal(
  interaction: {
    showModal?: (input: ModalBuilder) => Promise<void>;
    update?: (input: { content?: string; embeds?: unknown[]; components?: unknown[] }) => Promise<void>;
    reply?: (input: { content?: string; embeds?: unknown[]; components?: unknown[]; ephemeral: boolean }) => Promise<void>;
  },
  instanceId: string,
): Promise<void> {
  if (interaction.showModal) {
    await interaction.showModal(buildSessionNewWizardManualCwdModal(instanceId));
    return;
  }

  await updateButtonMessage(interaction, buildSimpleWizardMessage('Enter a working directory path to continue.'));
}

async function showSessionNewSkillsModal(
  interaction: {
    showModal?: (input: ModalBuilder) => Promise<void>;
    update?: (input: { content?: string; embeds?: unknown[]; components?: unknown[] }) => Promise<void>;
    reply?: (input: { content?: string; embeds?: unknown[]; components?: unknown[]; ephemeral: boolean }) => Promise<void>;
  },
  instanceId: string,
  skills: readonly string[],
): Promise<void> {
  if (interaction.showModal) {
    await interaction.showModal(buildSessionNewWizardSkillsModal(instanceId, skills));
    return;
  }

  await updateButtonMessage(interaction, buildSimpleWizardMessage('Update skills to continue.'));
}

function buildSessionNewWizardRenameModal(instanceId: string, path: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`session-new:modal:rename:${instanceId}`)
    .setTitle('Rename workdir')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('displayName')
          .setLabel('Display name')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(basename(path))
      )
    );
}

function buildSessionNewWizardManualCwdModal(instanceId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`session-new:modal:manual:${instanceId}`)
    .setTitle('Enter workdir path')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('cwd')
          .setLabel('Working directory')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

function buildSessionNewWizardSkillsModal(instanceId: string, skills: readonly string[]): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`session-new:modal:skills:${instanceId}`)
    .setTitle('Set session skills')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('skills')
          .setLabel('Comma-separated skills')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(skills.join(', '))
      )
    );
}

export function buildPromptButtonId(
  resolution: 'allow_once' | 'deny_once',
  _promptId: string,
  sessionId: string
): string {
  return `prompt:${resolution}:${sessionId}`;
}

function buildSessionNewWizardButtonId(
  action: SessionNewWizardAction,
  instanceId: string,
  userId: string,
  channelId: string
): string {
  return `session-new:${action}:${instanceId}:${userId}:${channelId}`;
}

function buildSessionNewWizardHistoryPageButtonId(instanceId: string, direction: 'previous' | 'next'): string {
  return `session-new:history-page:${instanceId}:${direction}`;
}

function buildSessionNewWizardScanPageButtonId(instanceId: string, direction: 'previous' | 'next'): string {
  return `session-new:scan-page:${instanceId}:${direction}`;
}

function buildSessionNewWizardConfigButtonId(instanceId: string, action: SessionNewWizardConfigAction): string {
  return `session-new:config:${instanceId}:${action}`;
}

function buildSessionNewWizardConfigSelectId(kind: 'model' | 'effort', instanceId: string): string {
  return `session-new:select:${kind}:${instanceId}`;
}

function buildSessionNewWizardScanSelectValue(offset: number, index: number): string {
  return `scan:${offset}:${index}`;
}

export function buildBashDetailButtonId(sessionId: string, toolUseId: string, mode: 'view' | 'hide' = 'view'): string {
  return `bash:${mode}:${sessionId}:${toolUseId}`;
}

function parsePromptButtonId(customId: string): {
  resolution: 'allow_once' | 'deny_once';
  promptId?: string;
  sessionId: string;
} | null {
  const legacyMatch = customId.match(/^prompt:(allow_once|deny_once):([^:]+):(.+)$/);
  if (legacyMatch) {
    return {
      resolution: legacyMatch[1] as 'allow_once' | 'deny_once',
      promptId: legacyMatch[2],
      sessionId: legacyMatch[3],
    };
  }

  const match = customId.match(/^prompt:(allow_once|deny_once):(.+)$/);
  if (!match) {
    return null;
  }

  return {
    resolution: match[1] as 'allow_once' | 'deny_once',
    sessionId: match[2],
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

function parseSessionNewWizardButtonId(customId: string): {
  action: SessionNewWizardAction;
  instanceId: string;
  userId: string;
  channelId: string;
} | null {
  const match = customId.match(/^session-new:(history|search|manual):([^:]+):([^:]+):(.+)$/);
  if (!match) {
    return null;
  }

  return {
    action: match[1] as SessionNewWizardAction,
    instanceId: match[2],
    userId: match[3],
    channelId: match[4]
  };
}

function parseSessionNewWizardConfigButtonId(customId: string): {
  instanceId: string;
  action: SessionNewWizardConfigAction;
} | null {
  const match = customId.match(/^session-new:config:([^:]+):(model|effort|skills|create|back)$/);
  if (!match) {
    return null;
  }

  return {
    instanceId: match[1],
    action: match[2] as SessionNewWizardConfigAction,
  };
}

function parseSessionNewWizardHistoryPageButtonId(customId: string): {
  instanceId: string;
  direction: 'previous' | 'next';
} | null {
  const match = customId.match(/^session-new:history-page:([^:]+):(previous|next)$/);
  if (!match) {
    return null;
  }

  return {
    instanceId: match[1],
    direction: match[2] as 'previous' | 'next'
  };
}

function parseSessionNewWizardScanPageButtonId(customId: string): {
  instanceId: string;
  direction: 'previous' | 'next';
} | null {
  const match = customId.match(/^session-new:scan-page:([^:]+):(previous|next)$/);
  if (!match) {
    return null;
  }

  return {
    instanceId: match[1],
    direction: match[2] as 'previous' | 'next'
  };
}

function parseSessionNewWizardSelectId(customId: string): {
  action: 'history' | 'search' | 'model' | 'effort';
  instanceId: string;
} | null {
  const match = customId.match(/^session-new:select:(history|search|model|effort):([^:]+)$/);
  if (!match) {
    return null;
  }

  return {
    action: match[1] as 'history' | 'search' | 'model' | 'effort',
    instanceId: match[2]
  };
}

function parseSessionNewWizardModalId(customId: string): {
  action: 'rename' | 'manual' | 'skills';
  instanceId: string;
} | null {
  const match = customId.match(/^session-new:modal:(rename|manual|skills):([^:]+)$/);
  if (!match) {
    return null;
  }

  return {
    action: match[1] as 'rename' | 'manual' | 'skills',
    instanceId: match[2]
  };
}

function resolveScanSelection(
  state: SessionNewWizardState,
  selectedValue: string
): RunnerWorkdirScanCandidate | null {
  const match = selectedValue.match(/^scan:(\d+):(\d+)$/);
  if (!match) {
    return null;
  }

  const offset = Number(match[1]);
  const index = Number(match[2]);
  if (Number.isNaN(offset) || Number.isNaN(index) || offset !== (state.scanOffset ?? 0)) {
    return null;
  }

  return state.scanItems?.[index] ?? null;
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

async function replyWithWizardMessage(
  interaction: {
    reply?: (input: { content?: string; embeds?: unknown[]; components?: unknown[]; ephemeral: boolean }) => Promise<void>;
  },
  input: { content?: string; embeds?: unknown[]; components?: unknown[] }
): Promise<void> {
  if (interaction.reply) {
    await interaction.reply({
      ...normalizeDiscordObjectMessage(input),
      ephemeral: true
    });
  }
}

async function replyWithEphemeralWizardMessage(
  interaction: {
    reply?: (input: { content?: string; embeds?: unknown[]; components?: unknown[]; ephemeral: boolean }) => Promise<void>;
  },
  input: { content?: string; embeds?: unknown[]; components?: unknown[] }
): Promise<void> {
  await replyWithWizardMessage(interaction, input);
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

function computeWizardExpiration(nowValue: string): string {
  const baseTime = Date.parse(nowValue);
  return new Date((Number.isNaN(baseTime) ? Date.now() : baseTime) + SESSION_NEW_WIZARD_TTL_MS).toISOString();
}

function lookupSessionNewWizardState(
  sessionNewWizards: Map<string, SessionNewWizardState>,
  instanceId: string,
  userId: string,
  now: () => string
): SessionNewWizardLookup {
  const state = sessionNewWizards.get(instanceId);
  if (!state) {
    return { status: 'missing' };
  }

  const expiresAt = Date.parse(state.expiresAt);
  const currentTime = Date.parse(now());
  if (!Number.isNaN(expiresAt) && !Number.isNaN(currentTime) && currentTime > expiresAt) {
    sessionNewWizards.delete(instanceId);
    return { status: 'expired' };
  }

  if (state.initiatorId !== userId) {
    return { status: 'forbidden', state };
  }

  return { status: 'active', state };
}

function pruneExpiredSessionNewWizards(
  sessionNewWizards: Map<string, SessionNewWizardState>,
  now: () => string
): void {
  const currentTime = Date.parse(now());
  if (Number.isNaN(currentTime)) {
    return;
  }

  for (const [instanceId, state] of sessionNewWizards.entries()) {
    const expiresAt = Date.parse(state.expiresAt);
    if (!Number.isNaN(expiresAt) && currentTime > expiresAt) {
      sessionNewWizards.delete(instanceId);
    }
  }
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

function isRequiresWorkdirResult(value: unknown): value is { status: 'requires_workdir' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value as { status?: unknown }).status === 'requires_workdir'
  );
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
  reply(input: { content?: string; embeds?: unknown[]; components?: unknown[]; ephemeral: boolean }): Promise<void>;
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

function isStringSelectInteraction(value: unknown): value is {
  isStringSelectMenu: () => boolean;
  customId: string;
  values: string[];
  user: { id: string };
  member: unknown;
  reply?: (input: { content?: string; embeds?: unknown[]; components?: unknown[]; ephemeral: boolean }) => Promise<void>;
  update?: (input: { content?: string; embeds?: unknown[]; components?: unknown[] }) => Promise<void>;
  showModal?: (input: ModalBuilder) => Promise<void>;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isStringSelectMenu' in value &&
    typeof (value as { isStringSelectMenu: unknown }).isStringSelectMenu === 'function' &&
    (value as { isStringSelectMenu: () => boolean }).isStringSelectMenu()
  );
}

function isModalSubmitInteraction(value: unknown): value is {
  isModalSubmit: () => boolean;
  customId: string;
  user: { id: string };
  member: unknown;
  fields: { getTextInputValue(name: string): string };
  reply?: (input: { content?: string; embeds?: unknown[]; components?: unknown[]; ephemeral: boolean }) => Promise<void>;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isModalSubmit' in value &&
    typeof (value as { isModalSubmit: unknown }).isModalSubmit === 'function' &&
    (value as { isModalSubmit: () => boolean }).isModalSubmit()
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
