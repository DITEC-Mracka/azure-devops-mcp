#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getBearerHandler, getPersonalAccessTokenHandler, WebApi } from "azure-devops-node-api";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createAuthenticator } from "./auth.js";
import { logger } from "./logger.js";
import { getOrgTenant } from "./org-tenants.js";
//import { configurePrompts } from "./prompts.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";
import { DomainsManager } from "./shared/domains.js";
import { resolveOrgUrl } from "./utils.js";

function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}

const defaultAuthenticationType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
  .scriptName("mcp-server-azuredevops")
  .usage("Usage: $0 <organization> [options]")
  .version(packageVersion)
  .command("$0 <organization> [options]", "Azure DevOps MCP Server", (yargs) => {
    yargs.positional("organization", {
      describe: "Azure DevOps organization name",
      type: "string",
      demandOption: true,
    });
  })
  .option("domains", {
    alias: "d",
    describe: "Domain(s) to enable: 'all' for everything, or specific domains like 'repositories builds work'. Defaults to 'all'.",
    type: "string",
    array: true,
    default: "all",
  })
  .option("authentication", {
    alias: "a",
    describe: "Type of authentication to use",
    type: "string",
    choices: ["interactive", "azcli", "env", "envvar", "pat"],
    default: defaultAuthenticationType,
  })
  .option("tenant", {
    alias: "t",
    describe: "Azure tenant ID (optional, applied when using 'interactive' and 'azcli' type of authentication)",
    type: "string",
  })
  .option("allow-untrusted-cert", {
    describe: "Disable TLS certificate verification (sets NODE_TLS_REJECT_UNAUTHORIZED=0). Use only as last resort for self-signed certs.",
    type: "boolean",
    default: false,
  })
  .option("allow-http", {
    describe: "Allow http:// URLs (insecure). Required when connecting to on-prem servers without TLS.",
    type: "boolean",
    default: false,
  })
  .help()
  .parseSync();

export const orgName = argv.organization as string;

// --- URL detection: cloud vs on-prem mode ---
let orgUrl: string;
let isOnPrem = false;

try {
  const resolved = resolveOrgUrl(orgName, argv.allowHttp as boolean);
  orgUrl = resolved.orgUrl;
  isOnPrem = resolved.isOnPrem;
} catch (error) {
  logger.error((error as Error).message);
  process.exit(1);
}

// TLS and HTTP warnings
if (argv.allowUntrustedCert) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  logger.warn("WARNING: TLS certificate verification is disabled (--allow-untrusted-cert). This is insecure and affects all connections in this process.");
}
if (argv.allowHttp && argv.authentication === "pat") {
  logger.warn("WARNING: Using PAT authentication over HTTP. Credentials will travel in cleartext over the network.");
}

export { orgUrl, isOnPrem };

const domainsManager = new DomainsManager(argv.domains);
export const enabledDomains = domainsManager.getEnabledDomains();

function getAzureDevOpsClient(getAzureDevOpsToken: () => Promise<string>, userAgentComposer: UserAgentComposer, authType: string): () => Promise<WebApi> {
  return async () => {
    const accessToken = await getAzureDevOpsToken();
    // For pat, accessToken is base64("{email}:{token}"). Decode to extract the token part,
    // since getPersonalAccessTokenHandler prepends ":" internally and just needs the raw token.
    const authHandler = authType === "pat" ? getPersonalAccessTokenHandler(Buffer.from(accessToken, "base64").toString("utf8").split(":").slice(1).join(":")) : getBearerHandler(accessToken);
    const connection = new WebApi(orgUrl, authHandler, undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
    return connection;
  };
}

async function main() {
  logger.info("Starting Azure DevOps MCP Server", {
    organization: orgName,
    organizationUrl: orgUrl,
    mode: isOnPrem ? "on-prem" : "cloud",
    authentication: argv.authentication,
    tenant: argv.tenant,
    domains: argv.domains,
    enabledDomains: Array.from(enabledDomains),
    version: packageVersion,
    isCodespace: isGitHubCodespaceEnv(),
  });

  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
    icons: [
      {
        src: "https://cdn.vsassets.io/content/icons/favicon.ico",
      },
    ],
  });

  const userAgentComposer = new UserAgentComposer(packageVersion);
  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };
  const tenantId = isOnPrem ? argv.tenant : ((await getOrgTenant(orgName)) ?? argv.tenant);
  const authenticator = createAuthenticator(argv.authentication, tenantId);

  if (argv.authentication === "pat") {
    const basicValue = await authenticator();
    // basicValue is already base64("{email}:{token}") — use it directly in the Authorization header
    const _originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.headers) {
        const headers = new Headers(init.headers as HeadersInit);
        if (headers.get("Authorization")?.startsWith("Bearer ")) {
          headers.set("Authorization", `Basic ${basicValue}`);
          init = { ...init, headers };
        }
      }
      return _originalFetch(input, init);
    };
    logger.debug("PAT mode: global fetch interceptor installed to rewrite Bearer -> Basic auth headers");
  }

  // removing prompts until further notice
  // configurePrompts(server);

  configureAllTools(server, authenticator, getAzureDevOpsClient(authenticator, userAgentComposer, argv.authentication), () => userAgentComposer.userAgent, enabledDomains);

  // On-prem startup connection check — fail fast on misconfiguration
  if (isOnPrem) {
    try {
      const checkUrl = `${orgUrl}/_apis/connectionData`;
      const token = await authenticator();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": userAgentComposer.userAgent,
      };
      if (argv.authentication === "pat") {
        headers["Authorization"] = `Basic ${token}`;
      } else {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const response = await fetch(checkUrl, { method: "GET", headers });
      if (!response.ok) {
        logger.error(`On-prem connection check failed: HTTP ${response.status} ${response.statusText} from ${checkUrl}`);
        process.exit(1);
      }
      const data = (await response.json()) as { deploymentType?: string; serverVersion?: string };
      logger.info("On-prem connection verified", {
        serverUrl: orgUrl,
        serverVersion: data.serverVersion ?? "unknown",
        deploymentType: data.deploymentType ?? "unknown",
      });
    } catch (error) {
      logger.error("On-prem connection check failed — cannot reach server. Verify the URL is correct and the server is reachable.", error);
      process.exit(1);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});
