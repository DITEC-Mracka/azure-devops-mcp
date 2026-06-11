// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import http from "http";
import https from "https";
import net from "net";
import { logger } from "./logger.js";
/**
 * SSPI-based Negotiate/NTLM authentication handler for on-prem Azure DevOps Server.
 * Uses `win-sso` for Windows integrated authentication (SSPI).
 * Implements IRequestHandler from typed-rest-client for use with WebApi.
 *
 * Note: The handleAuthentication method performs the full NTLM/Negotiate handshake
 * using raw http(s) requests with a keep-alive agent to ensure the same TCP connection
 * is reused across all round-trips (required by NTLM).
 */
export class SspiRequestHandler {
    serverUrl;
    winSsoModule = null;
    isHttps;
    constructor(serverUrl) {
        this.serverUrl = serverUrl;
        this.isHttps = serverUrl.startsWith("https");
    }
    /**
     * Creates a fresh keep-alive agent for a single SSPI handshake.
     * Each handshake gets its own agent to avoid stale/closed sockets from prior calls.
     */
    createHandshakeAgent() {
        return this.isHttps
            ? new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" })
            : new http.Agent({ keepAlive: true, maxSockets: 1 });
    }
    /**
     * Dynamically loads the win-sso module. Throws a clear error if unavailable.
     */
    async loadWinSso() {
        if (this.winSsoModule)
            return this.winSsoModule;
        try {
            this.winSsoModule = await import("win-sso");
            return this.winSsoModule;
        }
        catch {
            throw new Error("SSPI authentication requires Windows and the win-sso package. " + "Use --authentication pat as a cross-platform alternative.");
        }
    }
    prepareRequest(options) {
        // Keep connection alive for multi-round-trip NTLM handshake
        options.headers = options.headers ?? {};
        options.headers["Connection"] = "keep-alive";
    }
    canHandleAuthentication(response) {
        if (response.message.statusCode !== 401)
            return false;
        const wwwAuth = response.message.headers["www-authenticate"];
        if (!wwwAuth)
            return false;
        const authHeader = wwwAuth.toLowerCase();
        return authHeader.includes("negotiate") || authHeader.includes("ntlm");
    }
    /**
     * Performs a raw HTTP(S) request using the keep-alive agent to maintain TCP connection.
     */
    rawRequest(url, method, headers, body, agent) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === "https:" ? 443 : 80),
                path: url.pathname + url.search,
                method,
                headers: { ...headers, Connection: "keep-alive" },
                agent,
            };
            const transport = url.protocol === "https:" ? https : http;
            const req = transport.request(options, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    resolve({
                        statusCode: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString("utf8"),
                    });
                });
            });
            req.setTimeout(30_000, () => {
                req.destroy(new Error("SSPI handshake request timed out after 30s"));
            });
            req.on("error", reject);
            if (body)
                req.write(body);
            req.end();
        });
    }
    async handleAuthentication(httpClient, requestInfo, objs) {
        const winSso = await this.loadWinSso();
        if (!winSso.osSupported()) {
            throw new Error("SSPI authentication is only available on Windows. " + "Use --authentication pat on other platforms.");
        }
        const requestUrl = new URL(requestInfo.parsedUrl.href);
        const targetHost = requestUrl.hostname;
        const method = requestInfo.options.method ?? "GET";
        const bodyStr = typeof objs === "string" ? objs : undefined;
        // Build headers from original request (excluding Authorization)
        const headers = {};
        if (requestInfo.options.headers) {
            for (const [key, value] of Object.entries(requestInfo.options.headers)) {
                if (key.toLowerCase() !== "authorization") {
                    headers[key] = value;
                }
            }
        }
        // Fresh agent per handshake — avoids stale sockets from prior calls (server may close after idle)
        const agent = this.createHandshakeAgent();
        let sso;
        try {
            sso = new winSso.WinSso("Negotiate", targetHost, undefined, undefined);
            // NTLM requires the entire handshake on the SAME TCP socket.
            // typed-rest-client already got a 401 on ITS socket, but we use our own fresh agent.
            // We must first send an unauthenticated probe on OUR socket to establish the connection,
            // then do the full Negotiate handshake on that same socket.
            const probeHeaders = { ...headers };
            delete probeHeaders["Authorization"];
            let response = await this.rawRequest(requestUrl, method, probeHeaders, bodyStr, agent);
            logger.debug(`SSPI probe on keepAlive socket: status=${response.statusCode}`);
            if (response.statusCode !== 401) {
                // Server didn't challenge — return as-is (unlikely but safe)
                const incomingMessage = new http.IncomingMessage(new net.Socket());
                incomingMessage.statusCode = response.statusCode;
                incomingMessage.headers = response.headers;
                incomingMessage.push(response.body);
                incomingMessage.push(null);
                const responseBody = response.body;
                return { message: incomingMessage, readBody: () => Promise.resolve(responseBody) };
            }
            // Now send Type1 token on the SAME socket (fresh agent ensures reuse)
            const authRequestHeader = sso.createAuthRequestHeader();
            headers["Authorization"] = authRequestHeader;
            response = await this.rawRequest(requestUrl, method, headers, bodyStr, agent);
            logger.debug(`SSPI handshake round 1 (Type1): status=${response.statusCode}`);
            // Multi-round-trip loop (NTLM requires Type1 → Type2 → Type3)
            let rounds = 0;
            const maxRounds = 5;
            while (response.statusCode === 401 && rounds < maxRounds) {
                const serverAuthHeader = response.headers["www-authenticate"];
                if (!serverAuthHeader) {
                    throw new Error("SSPI handshake failed: server returned 401 without WWW-Authenticate header.");
                }
                // Extract only the Negotiate part with token from potentially multi-scheme header
                const negotiatePart = serverAuthHeader
                    .split(",")
                    .map((s) => s.trim())
                    .find((s) => s.toLowerCase().startsWith("negotiate "));
                if (!negotiatePart) {
                    throw new Error("SSPI handshake failed: server did not return a Negotiate challenge token. " + `WWW-Authenticate: ${serverAuthHeader}`);
                }
                // Generate response token from server challenge
                const responseHeader = sso.createAuthResponseHeader(negotiatePart);
                if (!responseHeader) {
                    throw new Error("SSPI handshake failed: authentication was rejected by the server.");
                }
                headers["Authorization"] = responseHeader;
                response = await this.rawRequest(requestUrl, method, headers, bodyStr, agent);
                logger.debug(`SSPI handshake round ${rounds + 2}: status=${response.statusCode}`);
                rounds++;
            }
            if (response.statusCode === 401) {
                throw new Error("SSPI authentication failed after multiple rounds. " + "Verify the server accepts Negotiate/NTLM and the machine is domain-joined.");
            }
            // Convert raw response back to IHttpClientResponse format for typed-rest-client
            const incomingMessage = new http.IncomingMessage(new net.Socket());
            incomingMessage.statusCode = response.statusCode;
            incomingMessage.headers = response.headers;
            // Push the body data so consumers can read it
            incomingMessage.push(response.body);
            incomingMessage.push(null);
            const responseBody = response.body;
            return {
                message: incomingMessage,
                readBody() {
                    return Promise.resolve(responseBody);
                },
            };
        }
        catch (error) {
            if (error instanceof Error && error.message.startsWith("SSPI")) {
                throw error;
            }
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`SSPI authentication failed: ${msg}. ` + "Verify the machine is domain-joined and has network access to the server. " + "Use --authentication pat as a fallback.");
        }
        finally {
            if (sso) {
                try {
                    sso.freeAuthContext();
                }
                catch {
                    // Ignore cleanup errors
                }
            }
            agent.destroy();
        }
    }
}
/**
 * Creates an SSPI request handler for the given server URL.
 * Validates platform support before returning.
 */
export async function createSspiHandler(serverUrl) {
    // Validate platform early
    if (process.platform !== "win32") {
        throw new Error("SSPI authentication is only available on Windows. " + "Use --authentication pat on other platforms.");
    }
    // Validate win-sso is loadable
    try {
        const winSso = await import("win-sso");
        if (!winSso.osSupported()) {
            throw new Error("OS not supported");
        }
        logger.debug("SSPI: win-sso loaded successfully, platform supported");
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`SSPI authentication unavailable: ${msg}. ` + "Use --authentication pat as a fallback.");
    }
    return new SspiRequestHandler(serverUrl);
}
