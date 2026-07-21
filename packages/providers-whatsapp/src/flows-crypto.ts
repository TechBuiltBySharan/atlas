/**
 * WhatsApp Flows encryption — Meta-compatible AES-128-GCM + RSA-OAEP-SHA256.
 * Mirrors Sociatribe src/lib/whatsapp/flows.ts protocol.
 */
import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";

export type FlowsEncryptedBody = {
  encrypted_aes_key: string;
  encrypted_flow_data: string;
  initial_vector: string;
};

export type FlowAction = {
  version: string;
  action: string;
  screen?: string;
  data?: Record<string, unknown>;
  flow_token?: string;
};

export function decryptFlowsRequest(
  body: FlowsEncryptedBody,
  privateKeyPem: string,
): { action: FlowAction; aesKey: Buffer; iv: Buffer } {
  const privateKey = createPrivateKey(privateKeyPem);
  const aesKey = privateDecrypt(
    { key: privateKey, oaepHash: "sha256", padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(body.encrypted_aes_key, "base64"),
  );
  const iv = Buffer.from(body.initial_vector, "base64");
  const encryptedData = Buffer.from(body.encrypted_flow_data, "base64");
  const authTag = encryptedData.subarray(encryptedData.length - 16);
  const ciphertext = encryptedData.subarray(0, encryptedData.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const action = JSON.parse(decrypted.toString("utf8")) as FlowAction;
  return { action, aesKey, iv };
}

export function encryptFlowsResponse(
  response: { version?: string; screen?: string; data: Record<string, unknown> },
  aesKey: Buffer,
  iv: Buffer,
): string {
  const flippedIv = Buffer.from(iv.map((b) => b ^ 0xff));
  const cipher = createCipheriv("aes-128-gcm", aesKey, flippedIv);
  const plaintext = Buffer.from(JSON.stringify(response), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([encrypted, authTag]).toString("base64");
}

/** Encrypt a plaintext Flow action as Meta would, for posting to a consumer Flows endpoint. */
export function encryptFlowsRequest(
  action: FlowAction,
  publicKeyPem: string,
): FlowsEncryptedBody {
  const aesKey = randomBytes(16);
  const iv = randomBytes(12);
  const publicKey = createPublicKey(publicKeyPem);
  const encryptedAesKey = publicEncrypt(
    { key: publicKey, oaepHash: "sha256", padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING },
    aesKey,
  );
  const cipher = createCipheriv("aes-128-gcm", aesKey, iv);
  const plaintext = Buffer.from(JSON.stringify(action), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted_aes_key: encryptedAesKey.toString("base64"),
    encrypted_flow_data: Buffer.concat([encrypted, authTag]).toString("base64"),
    initial_vector: iv.toString("base64"),
  };
}

export function handleFlowsEndpoint(
  body: FlowsEncryptedBody,
  privateKeyPem: string,
): string {
  const { action, aesKey, iv } = decryptFlowsRequest(body, privateKeyPem);
  if (action.action === "ping") {
    return encryptFlowsResponse({ version: action.version ?? "7.3", data: { status: "active" } }, aesKey, iv);
  }
  // Generic acknowledgement — consumer-specific screens stay on the consumer
  return encryptFlowsResponse(
    {
      version: action.version ?? "7.3",
      screen: "SUCCESS",
      data: {
        extension_message_response: {
          params: { flow_token: action.flow_token ?? "atlas" },
        },
      },
    },
    aesKey,
    iv,
  );
}
