/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
        type AssistantMessage,
        type Context,
        EventStream,
        streamSimple,
        type ToolResultMessage,
        validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
        AgentContext,
        AgentEvent,
        AgentLoopConfig,
        AgentMessage,
        AgentTool,
        AgentToolCall,
        AgentToolResult,
        StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
        prompts: AgentMessage[],
        context: AgentContext,
        config: AgentLoopConfig,
        signal?: AbortSignal,
        streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
        const stream = createAgentStream();

        void runAgentLoop(
                prompts,
                context,
                config,
                async (event) => {
                        stream.push(event);
                },
                signal,
                streamFn,
        ).then((messages) => {
                stream.end(messages);
        });

        return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
        context: AgentContext,
        config: AgentLoopConfig,
        signal?: AbortSignal,
        streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
        if (context.messages.length === 0) {
                throw new Error("Cannot continue: no messages in context");
        }

        if (context.messages[context.messages.length - 1].role === "assistant") {
                throw new Error("Cannot continue from message role: assistant");
        }

        const stream = createAgentStream();

        void runAgentLoopContinue(
                context,
                config,
                async (event) => {
                        stream.push(event);
                },
                signal,
                streamFn,
        ).then((messages) => {
                stream.end(messages);
        });

        return stream;
}

export async function runAgentLoop(
        prompts: AgentMessage[],
        context: AgentContext,
        config: AgentLoopConfig,
        emit: AgentEventSink,
        signal?: AbortSignal,
        streamFn?: StreamFn,
): Promise<AgentMessage[]> {
        const newMessages: AgentMessage[] = [...prompts];
        const currentContext: AgentContext = {
                ...context,
                messages: [...context.messages, ...prompts],
        };

        await emit({ type: "agent_start" });
        await emit({ type: "turn_start" });
        for (const prompt of prompts) {
                await emit({ type: "message_start", message: prompt });
                await emit({ type: "message_end", message: prompt });
        }

        await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
        return newMessages;
}

