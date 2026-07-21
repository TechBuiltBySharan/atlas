import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  decryptFlowsRequest,
  encryptFlowsRequest,
  encryptFlowsResponse,
  handleFlowsEndpoint,
} from "./flows-crypto.js";
import { generateFlowsKeyPair } from "@atlas/core";

describe("WhatsApp Flows crypto", () => {
  it("round-trips encrypt request → decrypt → encrypt response", () => {
    const { privateKeyPem, publicKeyPem } = generateFlowsKeyPair();
    const encrypted = encryptFlowsRequest(
      {
        version: "7.3",
        action: "data_exchange",
        screen: "DETAILS",
        flow_token: "tok_1",
        data: { name: "Ada" },
      },
      publicKeyPem,
    );
    const { action, aesKey, iv } = decryptFlowsRequest(encrypted, privateKeyPem);
    expect(action.data?.name).toBe("Ada");
    const responseB64 = encryptFlowsResponse(
      { version: "7.3", screen: "SUCCESS", data: { ok: true } },
      aesKey,
      iv,
    );
    expect(responseB64.length).toBeGreaterThan(20);
  });

  it("handleFlowsEndpoint answers ping", () => {
    const { privateKeyPem, publicKeyPem } = generateFlowsKeyPair();
    const body = encryptFlowsRequest({ version: "7.3", action: "ping" }, publicKeyPem);
    const out = handleFlowsEndpoint(body, privateKeyPem);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(10);
  });
});
