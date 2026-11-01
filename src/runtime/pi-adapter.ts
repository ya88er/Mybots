// @ts-check
/**
 * The Pi adapter.
 *
 * This is the seam between the MiniBots engine and the Pi coding-agent SDK.
 * It implements the upstream `MiniAppAgentClient` contract exactly, so the
 * engine and the whole client need no changes: the engine calls `run`,
 * `reply` and `answer`, and receives the `MiniAppAgentRunEvent` stream it was
 * written against.
 *
 * Ownership rules this file follows:
 * - Pi owns the model conversation, the tool loop, retries and compaction. The
 *   adapter never re-implements any of them.
 * - The adapter owns session association, event translation, model selection
 *   and cancellation.
 *
 * API notes verified against Pi 1.4.0's own declarations:
 * - `SessionManager` and `ModelRuntime` have private constructors; they are
 *   created through `SessionManager.create` / `ModelRuntime.create`.
 * - `ModelRuntime.create` takes `credentials`, `authPath` and `modelsPath`; it
 *   has no `agentDir` option.
 * - `createAgentSession({ tools })` takes tool *names*, so custom tools are
 *   registered through `customTools`.
 * - `ToolDefinition.execute` receives `(toolCallId, params, signal, onUpdate, ctx)`.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';

import { EventMapper, type MappedEvent, type PiAgentEvent } from './event-mapper.ts';
import { SessionRegistry, type SessionAssociation } from './session-registry.ts';

/**
 * One model the Host offers.
 *
 * The shape is what the settings UI and the turn composer read, so the
 * fields below are load-bearing:
 * - `providerId` / `modelId` identify the model and are what `run({ model })`
 *   takes.
 * - `thinking.efforts` lists the reasoning levels this model accepts; an
 *   empty list means the model has no reasoning control.
 * - `thinking.default` is the level the model uses when none is named.
 * - `variants` names the run variants the model supports. `''` means thinking
 *   can be turned off, and `'thinking'` means the thinking variant can be
 *   picked.
 */
export interface ModelCatalogEntry {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly thinking?: { readonly efforts?: readonly string[]; readonly default?: string };
  readonly variants?: readonly string[];
  readonly contextLimit?: number;
  readonly supportsTools?: boolean;
  readonly supportsImages?: boolean;
}

/**
 * The Host's model catalogue and the model a run uses when it names none.
 */
export interface ModelCatalog {
  readonly models: readonly ModelCatalogEntry[];
  readonly default?: ModelCatalogEntry;
}

/**
 * The questionnaire the upstream contract expects.
 *
 * It is the same shape the event mapper carries, so the request a tool
 * raises and the request the engine renders can never drift apart.
 */
export type AgentQuestionnaire = import('./event-mapper.ts').AgentQuestionnaire;

/** The JSON values the upstream contract allows. */
export type JsonValue = import('./event-mapper.ts').JsonValue;

/** The upstream result shape, mirrored so the adapter does not import the Mini App. */
export interface AgentRunResult {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly status: 'finished' | 'error' | 'aborted';
  readonly text?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly pendingQuestion?: {
    readonly requestId: string;
    readonly mode: 'questionnaire' | 'feature-enable' | 'plan';
    readonly request: AgentQuestionnaire;
  };
}

/** The upstream error codes the engine understands. */
export type AgentErrorCode =
  | 'NOT_PERMITTED'
  | 'BUSY'
  | 'SESSION_NOT_FOUND'
  | 'INVALID_ARGUMENTS'
  | 'AGENT_UNAVAILABLE'
  | 'REQUEST_CANCELLED'
  | 'AGENT_OUTCOME_UNKNOWN'
  | 'REQUEST_NOT_FOUND';

/** An error carrying the upstream code and whether the call may be retried. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly retryable: boolean;

  constructor(code: AgentErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * The model selection a run is admitted with.
 *
 * This is exactly the shape the upstream engine builds (`normalizeModel` in
 * `store.mjs`): `variant: ''` means thinking off, and `thinking.effort` names a
 * reasoning level.
 */