export async function runAgentLoopContinue(
        context: AgentContext,
        config: AgentLoopConfig,
        emit: AgentEventSink,
        signal?: AbortSignal,
        streamFn?: StreamFn,
): Promise<AgentMessage[]> {
        if (context.messages.length === 0) {
                throw new Error("Cannot continue: no messages in context");
        }

        if (context.messages[context.messages.length - 1].role === "assistant") {
                throw new Error("Cannot continue from message role: assistant");
        }

        const newMessages: AgentMessage[] = [];
        const currentContext: AgentContext = { ...context };

        await emit({ type: "agent_start" });
        await emit({ type: "turn_start" });

        await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
        return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
        return new EventStream<AgentEvent, AgentMessage[]>(
                (event: AgentEvent) => event.type === "agent_end",
                (event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
        );
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 * Includes tau/sn66 v20 guardrails — synthesis of onel0ck v15-v17 proven
 * strategies + SOTA techniques from Augment Code, Refact.ai research.
 */
async function runLoop(
        currentContext: AgentContext,
        newMessages: AgentMessage[],
        config: AgentLoopConfig,
        signal: AbortSignal | undefined,
        emit: AgentEventSink,
        streamFn?: StreamFn,
): Promise<void> {
        let firstTurn = true;
        // Check for steering messages at start (user may have typed while waiting)
        let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

        // ---- tau/sn66 guardrail state ----

        // G1: Provider error retry (from onel0ck v15.1, proven in local smoke tests)
        // Gemini Flash via OpenRouter proxy intermittently returns finish_reason=error
        // mid-stream, leaving partial assistant message with no tool calls.
        let providerErrorRetries = 0;
        const MAX_PROVIDER_ERROR_RETRIES = 3;

        // G2: Consecutive edit-error detector (from onel0ck v15.2)
        // When same file accumulates 2+ "Could not find oldText" errors, force model
        // to move to a different file or re-read before retrying.
        const editErrorsByFile = new Map<string, number>();
        const stuckFilesAlerted = new Set<string>();
        const EDIT_ERROR_THRESHOLD_PER_FILE = 2;

        // G3: Exploration budget (from onel0ck v16)
        // Force edit after N reads without any edit. Also retry on token-length
        // hit or premature stop with no edits.
        let readsWithoutEdit = 0;
        let hasEditedAnyFile = false;
        let noToolCallRetries = 0;
        const MAX_NO_TOOL_RETRIES = 2;
        const MAX_READS_BEFORE_EDIT = 3;

        // G4: Wall-clock time pressure (from onel0ck v17, refined thresholds)
        // Validator kills at min(cursor_time*2, 300s). We assume worst case ~120s.
        const loopStartTime = Date.now();
        let timeWarningInjected = false;
        const TIME_WARNING_MS = 80_000;  // 80s — inject urgency
        // G5: Hard exit before validator kills container (from onel0ck v17)
        // Validator bug: only collects diff if container is still running.
        const HARD_EXIT_MS = 170_000;    // 170s — exit gracefully

        // G6: Selective stale-text warning (IMPROVEMENT over onel0ck)
        // King's version fires on EVERY successful edit, wasting tokens.
        // Ours only warns when the model seems about to re-edit a just-modified file.
        const recentlyEditedFiles = new Map<string, number>(); // path → turn number
        let turnNumber = 0;

        // G7: Anti-narration guardrail (NEW — from Augment Code "threatening" technique)
        // If model writes long text-only responses after first edit, inject urgency.
        let consecutiveTextOnlyTurns = 0;
        const MAX_TEXT_ONLY_TURNS_AFTER_EDIT = 2;

        // ---- End guardrail state ----

        // Outer loop: continues when queued follow-up messages arrive after agent would stop
        while (true) {
                let hasMoreToolCalls = true;
                turnNumber++;

                // Inner loop: process tool calls and steering messages
                while (hasMoreToolCalls || pendingMessages.length > 0) {
                        if (!firstTurn) {
                                await emit({ type: "turn_start" });
                        } else {
                                firstTurn = false;
                        }

                        // Process pending messages (inject before next assistant response)
                        if (pendingMessages.length > 0) {
                                for (const message of pendingMessages) {
                                        await emit({ type: "message_start", message });
                                        await emit({ type: "message_end", message });
                                        currentContext.messages.push(message);
                                        newMessages.push(message);
                                }
                                pendingMessages = [];
                        }

                        // Stream assistant response
                        const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
                        newMessages.push(message);

                        if (message.stopReason === "aborted") {
                                await emit({ type: "turn_end", message, toolResults: [] });
                                await emit({ type: "agent_end", messages: newMessages });
                                return;
                        }

                        // G1: Provider error → inject continuation and retry (v15.1)
                        if (message.stopReason === "error") {
                                if (providerErrorRetries < MAX_PROVIDER_ERROR_RETRIES) {
                                        providerErrorRetries++;
                                        await emit({ type: "turn_end", message, toolResults: [] });
                                        pendingMessages.push({
                                                role: "user",
                                                content: [
                                                        {
                                                                type: "text",
                                                                text: "Your previous response was cut off by a provider error. Continue immediately with a tool call — do not write narrative text, call read or edit directly. The harness scores your diff from disk; an empty diff loses the round.",
                                                        },
                                                ],
                                                timestamp: Date.now(),
                                        });
                                        hasMoreToolCalls = false;
                                        continue;
                                }
                                await emit({ type: "turn_end", message, toolResults: [] });
                                await emit({ type: "agent_end", messages: newMessages });
                                return;
                        }

                        // Check for tool calls
                        const toolCalls = message.content.filter((c) => c.type === "toolCall");
                        hasMoreToolCalls = toolCalls.length > 0;

                        // G3: Token-length / premature stop retry (v16)
                        if (!hasMoreToolCalls && noToolCallRetries < MAX_NO_TOOL_RETRIES) {
                                const isLength = message.stopReason === "length";
                                const isStopNoEdit = message.stopReason === "stop" && !hasEditedAnyFile;
                                if (isLength || isStopNoEdit) {
                                        noToolCallRetries++;
                                        await emit({ type: "turn_end", message, toolResults: [] });
                                        pendingMessages.push({
                                                role: "user",
                                                content: [
                                                        {
                                                                type: "text",
                                                                text: isLength
                                                                        ? "You hit the token limit without making any tool call. Do NOT write text. Call `read` or `edit` directly. One read + one edit = minimum unit of work."
                                                                        : "You stopped without editing any file. An empty diff loses. Call `read` on the most likely target file, then `edit` it. Do it now.",
                                                        },
                                                ],
                                                timestamp: Date.now(),
                                        });
                                        continue;
                                }
                        }

                        // G7: Anti-narration — if model keeps writing text without tools
                        // after already having edited something, push it to stop or edit more.
                        if (!hasMoreToolCalls && hasEditedAnyFile) {
                                consecutiveTextOnlyTurns++;
                                if (consecutiveTextOnlyTurns >= MAX_TEXT_ONLY_TURNS_AFTER_EDIT && pendingMessages.length === 0) {
                                        pendingMessages.push({
                                                role: "user",
                                                content: [
                                                        {
                                                                type: "text",
                                                                text: "Stop writing text. Either make another `edit` call or stop. Your diff is read from disk — narrative text is wasted tokens that could time out the run.",
                                                        },
                                                ],
                                                timestamp: Date.now(),
                                        });
                                        consecutiveTextOnlyTurns = 0;
                                }
                        } else if (hasMoreToolCalls) {
                                consecutiveTextOnlyTurns = 0;
                        }

                        const toolResults: ToolResultMessage[] = [];
                        if (hasMoreToolCalls) {
                                toolResults.push(...(await executeToolCalls(currentContext, message, config, signal, emit)));

                                for (const result of toolResults) {
                                        currentContext.messages.push(result);
                                        newMessages.push(result);
                                }

                                // G2: Track consecutive edit failures per file (v15.2)
                                for (let i = 0; i < toolResults.length; i++) {
                                        const tr = toolResults[i];
                                        const tc = toolCalls[i];
                                        if (!tc || tc.type !== "toolCall") continue;
                                        if (tc.name !== "edit") continue;
                                        const targetPath = (tc.arguments as { path?: string } | undefined)?.path;
                                        if (!targetPath || typeof targetPath !== "string") continue;
                                        if (tr.isError) {
                                                const next = (editErrorsByFile.get(targetPath) ?? 0) + 1;
                                                editErrorsByFile.set(targetPath, next);
                                                if (next >= EDIT_ERROR_THRESHOLD_PER_FILE && !stuckFilesAlerted.has(targetPath)) {
                                                        stuckFilesAlerted.add(targetPath);
                                                        pendingMessages.push({
                                                                role: "user",
                                                                content: [
                                                                        {
                                                                                type: "text",
                                                                                text: `STOP editing \`${targetPath}\`. You have failed ${next} edit attempts on this file in a row, all with "Could not find oldText" errors. The model's mental copy of this file is wrong. Do ONE of the following NOW:\n\n1. Move on to a DIFFERENT file in the task — there are likely other files mentioned in the acceptance criteria you haven't touched yet.\n2. If you must keep editing this file, call \`read\` on it ONE MORE TIME to refresh your view, then make ONE small edit with a very short, unique oldText snippet (5-10 lines max). Do not paste large blocks.\n3. Never paste text you remember — only paste text you have JUST read in this session.\n\nDo not retry the failed edits. Move on.`,
                                                                        },
                                                                ],
                                                                timestamp: Date.now(),
                                                        });
                                                }
                                        } else {
                                                // Successful edit resets error counter
                                                editErrorsByFile.set(targetPath, 0);
                                                hasEditedAnyFile = true;
                                                readsWithoutEdit = 0;

                                                // G6: Selective stale-text warning (improvement over onel0ck)
                                                // Only warn if the same file was edited in the PREVIOUS turn
                                                // (indicating model is re-editing immediately, likely with stale oldText).
                                                const lastEditTurn = recentlyEditedFiles.get(targetPath);
                                                if (lastEditTurn !== undefined && (turnNumber - lastEditTurn) <= 1) {
                                                        pendingMessages.push({
                                                                role: "user",
                                                                content: [
                                                                        {
                                                                                type: "text",
                                                                                text: `\`${targetPath}\` was JUST modified. If you need to edit this file again, call \`read\` on it first. Do NOT use oldText from memory.`,
                                                                        },
                                                                ],
                                                                timestamp: Date.now(),
                                                        });
                                                }
                                                recentlyEditedFiles.set(targetPath, turnNumber);
                                        }
                                }

                                // G3: Exploration budget — track reads without edits
                                for (const tr of toolResults) {
                                        if ((tr.toolName === "read" || tr.toolName === "bash") && !tr.isError) {
                                                if (!hasEditedAnyFile) readsWithoutEdit++;
                                        }
                                }
                                if (!hasEditedAnyFile && readsWithoutEdit >= MAX_READS_BEFORE_EDIT && pendingMessages.length === 0) {
                                        pendingMessages.push({
                                                role: "user",
                                                content: [
                                                        {
                                                                type: "text",
                                                                text: "You have read enough files. Call `edit` on the most likely target file NOW. Do not read more files. One imperfect edit beats an empty diff.",
                                                        },
                                                ],
                                                timestamp: Date.now(),
                                        });
                                        readsWithoutEdit = 0;
                                }

                                // G5: Hard exit before validator kills container (v17)
                                if ((Date.now() - loopStartTime) >= HARD_EXIT_MS) {
                                        await emit({ type: "turn_end", message, toolResults });
                                        await emit({ type: "agent_end", messages: newMessages });
                                        return;
                                }

                                // G4: Time pressure — urgency at 80s (v17)
                                if (!hasEditedAnyFile && !timeWarningInjected && (Date.now() - loopStartTime) >= TIME_WARNING_MS && pendingMessages.length === 0) {
                                        timeWarningInjected = true;
                                        pendingMessages.push({
                                                role: "user",
                                                content: [
                                                        {
                                                                type: "text",
                                                                text: "TIME WARNING: you have been running for over 80 seconds without producing an edit. The validator will kill this process soon. You MUST call `edit` or `write` on a file RIGHT NOW or you will score 0. Pick the single most obvious target file from the task and edit it immediately. Do not read any more files.",
                                                        },
                                                ],
                                                timestamp: Date.now(),
                                        });
                                }
                        }

                        await emit({ type: "turn_end", message, toolResults });

                        pendingMessages = (await config.getSteeringMessages?.()) || [];
                }

                // Agent would stop here. Check for follow-up messages.
                const followUpMessages = (await config.getFollowUpMessages?.()) || [];
                if (followUpMessages.length > 0) {
                        // Set as pending so inner loop processes them
                        pendingMessages = followUpMessages;
                        continue;
                }

                // No more messages, exit
                break;
        }

        await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
        context: AgentContext,
        config: AgentLoopConfig,
        signal: AbortSignal | undefined,
        emit: AgentEventSink,
        streamFn?: StreamFn,
): Promise<AssistantMessage> {
        // Apply context transform if configured (AgentMessage[] → AgentMessage[])
        let messages = context.messages;
        if (config.transformContext) {
                messages = await config.transformContext(messages, signal);
        }

        // Convert to LLM-compatible messages (AgentMessage[] → Message[])
        const llmMessages = await config.convertToLlm(messages);

        // Build LLM context
        const llmContext: Context = {
                systemPrompt: context.systemPrompt,
                messages: llmMessages,
                tools: context.tools,
        };

        const streamFunction = streamFn || streamSimple;

        // Resolve API key (important for expiring tokens)
        const resolvedApiKey =
                (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

        const response = await streamFunction(config.model, llmContext, {
                ...config,
                apiKey: resolvedApiKey,
                signal,
        });

        let partialMessage: AssistantMessage | null = null;
        let addedPartial = false;

        for await (const event of response) {
                switch (event.type) {
                        case "start":
                                partialMessage = event.partial;
                                context.messages.push(partialMessage);
                                addedPartial = true;
                                await emit({ type: "message_start", message: { ...partialMessage } });
                                break;

                        case "text_start":
                        case "text_delta":
                        case "text_end":
                        case "thinking_start":
                        case "thinking_delta":
                        case "thinking_end":
                        case "toolcall_start":
                        case "toolcall_delta":
                        case "toolcall_end":
                                if (partialMessage) {
                                        partialMessage = event.partial;
                                        context.messages[context.messages.length - 1] = partialMessage;
                                        await emit({
                                                type: "message_update",
                                                assistantMessageEvent: event,
                                                message: { ...partialMessage },
                                        });
                                }
                                break;

                        case "done":
                        case "error": {
                                const finalMessage = await response.result();
                                if (addedPartial) {
                                        context.messages[context.messages.length - 1] = finalMessage;
                                } else {
                                        context.messages.push(finalMessage);
                                }
                                if (!addedPartial) {
                                        await emit({ type: "message_start", message: { ...finalMessage } });
                                }
                                await emit({ type: "message_end", message: finalMessage });
                                return finalMessage;
                        }
                }
        }

        const finalMessage = await response.result();
        if (addedPartial) {
                context.messages[context.messages.length - 1] = finalMessage;
        } else {
                context.messages.push(finalMessage);
                await emit({ type: "message_start", message: { ...finalMessage } });
        }
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
        currentContext: AgentContext,
        assistantMessage: AssistantMessage,
        config: AgentLoopConfig,
        signal: AbortSignal | undefined,
        emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
        const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
        if (config.toolExecution === "sequential") {
                return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
        }
        return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

async function executeToolCallsSequential(
        currentContext: AgentContext,
        assistantMessage: AssistantMessage,
        toolCalls: AgentToolCall[],
        config: AgentLoopConfig,
        signal: AbortSignal | undefined,
        emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
        const results: ToolResultMessage[] = [];

        for (const toolCall of toolCalls) {
                await emit({
                        type: "tool_execution_start",
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        args: toolCall.arguments,
                });

                const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
                if (preparation.kind === "immediate") {
                        results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
                } else {
                        const executed = await executePreparedToolCall(preparation, signal, emit);
                        results.push(
                                await finalizeExecutedToolCall(
                                        currentContext,
                                        assistantMessage,
                                        preparation,
                                        executed,
                                        config,
                                        signal,
                                        emit,
                                ),
                        );
                }
        }

        return results;
}

async function executeToolCallsParallel(
        currentContext: AgentContext,
        assistantMessage: AssistantMessage,
        toolCalls: AgentToolCall[],
        config: AgentLoopConfig,
        signal: AbortSignal | undefined,
        emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
        const results: ToolResultMessage[] = [];
        const runnableCalls: PreparedToolCall[] = [];

        for (const toolCall of toolCalls) {
                await emit({
                        type: "tool_execution_start",
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        args: toolCall.arguments,
                });

                const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
                if (preparation.kind === "immediate") {
                        results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
                } else {
                        runnableCalls.push(preparation);
                }
        }

        const runningCalls = runnableCalls.map((prepared) => ({
                prepared,
                execution: executePreparedToolCall(prepared, signal, emit),
        }));

        for (const running of runningCalls) {
                const executed = await running.execution;
                results.push(
                        await finalizeExecutedToolCall(
                                currentContext,
                                assistantMessage,
                                running.prepared,
                                executed,
                                config,
                                signal,
                                emit,
                        ),
                );
        }

        return results;
}

type PreparedToolCall = {
        kind: "prepared";
        toolCall: AgentToolCall;
        tool: AgentTool<any>;
        args: unknown;
};

type ImmediateToolCallOutcome = {
        kind: "immediate";
        result: AgentToolResult<any>;
        isError: boolean;
};

type ExecutedToolCallOutcome = {
        result: AgentToolResult<any>;
        isError: boolean;
};

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
        if (!tool.prepareArguments) {
                return toolCall;
        }
        const preparedArguments = tool.prepareArguments(toolCall.arguments);
        if (preparedArguments === toolCall.arguments) {
                return toolCall;
        }
        return {
                ...toolCall,
                arguments: preparedArguments as Record<string, any>,
        };
}

async function prepareToolCall(
        currentContext: AgentContext,
        assistantMessage: AssistantMessage,
        toolCall: AgentToolCall,
        config: AgentLoopConfig,
        signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
        const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
        if (!tool) {
                return {
                        kind: "immediate",
                        result: createErrorToolResult(`Tool ${toolCall.name} not found`),
                        isError: true,
                };
        }

        try {
                const preparedToolCall = prepareToolCallArguments(tool, toolCall);
                const validatedArgs = validateToolArguments(tool, preparedToolCall);
                if (config.beforeToolCall) {
                        const beforeResult = await config.beforeToolCall(
                                {
                                        assistantMessage,
                                        toolCall,
                                        args: validatedArgs,
                                        context: currentContext,
                                },
                                signal,
                        );
                        if (beforeResult?.block) {
                                return {
                                        kind: "immediate",
                                        result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
                                        isError: true,
                                };
                        }
                }
                return {
                        kind: "prepared",
                        toolCall,
                        tool,
                        args: validatedArgs,
                };
        } catch (error) {
                return {
                        kind: "immediate",
                        result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
                        isError: true,
                };
        }
}

async function executePreparedToolCall(
        prepared: PreparedToolCall,
        signal: AbortSignal | undefined,
        emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
        const updateEvents: Promise<void>[] = [];

        try {
                const result = await prepared.tool.execute(
                        prepared.toolCall.id,
                        prepared.args as never,
                        signal,
                        (partialResult) => {
                                updateEvents.push(
                                        Promise.resolve(
                                                emit({
                                                        type: "tool_execution_update",
                                                        toolCallId: prepared.toolCall.id,
                                                        toolName: prepared.toolCall.name,
                                                        args: prepared.toolCall.arguments,
                                                        partialResult,
                                                }),
                                        ),
                                );
                        },
                );
                await Promise.all(updateEvents);
                return { result, isError: false };
        } catch (error) {
                await Promise.all(updateEvents);
                return {
                        result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
                        isError: true,
                };
        }
}

async function finalizeExecutedToolCall(
        currentContext: AgentContext,
        assistantMessage: AssistantMessage,
        prepared: PreparedToolCall,
        executed: ExecutedToolCallOutcome,
        config: AgentLoopConfig,
        signal: AbortSignal | undefined,
        emit: AgentEventSink,
): Promise<ToolResultMessage> {
        let result = executed.result;
        let isError = executed.isError;

        if (config.afterToolCall) {
                const afterResult = await config.afterToolCall(
                        {
                                assistantMessage,
                                toolCall: prepared.toolCall,
                                args: prepared.args,
                                result,
                                isError,
                                context: currentContext,
                        },
                        signal,
                );
                if (afterResult) {
                        result = {
                                content: afterResult.content ?? result.content,
                                details: afterResult.details ?? result.details,
                        };
                        isError = afterResult.isError ?? isError;
                }
        }

        return await emitToolCallOutcome(prepared.toolCall, result, isError, emit);
}

function createErrorToolResult(message: string): AgentToolResult<any> {
        return {
                content: [{ type: "text", text: message }],
                details: {},
        };
}

async function emitToolCallOutcome(
        toolCall: AgentToolCall,
        result: AgentToolResult<any>,
        isError: boolean,
        emit: AgentEventSink,
): Promise<ToolResultMessage> {
        await emit({
                type: "tool_execution_end",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result,
                isError,
        });

        const toolResultMessage: ToolResultMessage = {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: result.content,
                details: result.details,
                isError,
                timestamp: Date.now(),
        };

        await emit({ type: "message_start", message: toolResultMessage });
        await emit({ type: "message_end", message: toolResultMessage });
        return toolResultMessage;
}
