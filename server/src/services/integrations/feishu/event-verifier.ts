import { createHash, timingSafeEqual } from "node:crypto";
import { badRequest } from "../../../errors.js";

type HeaderBag = Record<string, string | string[] | undefined>;

export type FeishuEventVerificationInput = {
  body: Record<string, unknown>;
  headers: HeaderBag;
  rawBody?: Buffer | string | null;
  verificationToken?: string | null;
  encryptKey?: string | null;
};

export type FeishuEventVerificationResult =
  | { kind: "event" }
  | { kind: "challenge"; challenge: string };

function firstHeader(headers: HeaderBag, name: string) {
  const exact = headers[name];
  const lower = headers[name.toLowerCase()];
  const value = exact ?? lower;
  return Array.isArray(value) ? value[0] : value;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function payloadToken(body: Record<string, unknown>) {
  const header = body.header && typeof body.header === "object" ? body.header as Record<string, unknown> : null;
  return stringField(body.token) ?? stringField(header?.token);
}

export function createFeishuCallbackSignature(input: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  rawBody: Buffer | string;
}) {
  return createHash("sha256")
    .update(input.timestamp)
    .update(input.nonce)
    .update(input.encryptKey)
    .update(input.rawBody)
    .digest("hex");
}

export function hasFeishuCallbackVerificationSignal(body: Record<string, unknown>, headers: HeaderBag) {
  return Boolean(
    stringField(body.type)
    || stringField(body.challenge)
    || payloadToken(body)
    || stringField(body.mockVerificationToken)
    || stringField(body.mockEncryptKey)
    || firstHeader(headers, "x-lark-request-timestamp")
    || firstHeader(headers, "x-lark-request-nonce")
    || firstHeader(headers, "x-lark-signature"),
  );
}

export function verifyFeishuEventCallback(input: FeishuEventVerificationInput): FeishuEventVerificationResult {
  const verificationToken = stringField(input.verificationToken);
  const encryptKey = stringField(input.encryptKey);

  if (verificationToken) {
    const token = payloadToken(input.body);
    if (!token || !safeEqual(token, verificationToken)) {
      throw badRequest("Invalid Feishu callback verification token");
    }
  }

  if (encryptKey) {
    const timestamp = firstHeader(input.headers, "x-lark-request-timestamp");
    const nonce = firstHeader(input.headers, "x-lark-request-nonce");
    const signature = firstHeader(input.headers, "x-lark-signature");
    if (!timestamp || !nonce || !signature) {
      throw badRequest("Missing Feishu callback signature headers");
    }
    const rawBody = input.rawBody;
    if (!rawBody) {
      throw badRequest("Missing raw Feishu callback body");
    }
    const expected = createFeishuCallbackSignature({ timestamp, nonce, encryptKey, rawBody });
    if (!safeEqual(signature, expected)) {
      throw badRequest("Invalid Feishu callback signature");
    }
  }

  const challenge = stringField(input.body.challenge);
  if (input.body.type === "url_verification" && challenge) {
    return { kind: "challenge", challenge };
  }

  return { kind: "event" };
}