export interface ModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly thinking?: { readonly effort: string };
}

/** One tool the MiniBots engine exposes, bound to the calling session. */
export interface BoundTool {
  readonly name: string;
  readonly description: string;
  /** A TypeBox-compatible JSON schema for the tool's arguments. */
  readonly parameters: unknown;
  /**
   * Runs the tool with the caller's identity already bound.
   *
   * The context is supplied by the adapter, never by the model: a model must
   * not gain another Bot's authority by naming it in its arguments.
   */
  execute: (
    args: Record<string, unknown>,
    context: { botId: string; chatId: string; sessionId: string; runId: string },
  ) => Promise<{ content: string; isError?: boolean }>;
}

/** The options a run is admitted with. */
export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: MappedEvent) => void;
  /** The workspace this run works in. */
  readonly workspace?: string;
  /** The Bot and chat, required when the run starts a new session. */
  readonly botId?: string;
  readonly chatId?: string;
  /** The conversation generation; a cleared chat starts a new one. */
  readonly generation?: number;
}

export interface PiAdapterOptions {
  /** Where Pi keeps its agent directory (settings, resources). */
  readonly agentDir: string;
  /** Where Pi keeps its session files. */
  readonly sessionDir: string;
  /** The application session index. */
  readonly sessions: SessionRegistry;
  /** Supplies a provider API key, if one is configured. */
  readonly credential?: (providerId: string) => string | undefined;
  /** The tools available to every run, before session binding. */
  readonly tools?: () => BoundTool[];
  /**
   * Registers an extra provider with the runtime, before any run.
   *
   * The provider fixture uses this to register a deterministic provider that
   * drives Pi's real loop without a network call.
   */
  readonly provider?: (runtime: ModelRuntime) => void;
}

/** A live Pi session plus the state of the run in flight. */
interface LiveSession {
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  readonly association: SessionAssociation;
  /** The mapper for the run currently in flight on this session. */
  mapper?: EventMapper;
  /** The questionnaire that paused the run in flight, when one did. */
  pendingQuestion?: {
    requestId: string;
    mode: 'questionnaire' | 'feature-enable' | 'plan';
    request: AgentQuestionnaire;
  };
}

/**
 * The Pi host adapter.
 *
 * One instance per backend process. It is the single owner of the Pi sessions.
 */
export class PiAdapter {
  readonly #options: PiAdapterOptions;
  /** @type {Map<string, LiveSession>} app session id -> live session */
  readonly #live = new Map<string, LiveSession>();
  /** The Pi model runtime for this process, created on first use. */
  #modelRuntime: ModelRuntime | undefined;
  /** The providers whose key has been loaded into this runtime. */
  readonly #loadedProviders = new Set<string>();
  /** The pending permission requests, by request id. */
  readonly #permissions = new Map<string, { sessionId: string; decision?: 'allowOnce' | 'deny' }>();
  /** The pending questionnaire answers, by request id. */
  readonly #questions = new Map<string, { sessionId: string; answers?: unknown[] }>();
  /** The active run per app session, so a second prompt can be refused. */
  readonly #busy = new Set<string>();

  constructor(options: PiAdapterOptions) {
    this.#options = options;
  }

  /** The application session index. */
  get sessions(): SessionRegistry {
    return this.#options.sessions;
  }

  /** Whether a session currently has a run in flight. */
  isBusy(appSessionId: string): boolean {
    return this.#busy.has(appSessionId);
  }

