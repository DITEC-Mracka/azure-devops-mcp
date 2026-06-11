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
import { createSspiHandler, SspiRequestHandler } from "./sspi-handler.js";
//import { configurePrompts } from "./prompts.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";
import { DomainsManager } from "./shared/domains.js";
import { resolveOrgUrl } from "./utils.js";
import { Agent as UndiciAgent } from "undici";

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
    choices: ["interactive", "azcli", "env", "envvar", "pat", "sspi"],
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

// TLS certificate override
if (argv.allowUntrustedCert) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  logger.warn("WARNING: TLS certificate verification is disabled (--allow-untrusted-cert). This is insecure and affects all connections in this process.");
}

// HTTP/1.1 agent for on-prem servers (IIS often doesn't support HTTP/2 correctly)
const onPremDispatcher = isOnPrem ? new UndiciAgent({ allowH2: false }) : undefined;

// SSPI auto-selection: on-prem + Windows + no explicit auth override → sspi
const authExplicitlySet = process.argv.some((a) => a === "--authentication" || a === "-a" || a.startsWith("--authentication=") || a.startsWith("-a="));
let effectiveAuthType = argv.authentication as string;
if (isOnPrem && process.platform === "win32" && !authExplicitlySet) {
  effectiveAuthType = "sspi";
  logger.info("On-prem URL detected on Windows — using SSPI authentication (override with --authentication pat)");
}

if (argv.allowHttp && effectiveAuthType === "pat") {
  logger.warn("WARNING: Using PAT authentication over HTTP. Credentials will travel in cleartext over the network.");
}

// Platform guard: sspi only on Windows
if (effectiveAuthType === "sspi" && process.platform !== "win32") {
  logger.error("SSPI authentication is only available on Windows. Use --authentication pat instead.");
  process.exit(1);
}

export { orgUrl, isOnPrem };

const domainsManager = new DomainsManager(argv.domains);
export const enabledDomains = domainsManager.getEnabledDomains();

let sspiHandler: SspiRequestHandler | null = null;

