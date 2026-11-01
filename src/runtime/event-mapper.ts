// @ts-check
/**
 * Pi event -> MiniBots event mapping.
 *
 * The upstream Mini App already declares the event contract the engine reads
 * (`MiniAppAgentRunEvent` in `miniapp/node/miniapp-api.ts`). The adapter is the
 * only producer of those events, so it is the right place to guarantee the
 * invariants the engine relies on:
 *
 * - exactly one `turn.started` per run;
 * - exactly one `message.committed` per assistant message, so the engine does
 *   not append a second copy of text the deltas already delivered;
 * - tool calls settled by their call id, not by name, so two concurrent calls
 *   to the same tool stay distinguishable;
 * - exactly one `turn.finished` per run.
 */

/** The JSON values the upstream contract allows. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * The questionnaire a `question.requested` event carries.
 *
 * It mirrors the upstream `MiniAppAgentQuestionnaire`, so the adapter does
 * not depend on the vendored Mini App.
 */
export interface AgentQuestionnaire {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly title?: string;
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly header?: string;
    readonly question: string;
    readonly description?: string;
    readonly selectionMode: 'single' | 'multiple';
    readonly options: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly description?: string;
    }>;
    readonly allowOther: true;
  }>;
  readonly mode?: 'questionnaire' | 'feature-enable' | 'plan';
  readonly modePayload?: { readonly [key: string]: JsonValue };
  readonly expiresAt?: number;
}

/** The upstream event union, mirrored so the adapter does not import the Mini App. */
export type MappedEvent =  | { type: 'turn.started'; sessionId: string; turnId: string }
  | { type: 'text.delta'; sessionId: string; turnId: string; text: string }
  | { type: 'message.committed'; sessionId: string; turnId: string; text: string }
  | { type: 'tool.started'; sessionId: string; turnId: string; name: string }
  | { type: 'tool.finished'; sessionId: string; turnId: string; name: string; ok: boolean }
  | {
      type: 'permission.requested';
      sessionId: string;
      turnId?: string;
      requestId: string;
      toolName: string;
      toolInput?: string;
      reason: string;
    }
  | {
      type: 'question.requested';
      sessionId: string;
      turnId?: string;
      requestId: string;
      mode: 'questionnaire' | 'feature-enable' | 'plan';
      request: AgentQuestionnaire;
    }
  | {
      type: 'turn.finished';
      sessionId: string;
      turnId: string;
      status: 'finished' | 'error' | 'aborted';
      text?: string;
      error?: { code: string; message: string };
    };

/** The Pi events this mapper understands. */
export type PiAgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: unknown[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: unknown; toolResults: unknown[] }
  | { type: 'message_start'; message: unknown }
  | { type: 'message_update'; message: unknown; assistantMessageEvent: unknown }
  | { type: 'message_end'; message: unknown }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean; durationMs?: number };

interface AssistantMessageLike {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

export interface EventMapperOptions {
  /** The application session id the engine knows this run by. */
  readonly sessionId: string;
  /** The turn id for this run. */
  readonly turnId: string;
  /** Called for every mapped event. */
  readonly emit: (event: MappedEvent) => void;
}

/**
 * Translates one run's Pi events into the upstream contract.
 *
 * One mapper instance belongs to one run. It tracks the text already streamed
 * so a committed message is recognised as the same message rather than a
 * second copy.
 */
export class EventMapper {
  readonly #options: EventMapperOptions;
  /** The text streamed so far for the assistant message in flight. */
  #streamed = '';
  /** The id of the tool call currently running, by call id. */
  readonly #runningTools = new Map<string, string>();
  /** Set once the turn has finished, so only one terminal event is emitted. */
  #finished = false;
  /** Set once the turn has started. */
  #started = false;

  constructor(options: EventMapperOptions) {
    this.#options = options;
  }

  get sessionId(): string {
    return this.#options.sessionId;
  }

  get turnId(): string {
    return this.#options.turnId;
  }

  /** True once a terminal event has been emitted. */
  get finished(): boolean {
    return this.#finished;
  }