  /**
   * The model catalogue the engine and the settings page read.
   *
   * Only providers with a configured key are listed: a model the user cannot
   * call is worse than no model at all.
   */
  async models(): Promise<{
    models: ModelCatalogEntry[];
    default?: ModelCatalogEntry;
  }> {
    const runtime = await this.#runtime();
    const models: ModelCatalogEntry[] = [];
    let defaultEntry: ModelCatalogEntry | undefined;

    for (const providerId of runtime.getRegisteredProviderIds()) {
      if (!this.#loadedProviders.has(providerId)) continue;
      for (const model of runtime.getModels(providerId)) {
        const entry = toCatalogEntry(model, providerId);
        if (!entry) continue;
        models.push(entry);
        if (!defaultEntry) defaultEntry = entry;
      }
    }

    return {
      models,
      ...(defaultEntry ? { default: defaultEntry } : {}),
    };
  }

  /**
   * Run one turn.
   *
   * The engine calls this with the Bot's text and, for a continued
   * conversation, the session to continue. The model selection travels in the
   * input, because that is where the upstream contract puts it.
   */
  async run(
    input: { text: string; sessionId?: string; model?: ModelSelection },
    options: RunOptions = {},
  ): Promise<AgentRunResult> {
    const association = this.#resolveAssociation(input.sessionId, options);
    const appSessionId = association.id;

    if (this.#busy.has(appSessionId)) {
      throw new AgentError('BUSY', 'The session already has a turn in flight.');
    }
    this.#busy.add(appSessionId);

    try {
      return await this.#runTurn(association, input.text, input.model, options);
    } finally {
      this.#busy.delete(appSessionId);
    }
  }

  /**
   * Continue a session with the answer to a pending questionnaire.
   *
   * The answer is consumed exactly once. A second submission with the same
   * request id is refused, so a double click cannot answer twice.
   */
  async answer(
    input: { sessionId: string; requestId: string; answers: readonly unknown[] },
    options: RunOptions = {},
  ): Promise<AgentRunResult> {
    const pending = this.#questions.get(input.requestId);
    if (!pending) {
      throw new AgentError('REQUEST_NOT_FOUND', 'That question is no longer pending.');
    }
    if (pending.sessionId !== input.sessionId) {
      throw new AgentError('NOT_PERMITTED', 'That question belongs to another session.');
    }
    if (pending.answers !== undefined) {
      throw new AgentError('BUSY', 'That question was already answered.');
    }
    pending.answers = [...input.answers];
    this.#questions.delete(input.requestId);

    const association = this.#options.sessions.get(input.sessionId);
    if (!association) {
      throw new AgentError('SESSION_NOT_FOUND', 'That session is gone.');
    }
    // The answers are the continuation's prompt: the model was waiting for a
    // decision, and this is that decision.
    return this.#runTurn(association, formatAnswers(input.answers), undefined, options, {
      continuation: true,
    });
  }

  /** Decide a pending permission request. */
  async reply(input: {
    sessionId: string;
    requestId: string;
    decision: 'allowOnce' | 'deny';
  }): Promise<void> {
    const pending = this.#permissions.get(input.requestId);
    if (!pending) {
      throw new AgentError('REQUEST_NOT_FOUND', 'That request is no longer pending.');
    }
    if (pending.sessionId !== input.sessionId) {
      throw new AgentError('NOT_PERMITTED', 'That request belongs to another session.');
    }
    if (pending.decision !== undefined) {
      throw new AgentError('BUSY', 'That request was already decided.');
    }
    pending.decision = input.decision;
    this.#permissions.delete(input.requestId);
  }

  /**
   * Raise a questionnaire and pause the turn that raised it.
   *
   * A tool calls this when it needs the user to choose something. The turn
   * ends with `pendingQuestion` set, exactly as the upstream contract
   * describes, and `answer()` continues it.
   *
   * The request id is generated here, so the tool cannot collide with another
   * request or answer on somebody else's behalf.
   */
  async requestQuestion(input: {
    readonly sessionId: string;
    readonly mode: 'questionnaire' | 'feature-enable' | 'plan';
    readonly request: AgentQuestionnaire;
  }): Promise<{ readonly requestId: string }> {
    const association = this.#options.sessions.get(input.sessionId);
    if (!association) {
      throw new AgentError('SESSION_NOT_FOUND', 'That session is gone.');
    }
    const requestId = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const pending = { sessionId: input.sessionId, answers: undefined as unknown[] | undefined };
    this.#questions.set(requestId, pending);

    const mapper = this.#mapperFor(input.sessionId);
    mapper?.question(requestId, input.mode, input.request);

    return { requestId };
  }

  /** The event mapper of the run in flight on a session, when there is one. */
  #mapperFor(sessionId: string): EventMapper | undefined {
    for (const live of this.#live.values()) {
      if (live.association.id === sessionId) return live.mapper;
    }
    return undefined;
  }

  /** Stop admission, abort active runs and release every handle. */
  async dispose(): Promise<void> {
    for (const live of this.#live.values()) {
      try {
        await live.session.abort();
      } catch {
        // The session may already be gone; disposal continues.
      }
      try {
        live.session.dispose();
      } catch {
        // Same.
      }
    }
    this.#live.clear();
    this.#busy.clear();
    this.#permissions.clear();
    this.#questions.clear();
  }

  // ------------------------------------------------------------------ internals

  /** The application session for this run, created on first use. */
  #resolveAssociation(sessionId: string | undefined, options: RunOptions): SessionAssociation {
    if (sessionId) {
      const known = this.#options.sessions.get(sessionId);
      if (known) return known;
    }
    // A new session: the engine passes no id for a fresh conversation, so the
    // caller supplies the bot and chat through the options.
    const botId = options.botId;
    const chatId = options.chatId;
    if (!botId || !chatId) {
      throw new AgentError('INVALID_ARGUMENTS', 'A new session needs a bot and a chat.');
    }
    const generation = options.generation ?? 0;
    return this.#options.sessions.ensure(
      botId,
      chatId,
      generation,
      options.workspace ?? this.#options.sessionDir,
    );
  }

  /** The Pi runtime for this process. */
  async #runtime(): Promise<ModelRuntime> {
    if (this.#modelRuntime) return this.#modelRuntime;
    // The credential store is in memory: a provider key never reaches a
    // plaintext auth file on disk. `modelsPath: null` keeps Pi from writing a
    // model catalogue either.
    const credentials = new InMemoryCredentialStore();
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      // No network refresh at start-up: the catalogue is read from the local
      // store, and the user can reload it from the settings page.
      allowModelNetwork: false,
    });
    this.#options.provider?.(runtime);
    this.#modelRuntime = runtime;
    return runtime;
  }

  /**
   * Make sure the runtime counts the provider as configured.
   *
   * Pi refuses a turn when `hasConfiguredAuth(providerId)` is false, and it
   * reports a provider as configured only when the credential *store* holds a
   * key for it. A provider that can resolve its own key — through an
   * environment variable, or a custom provider's own auth resolution — is
   * therefore refused even though it would work.
   *
   * The key is written into the in-memory store only. Nothing reaches a
   * plaintext auth file on disk.
   */
  async #ensureCredential(providerId: string): Promise<void> {
    if (this.#loadedProviders.has(providerId)) return;
    const runtime = await this.#runtime();

    // The user's own key wins: it is the one they typed in the settings page.
    const key = this.#options.credential?.(providerId);
    if (key) {
      await runtime.setRuntimeApiKey(providerId, key);
      this.#loadedProviders.add(providerId);
      return;
    }

    // Otherwise ask the provider to resolve its own key and store that, so the
    // runtime knows the provider is usable.
    const resolution = await runtime.getAuth(providerId);
    const resolved = resolution?.auth?.apiKey;
    if (typeof resolved === 'string' && resolved) {
      await runtime.setRuntimeApiKey(providerId, resolved);
    }
    this.#loadedProviders.add(providerId);
  }

  /** The live Pi session for an application session, created or resumed. */
  async #liveSession(association: SessionAssociation): Promise<LiveSession> {
    const existing = this.#live.get(association.id);
    if (existing) return existing;

    const workspace = association.workspace || (await mkdtemp(join(tmpdir(), 'minibots-workspace-')));
    const sessionManager = association.piSessionFile
      ? SessionManager.open(association.piSessionFile, this.#options.sessionDir, workspace)
      : SessionManager.create(workspace, this.#options.sessionDir);

    const runtime = await this.#runtime();
    const bound = this.#options.tools?.() ?? [];
    const context = {
      botId: association.botId,
      chatId: association.chatId,
      sessionId: association.id,
      runId: association.id,
    };

    // The MiniBots business tools are registered as Pi custom tools. Each
    // closure captures the session's identity, so the caller the engine sees
    // is the real one and never one the model supplied.
    const customTools = bound.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters as never,
      execute: async (
        _toolCallId: string,
        args: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
      ) => {
        const result = await tool.execute(args ?? {}, context);
        return {
          // Pi's tool result carries model-facing content as a block array.
          content: [{ type: 'text' as const, text: result.content }],
          details: undefined,
          ...(result.isError ? { isError: true } : {}),
        };
      },
    }));

    const created = await createAgentSession({
      cwd: workspace,
      agentDir: this.#options.agentDir,
      sessionManager,
      modelRuntime: runtime,
      ...(customTools.length ? { customTools } : {}),
    });

    const live: LiveSession = {
      session: created.session,
      sessionManager,
      association,
    };
    this.#live.set(association.id, live);
    return live;
  }

  /** Run one turn on a session and resolve with the upstream result. */
  async #runTurn(
    association: SessionAssociation,
    text: string,
    model: ModelSelection | undefined,
    options: RunOptions,
    extra: { continuation?: boolean } = {},
  ): Promise<AgentRunResult> {
    const live = await this.#liveSession(association);
    const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const sessionId = association.id;

    let mapper!: EventMapper;
    let settle!: (result: AgentRunResult) => void;
    let fail!: (error: unknown) => void;
    const resultPromise = new Promise<AgentRunResult>((resolve, reject) => {
      mapper = new EventMapper({
        sessionId,
        turnId,
        emit: (event) => {
          options.onEvent?.(event);
          if (event.type === 'permission.requested') {
            this.#permissions.set(event.requestId, { sessionId });
          }
          if (event.type === 'question.requested') {
            this.#questions.set(event.requestId, { sessionId });
            live.pendingQuestion = {
              requestId: event.requestId,
              mode: event.mode,
              request: event.request,
            };
          }
        },
      });
      settle = resolve;
      fail = reject;
    });
    live.mapper = mapper;
    live.pendingQuestion = undefined;

    const unsubscribe = live.session.subscribe((event) => {
      try {
        mapper.handle(event as PiAgentEvent);
      } catch (error) {
        fail(error);
      }
    });

    // The association is persisted before the turn is acknowledged, so a crash
    // after the turn started still leaves a recoverable mapping.
    this.#options.sessions.bindPiSession(
      association.id,
      live.sessionManager.getSessionId(),
      live.sessionManager.getSessionFile(),
      model,
    );

    const signal = options.signal;
    const onAbort = () => {
      void live.session.abort().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // The effective model is the one the turn actually runs on: the caller's
      // selection, or the session's own model. Its provider must be configured
      // before Pi refuses the turn.
      const effective = model ?? this.#sessionModel(live);
      if (effective) {
        await this.#ensureCredential(effective.providerId);
        await this.#applyModel(live, effective);
      }
      await live.session.prompt(text);

      // Pi's prompt has resolved: the turn is over. The adapter owns the one
      // terminal event, so the run settles here rather than on a Pi event.
      const finalText = live.session.getLastAssistantText?.();
      const aborted = signal?.aborted === true;
      // A turn that ended on a questionnaire has no final answer: its text is
      // not the Bot's reply, and the engine waits for the user.
      const pending = live.pendingQuestion;
      mapper.finish(aborted ? 'aborted' : 'finished', pending ? undefined : finalText);
      settle({
        sessionId,
        turnId,
        status: aborted ? 'aborted' : 'finished',
        ...(pending ? undefined : finalText !== undefined ? { text: finalText } : {}),
        ...(pending ? { pendingQuestion: pending } : {}),
      });
    } catch (error) {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      const aborted = signal?.aborted === true;
      mapper.finish(
        aborted ? 'aborted' : 'error',
        undefined,
        {
          code: aborted ? 'REQUEST_CANCELLED' : 'AGENT_UNAVAILABLE',
          message: error instanceof Error ? error.message : String(error),
        },
      );
      throw error;
    }

    const settled = await resultPromise.finally(() => {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      live.mapper = undefined;
      live.pendingQuestion = undefined;
    });

    return settled;
  }

  /**
   * The model the session is already running on.
   *
   * A continued conversation keeps its model, so this is what the adapter
   * needs when the caller names none.
   */
  #sessionModel(live: LiveSession): ModelSelection | undefined {
    const current = live.session.model;
    const providerId = current?.provider;
    const modelId = current?.id;
    if (!providerId || !modelId) return undefined;
    return { providerId, modelId };
  }

  /**
   * Apply the requested model to a session.
   *
   * Pi resolves the model itself when the session already runs on one; the
   * selection is applied only when it differs, so a repeated turn does not
   * rewrite the session transcript.
   */
  async #applyModel(live: LiveSession, selection: ModelSelection): Promise<void> {
    const runtime = await this.#runtime();
    const model = runtime.getModel(selection.providerId, selection.modelId) as Model<never> | undefined;
    if (!model) {
      throw new AgentError(
        'INVALID_ARGUMENTS',
        `The model ${selection.providerId}/${selection.modelId} is not available.`,
      );
    }
    const current = live.session.model;
    if (current?.provider === selection.providerId && current?.id === selection.modelId) return;
    await live.session.setModel(model);
  }
}

