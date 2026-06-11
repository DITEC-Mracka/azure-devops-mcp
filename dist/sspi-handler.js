// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { logger } from "./logger.js";
/**
 * SSPI-based Negotiate/NTLM authentication handler for on-prem Azure DevOps Server.
 * Uses `win-sso` for Windows integrated authentication (SSPI).
 * Implements IRequestHandler from typed-rest-client for use with WebApi.
 */
export class SspiRequestHandler {
    serverUrl;
    winSsoModule = null;
    constructor(serverUrl) {
        this.serverUrl = serverUrl;
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
            throw new Error("SSPI authentication requires Windows and the win-sso package. " +
                "Use --authentication pat as a cross-platform alternative.");
        }
    }
    prepareRequest(options) {
        // No-op — authentication is handled via canHandleAuthentication/handleAuthentication cycle
        // Keep connection alive for multi-round-trip NTLM handshake
        if (options.headers) {
            options.headers["Connection"] = "keep-alive";
        }
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
    async handleAuthentication(httpClient, requestInfo, objs) {
        const winSso = await this.loadWinSso();
        if (!winSso.osSupported()) {
            throw new Error("SSPI authentication is only available on Windows. " +
                "Use --authentication pat on other platforms.");
        }
        // Extract target hostname for SPN
        const targetHost = requestInfo.parsedUrl.hostname ?? new URL(this.serverUrl).hostname;
        // Extract TLS peer certificate for EPA (channel binding)
        let peerCert;
        // The peer certificate is not directly accessible from the typed-rest-client interface,
        // so EPA will be available when we can obtain the cert from the underlying socket.
        // For now, pass undefined — EPA requires socket-level access which will be enhanced later.
        let sso;
        try {
            sso = new winSso.WinSso("Negotiate", targetHost, peerCert, undefined);
            // Round 1: Send initial Negotiate token
            const authRequestHeader = sso.createAuthRequestHeader();
            if (!requestInfo.options.headers) {
                requestInfo.options.headers = {};
            }
            requestInfo.options.headers["Authorization"] = authRequestHeader;
            let response = await httpClient.requestRaw(requestInfo, objs);
            // Multi-round-trip loop (NTLM requires Type1 → Type2 → Type3)
            let rounds = 0;
            const maxRounds = 5; // Safety limit
            while (response.message.statusCode === 401 && rounds < maxRounds) {
                const serverAuthHeader = response.message.headers["www-authenticate"];
                if (!serverAuthHeader) {
                    throw new Error("SSPI handshake failed: server returned 401 without WWW-Authenticate header.");
                }
                // Generate response token from server challenge
                const responseHeader = sso.createAuthResponseHeader(serverAuthHeader);
                if (!responseHeader) {
                    // Empty response means handshake is complete on client side but server still returned 401
                    throw new Error("SSPI handshake failed: authentication was rejected by the server.");
                }
                requestInfo.options.headers["Authorization"] = responseHeader;
                response = await httpClient.requestRaw(requestInfo, objs);
                rounds++;
            }
            if (response.message.statusCode === 401) {
                throw new Error("SSPI authentication failed after multiple rounds. " +
                    "Verify the server accepts Negotiate/NTLM and the machine is domain-joined.");
            }
            return response;
        }
        catch (error) {
            if (error instanceof Error && error.message.startsWith("SSPI")) {
                throw error; // Re-throw our own errors
            }
            // Wrap win-sso errors with context
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`SSPI authentication failed: ${msg}. ` +
                "Verify the machine is domain-joined and has network access to the server. " +
                "Use --authentication pat as a fallback.");
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
        throw new Error("SSPI authentication is only available on Windows. " +
            "Use --authentication pat on other platforms.");
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
        throw new Error(`SSPI authentication unavailable: ${msg}. ` +
            "Use --authentication pat as a fallback.");
    }
    return new SspiRequestHandler(serverUrl);
}