  /** True once a tool has started: after that a failure is never auto-retried. */
  get toolStarted(): boolean {
    return this.#runningTools.size > 0 || this.#sawTool;
  }

  #sawTool = false;

  /** Handle one Pi event. */
  handle(event: PiAgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        // The turn has not necessarily started: `turn_start` is the reliable point.
        break;

      case 'turn_start':
        this.#emitStarted();
        break;

      case 'message_update': {
        const assistantEvent = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (assistantEvent?.type === 'text_delta' && typeof assistantEvent.delta === 'string' && assistantEvent.delta) {
          this.#emitStarted();
          this.#streamed += assistantEvent.delta;
          this.#options.emit({
            type: 'text.delta',
            sessionId: this.#options.sessionId,
            turnId: this.#options.turnId,
            text: assistantEvent.delta,
          });
        }
        break;
      }

      case 'message_end': {
        // Pi ends every message it handled, including the system prompt and
        // the user's own message. Only the assistant's message is the Bot's
        // reply; committing the user's text would echo their words back as
        // the answer.
        const message = event.message as AssistantMessageLike;
        if (message.role !== 'assistant') break;
        const text = textOf(message);
        if (!text) break;
        this.#emitStarted();
        this.#options.emit({
          type: 'message.committed',
          sessionId: this.#options.sessionId,
          turnId: this.#options.turnId,
          text,
        });
        this.#streamed = '';
        break;
      }

      case 'tool_execution_start':
        this.#emitStarted();
        this.#sawTool = true;
        this.#runningTools.set(event.toolCallId, event.toolName);
        this.#options.emit({
          type: 'tool.started',
          sessionId: this.#options.sessionId,
          turnId: this.#options.turnId,
          name: event.toolName,
        });
        break;

      case 'tool_execution_end':
        this.#sawTool = true;
        this.#runningTools.delete(event.toolCallId);
        this.#options.emit({
          type: 'tool.finished',
          sessionId: this.#options.sessionId,
          turnId: this.#options.turnId,
          name: event.toolName,
          ok: !event.isError,
        });
        break;

      case 'agent_end':
      case 'turn_end':
        // The terminal event is emitted by `finish()`, so that the adapter owns
        // exactly one of them. `agent_end` is not proof that retries and
        // follow-ups finished, so it is not used to settle a run.
        break;

      default:
        break;
    }
  }

  #emitStarted(): void {
    if (this.#started) return;
    this.#started = true;
    this.#options.emit({
      type: 'turn.started',
      sessionId: this.#options.sessionId,
      turnId: this.#options.turnId,
    });
  }

  /**
   * Emit the one terminal event for this run.
   *
   * Called by the adapter once Pi has settled and the prompt completed.
   */
  finish(status: 'finished' | 'error' | 'aborted', text?: string, error?: { code: string; message: string }): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#emitStarted();
    this.#options.emit({
      type: 'turn.finished',
      sessionId: this.#options.sessionId,
      turnId: this.#options.turnId,
      status,
      ...(text !== undefined ? { text } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  /** Emit a pending permission request. */
  permission(requestId: string, toolName: string, reason: string, toolInput?: string): void {
    this.#options.emit({
      type: 'permission.requested',
      sessionId: this.#options.sessionId,
      turnId: this.#options.turnId,
      requestId,
      toolName,
      reason,
      ...(toolInput !== undefined ? { toolInput } : {}),
    });
  }

  /** Emit a pending questionnaire. */
  question(
    requestId: string,
    mode: 'questionnaire' | 'feature-enable' | 'plan',
    request: AgentQuestionnaire,
  ): void {
    this.#options.emit({
      type: 'question.requested',
      sessionId: this.#options.sessionId,
      turnId: this.#options.turnId,
      requestId,
      mode,
      request,
    });
  }
}

/** The visible text of an assistant message, without reasoning blocks. */
function textOf(message: AssistantMessageLike | undefined): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as { type?: string; text?: string; content?: unknown };
    // Reasoning blocks are not visible answer text and must stay separate.
    if (record.type !== 'text') continue;
    if (typeof record.text === 'string') parts.push(record.text);
    else if (typeof record.content === 'string') parts.push(record.content);
  }
  return parts.join('');
}