/**
 * Render the user's answers as the continuation's prompt.
 *
 * The upstream answer shape is `{ stepId, selectedOptionIds, selectedOther,
 * otherText }`. The model reads it as plain text, so the shape is kept
 * recognisable rather than flattened into a sentence the model has to guess
 * at.
 */
function formatAnswers(answers: readonly unknown[]): string {
  const lines: string[] = ['The user answered your question:'];
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object') continue;
    const record = answer as {
      stepId?: unknown;
      selectedOptionIds?: unknown;
      selectedOther?: unknown;
      otherText?: unknown;
      skipped?: unknown;
    };
    if (record.skipped === true) {
      lines.push(`- ${String(record.stepId ?? 'question')}: skipped`);
      continue;
    }
    const selected = Array.isArray(record.selectedOptionIds)
      ? record.selectedOptionIds.map((id) => String(id)).join(', ')
      : '';
    const other = record.selectedOther === true ? String(record.otherText ?? '') : '';
    const parts = [selected, other].filter((part) => part.length > 0);
    lines.push(`- ${String(record.stepId ?? 'question')}: ${parts.join(' — ')}`);
  }
  return lines.join('\n');
}

/** Map a Pi model to the catalogue entry the engine and the UI read. */
function toCatalogEntry(model: unknown, providerId: string): ModelCatalogEntry | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const record = model as {
    id?: string;
    modelId?: string;
    name?: string;
    displayName?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    thinkingLevelMap?: unknown;
  };
  const modelId = record.modelId ?? record.id;
  if (typeof modelId !== 'string' || !modelId) return undefined;

  const entry: {
    providerId: string;
    modelId: string;
    displayName: string;
    supportsTools: boolean;
    contextLimit?: number;
  } = {
    providerId,
    modelId,
    displayName: record.displayName ?? record.name ?? modelId,
    supportsTools: true,
  };
  if (typeof record.contextWindow === 'number') entry.contextLimit = record.contextWindow;
  return entry;
}
