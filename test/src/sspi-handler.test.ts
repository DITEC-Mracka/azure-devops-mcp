// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Mock logger to avoid @azure/logger transitive dependency resolution issues in Jest
jest.mock("../../src/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { SspiRequestHandler, createSspiHandler } from "../../src/sspi-handler";

// Mock win-sso module
jest.mock("win-sso", () => ({
  WinSso: jest.fn().mockImplementation(() => ({
    createAuthRequestHeader: jest.fn().mockReturnValue("Negotiate TlRMTVNTUAABAAAA"),
    createAuthResponseHeader: jest.fn().mockReturnValue("Negotiate TlRMTVNTUAADAAAA"),
    freeAuthContext: jest.fn(),
  })),
  osSupported: jest.fn().mockReturnValue(true),
}));

describe("SspiRequestHandler", () => {
  let handler: SspiRequestHandler;

  beforeEach(() => {
    handler = new SspiRequestHandler("https://dev-tfs/tfs/internal_projects");
  });

  describe("prepareRequest", () => {
    it("should set Connection: keep-alive header", () => {
      const options = { headers: {} as Record<string, string> };
      handler.prepareRequest(options as any);
      expect(options.headers["Connection"]).toBe("keep-alive");
    });
  });

  describe("canHandleAuthentication", () => {
    it("should return true for 401 with WWW-Authenticate: Negotiate", () => {
      const response = {
        message: {
          statusCode: 401,
          headers: { "www-authenticate": "Negotiate" },
        },
      };
      expect(handler.canHandleAuthentication(response as any)).toBe(true);
    });

    it("should return true for 401 with WWW-Authenticate: NTLM", () => {
      const response = {
        message: {
          statusCode: 401,
          headers: { "www-authenticate": "NTLM" },
        },
      };
      expect(handler.canHandleAuthentication(response as any)).toBe(true);
    });

    it("should return false for 200 response", () => {
      const response = {
        message: {
          statusCode: 200,
          headers: {},
        },
      };
      expect(handler.canHandleAuthentication(response as any)).toBe(false);
    });

    it("should return false for 401 without WWW-Authenticate", () => {
      const response = {
        message: {
          statusCode: 401,
          headers: {},
        },
      };
      expect(handler.canHandleAuthentication(response as any)).toBe(false);
    });

    it("should return false for 401 with Basic auth only", () => {
      const response = {
        message: {
          statusCode: 401,
          headers: { "www-authenticate": 'Basic realm="server"' },
        },
      };
      expect(handler.canHandleAuthentication(response as any)).toBe(false);
    });
  });

  describe("handleAuthentication", () => {
    it("should perform Negotiate handshake and return response on success", async () => {
      const successResponse = {
        message: { statusCode: 200, headers: {} },
      };
      const mockHttpClient = {
        requestRaw: jest.fn().mockResolvedValue(successResponse),
      };
      const mockRequestInfo = {
        options: { headers: {} },
        parsedUrl: { hostname: "dev-tfs" },
      };

      const result = await handler.handleAuthentication(mockHttpClient as any, mockRequestInfo as any, "");
      expect(result.message.statusCode).toBe(200);
      expect(mockHttpClient.requestRaw).toHaveBeenCalledTimes(1);
    });

    it("should handle multi-round-trip NTLM handshake", async () => {
      const challengeResponse = {
        message: {
          statusCode: 401,
          headers: { "www-authenticate": "Negotiate TlRMTVNTUAACAAAA" },
        },
      };
      const successResponse = {
        message: { statusCode: 200, headers: {} },
      };
      const mockHttpClient = {
        requestRaw: jest.fn().mockResolvedValueOnce(challengeResponse).mockResolvedValueOnce(successResponse),
      };
      const mockRequestInfo = {
        options: { headers: {} },
        parsedUrl: { hostname: "dev-tfs" },
      };

      const result = await handler.handleAuthentication(mockHttpClient as any, mockRequestInfo as any, "");
      expect(result.message.statusCode).toBe(200);
      expect(mockHttpClient.requestRaw).toHaveBeenCalledTimes(2);
    });

    it("should throw when server rejects auth after max rounds", async () => {
      const rejectResponse = {
        message: {
          statusCode: 401,
          headers: { "www-authenticate": "Negotiate blob" },
        },
      };
      const mockHttpClient = {
        requestRaw: jest.fn().mockResolvedValue(rejectResponse),
      };
      const mockRequestInfo = {
        options: { headers: {} },
        parsedUrl: { hostname: "dev-tfs" },
      };

      await expect(handler.handleAuthentication(mockHttpClient as any, mockRequestInfo as any, "")).rejects.toThrow("SSPI authentication failed after multiple rounds");
    });
  });
});

describe("createSspiHandler", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("should reject on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(createSspiHandler("https://server/tfs/col")).rejects.toThrow("SSPI authentication is only available on Windows");
  });

  it("should create handler on Windows", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const handler = await createSspiHandler("https://server/tfs/col");
    expect(handler).toBeInstanceOf(SspiRequestHandler);
  });
});