function getAzureDevOpsClient(getAzureDevOpsToken: () => Promise<string>, userAgentComposer: UserAgentComposer, authType: string): () => Promise<WebApi> {
  return async () => {
    if (authType === "sspi") {
      if (!sspiHandler) {
        sspiHandler = await createSspiHandler(orgUrl);
      }
      const connection = new WebApi(orgUrl, sspiHandler, undefined, {
        productName: "AzureDevOps.MCP",
        productVersion: packageVersion,
        userAgent: userAgentComposer.userAgent,
      });
      return connection;
    }
    const accessToken = await getAzureDevOpsToken();
    // For pat, accessToken is base64("{email}:{token}"). Decode to extract the token part,
    // since getPersonalAccessTokenHandler prepends ":" internally and just needs the raw token.
    let authHandler;
    if (authType === "pat") {
      const decoded = Buffer.from(accessToken, "base64").toString("utf8");
      const colonIdx = decoded.indexOf(":");
      const rawPat = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
      authHandler = getPersonalAccessTokenHandler(rawPat);
    } else {
      authHandler = getBearerHandler(accessToken);
    }
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
    authentication: effectiveAuthType,
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
  const authenticator = createAuthenticator(effectiveAuthType, tenantId);

  if (effectiveAuthType === "pat") {
    const basicValue = await authenticator();
    // basicValue is already base64("{email}:{token}") — use it directly in the Authorization header
    const _originalFetch = globalThis.fetch;
    const orgOrigin = new URL(orgUrl).origin;
    const isAdoRequest = (url: string) => url.startsWith(orgOrigin) || (!isOnPrem && url.startsWith("https://almsearch.dev.azure.com/"));
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (isAdoRequest(requestUrl)) {
        const headers = new Headers(init?.headers as HeadersInit | undefined);
        if (headers.get("Authorization")?.startsWith("Bearer ")) {
          headers.set("Authorization", `Basic ${basicValue}`);
          init = { ...init, headers };
        }
      }
      return _originalFetch(input, init);
    };
    logger.debug("PAT mode: global fetch interceptor installed to rewrite Bearer -> Basic auth headers (scoped to ADO URLs)");
  } else if (effectiveAuthType === "sspi") {
    // SSPI fetch interceptor: perform Negotiate/NTLM handshake for raw fetch calls to the on-prem server
    const _originalFetch = globalThis.fetch;
    const orgOrigin = new URL(orgUrl).origin;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!requestUrl.startsWith(orgOrigin)) {
        return _originalFetch(input, init);
      }

      // Force HTTP/1.1 for on-prem (IIS often rejects HTTP/2)
      const fetchOpts = { ...init, dispatcher: onPremDispatcher } as RequestInit;

      // Make initial request without auth header (avoid sending malformed 'Bearer ')
      const probeHeaders = new Headers(init?.headers);
      probeHeaders.delete("Authorization");
      let response = await _originalFetch(input, { ...fetchOpts, headers: probeHeaders });
      if (response.status !== 401) return response;

      // Check for Negotiate/NTLM challenge
      const wwwAuth = response.headers.get("www-authenticate");
      if (!wwwAuth || (!wwwAuth.toLowerCase().includes("negotiate") && !wwwAuth.toLowerCase().includes("ntlm"))) {
        return response;
      }

      // Drain probe response body to free TCP connection for handshake
      await response.body?.cancel();

      // Perform SSPI handshake
      const winSso = await import("win-sso");
      const targetHost = new URL(requestUrl).hostname;
      const sso = new winSso.WinSso("Negotiate", targetHost, undefined, undefined);

      try {
        const authHeader = sso.createAuthRequestHeader();
        const headers = new Headers(init?.headers);
        headers.set("Authorization", authHeader);
        headers.set("Connection", "keep-alive");

        response = await _originalFetch(input, { ...fetchOpts, headers });

        // Multi-round-trip loop for NTLM (Type1 → Type2 → Type3)
        let rounds = 0;
        while (response.status === 401 && rounds < 5) {
          const serverAuth = response.headers.get("www-authenticate");
          if (!serverAuth) break;
          // Extract only the Negotiate token from potentially multi-scheme header
          // e.g. "Bearer, Basic realm=..., Negotiate YII..., NTLM" → "Negotiate YII..."
          const negotiatePart = serverAuth
            .split(",")
            .map((s) => s.trim())
            .find((s) => s.toLowerCase().startsWith("negotiate "));
          if (!negotiatePart) break;
          const responseHeader = sso.createAuthResponseHeader(negotiatePart);
          if (!responseHeader) break;
          await response.body?.cancel();
          headers.set("Authorization", responseHeader);
          response = await _originalFetch(input, { ...fetchOpts, headers });
          rounds++;
        }

        return response;
      } finally {
        try {
          sso.freeAuthContext();
        } catch {
          /* ignore cleanup errors */
        }
      }
    };
    logger.debug("SSPI mode: global fetch interceptor installed for Negotiate auth (scoped to on-prem server)");
  }

  // removing prompts until further notice
  // configurePrompts(server);

  configureAllTools(server, authenticator, getAzureDevOpsClient(authenticator, userAgentComposer, effectiveAuthType), () => userAgentComposer.userAgent, enabledDomains);

  // On-prem startup connection check — fail fast on misconfiguration
  if (isOnPrem) {
    try {
      const checkUrl = `${orgUrl}/_apis/connectionData`;

      if (effectiveAuthType === "sspi") {
        // For SSPI, verify server is reachable (actual auth happens via WebApi on first API call)
        const response = await fetch(checkUrl, {
          method: "GET",
          headers: { "Content-Type": "application/json", "User-Agent": userAgentComposer.userAgent },
          signal: AbortSignal.timeout(10_000),
        });
        // If fetch without auth returns 401, that's expected (SSPI will handle it on actual API calls via WebApi)
        // We just verify the server is reachable
        if (response.status !== 401 && !response.ok) {
          logger.error(`On-prem connection check failed: HTTP ${response.status} ${response.statusText} from ${checkUrl}`);
          process.exit(1);
        }
        // Try to get server version if accessible
        if (response.ok) {
          const data = (await response.json()) as { deploymentType?: string; serverVersion?: string };
          logger.info("On-prem connection verified (SSPI)", {
            serverUrl: orgUrl,
            serverVersion: data.serverVersion ?? "unknown",
            deploymentType: data.deploymentType ?? "unknown",
          });
        } else {
          logger.info("On-prem server reachable (SSPI auth will negotiate on first API call)", { serverUrl: orgUrl });
        }
        // Validate SSPI handler can be created (catches domain-join issues early)
        if (!sspiHandler) {
          sspiHandler = await createSspiHandler(orgUrl);
        }
      } else {
        const token = await authenticator();
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "User-Agent": userAgentComposer.userAgent,
        };
        if (effectiveAuthType === "pat") {
          headers["Authorization"] = `Basic ${token}`;
        } else {
          headers["Authorization"] = `Bearer ${token}`;
        }
        const response = await fetch(checkUrl, { method: "GET", headers, signal: AbortSignal.timeout(10_000), dispatcher: onPremDispatcher } as RequestInit);
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
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("SSPI")) {
        logger.error(`SSPI authentication failed: ${error.message}`);
      } else {
        logger.error("On-prem connection check failed — cannot reach server. Verify the URL is correct and the server is reachable.", error);
      }
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
