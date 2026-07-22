// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/** Builds an error `CallToolResult`. */
export const errorResult = (text) => ({ content: [{ type: "text", text }], isError: true });
/**
 * Routes a validated, action-carrying args object to the matching command.
 *
 * This is what removes long positional parameter lists from grouped ("action")
 * tools: instead of destructuring every possible field, the whole typed args
 * object is forwarded to the single command keyed by `args.action`, coupling
 * each action to exactly one command.
 *
 * - Unknown actions short-circuit with an "Unknown action" error and never
 *   touch the context (so no connection is opened).
 * - Errors thrown by a command are caught and formatted using the optional
 *   per-action `errorPrefixes` map (falling back to a generic message).
 * - Errors returned by a command (e.g. validation `errorResult`s) pass through
 *   unchanged.
 */
export async function dispatchAction(commands, context, args, errorPrefixes) {
    const command = commands[args.action];
    if (!command) {
        const supportedActions = Object.keys(commands).sort().join(", ");
        return errorResult(`Unknown action: ${args.action}. Supported actions: ${supportedActions}`);
    }
    try {
        return await command.execute(context, args);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error occurred";
        const prefix = errorPrefixes?.[args.action];
        return errorResult(prefix ? `${prefix}${message}` : `Error: ${message}`);
    }
}
