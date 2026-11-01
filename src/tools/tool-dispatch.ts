// @ts-check
/**
 * The MiniBots tool dispatch.
 *
 * The upstream Mini App exposes its 22 business tools over a Streamable HTTP
 * MCP endpoint. The Windows app offers the **same** tools to Pi, so a Bot can
 * drive its team, its memory and its schedules directly.
 *
 * The two transports share one implementation: the upstream dispatch does the
 * work, and this module adapts it to Pi's custom-tool shape. There is no
 * second implementation, so the two cannot drift apart.
 *
 * The authority rule is the important part. The upstream contract puts the
 * caller in the tool's arguments (`caller_bot_id`), because an HTTP client
 * has no other way to say who it is. A model, however, writes those
 * arguments — so a model could name another Bot and borrow its authority.
 *
 * Here the caller is bound by the **runtime**, from the session the run
 * belongs to, and the model's field is replaced rather than trusted. The
 * model never gains authority it was not given.
 */
import { EventMapper, type MappedEvent } from '../runtime/event-mapper.ts';
import type { BoundTool } from '../runtime/pi-adapter.ts';

/** The upstream dispatch, as the app uses it. */
export interface UpstreamDispatch {
  /** The tool definitions, in the current language. */
  definitions(): Array<{ name: string; description: string; inputSchema: unknown }>;
  /** The tool names the dispatch accepts. */
  names(): string[];
  /**
   * Call one tool.
   *
   * The `caller` is bound by the runtime; the model's own field is replaced.
   */
  call(
    name: string,
    args: Record<string, unknown>,
    options?: { caller?: unknown; signal?: AbortSignal },
  ): Promise<unknown>;
  /** The text a failed tool call shows the model. */
  failureText(error: unknown, name: string): string;
}

/** The Bot a tool call runs for. */
export interface ToolCaller {
  readonly id: string;
  readonly name?: string;
  /** The chat the call belongs to. */
  readonly chatId: string;
  /** The session the call belongs to. */
  readonly sessionId: string;
  /** The run the call belongs to. */
  readonly runId: string;
}

/** The Pi wire name of each upstream tool. */
export const MCP_TOOL_PREFIX = 'mcp__minimax-bot__';

/**
 * The Pi wire name of an upstream tool.
 *
 * The UI's canonical `mcp__minimax-bot__…` labels are preserved, because the
 * engine's receipt logic depends on them.
 */
export function wireName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name : `${MCP_TOOL_PREFIX}${name}`;
}

/** The upstream tool name of a Pi wire name. */
export function upstreamName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

export interface ToolDispatchOptions {
  /** The upstream dispatch, shared with the HTTP MCP endpoint. */
  readonly dispatch: UpstreamDispatch;
  /**
   * Resolves the Bot a call runs for.
   *
   * It is called with the session the run belongs to, so the authority is
   * the session's own — never the model's.
   */
  readonly resolveCaller: (sessionId: string) => ToolCaller | undefined;
  /**
   * The upstream store, used to look a Bot up by id.
   *
   * The bound caller must exist, or the call is refused.
   */
  readonly getBot?: (botId: string) => unknown;
  /** Reports a refused call. */
  readonly log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The tool dispatch, as Pi custom tools.
 *
 * One instance per backend process.
 */
export class ToolDispatch {
  readonly #options: ToolDispatchOptions;

  constructor(options: ToolDispatchOptions) {
    this.#options = options;
  }

  /** The upstream tool names this dispatch offers. */
  names(): string[] {
    return this.#options.dispatch.names();
  }

  /**
   * The tools, in Pi's custom-tool shape.
   *
   * Every tool runs with the caller's identity bound by the runtime.
   */
  tools(): BoundTool[] {
    return this.#options.dispatch.definitions().map((definition) => ({
      name: wireName(definition.name),
      description: definition.description,
      parameters: definition.inputSchema,
      execute: async (
        args: Record<string, unknown>,
        context: { botId: string; chatId: string; sessionId: string; runId: string },
      ) => {
        return this.#call(definition.name, args, context);
      },
    }));
  }

  /**
   * Call one tool with the caller's authority bound.
   *
   * The model's `caller_bot_id` is **replaced** by the session's own Bot, so
   * a model cannot impersonate another Bot by naming it.
   */
  async #call(
    upstream: string,
    args: Record<string, unknown>,
    context: { botId: string; chatId: string; sessionId: string; runId: string },
  ): Promise<{ content: string; isError?: boolean }> {
    const log = this.#options.log ?? (() => {});
    const caller = this.#options.resolveCaller(context.sessionId);

    if (!caller) {
      log('warn', 'minibots.tool_no_caller', { tool: upstream, sessionId: context.sessionId });
      return {
        content: `The tool ${upstream} cannot run: the session has no Bot bound to it.`,
        isError: true,
      };
    }

    // The bound caller replaces whatever the model wrote. The field is
    // removed rather than overwritten, so the model cannot even see its own
    // value reflected back.
    const sanitized: Record<string, unknown> = { ...args };
    delete sanitized.caller_bot_id;

    // The Bot must exist: a session bound to a deleted Bot must not act.
    const bot = this.#options.getBot?.(caller.id);
    if (this.#options.getBot && !bot) {
      log('warn', 'minibots.tool_caller_gone', { tool: upstream, botId: caller.id });
      return {
        content: `The tool ${upstream} cannot run: this Bot no longer exists.`,
        isError: true,
      };
    }

    try {
      const value = await this.#options.dispatch.call(upstream, sanitized, { caller: bot ?? caller });
      return { content: JSON.stringify(value, null, 2) };
    } catch (error) {
      // The upstream dispatch knows which failures are business errors the
      // model can act on, and which are faults of the plugin.
      const text = this.#options.dispatch.failureText(error, upstream);
      log('warn', 'minibots.tool_failed', {
        tool: upstream,
        code: (error as { code?: string } | undefined)?.code ?? 'unknown',
      });
      return { content: text, isError: true };
    }
  }
}
