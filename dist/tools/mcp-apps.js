// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
const MCP_APPS_TOOLS = {
    ping: "mcp_apps_ping",
};
function configureMcpAppsTools(server) {
    server.tool(MCP_APPS_TOOLS.ping, "A simple ping tool to verify that the mcp-apps domain is enabled.", {}, async () => {
        try {
            return {
                content: [{ type: "text", text: "pong — mcp-apps domain is active" }],
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
                isError: true,
            };
        }
    });
}
export { configureMcpAppsTools, MCP_APPS_TOOLS };
