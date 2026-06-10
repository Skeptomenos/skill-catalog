import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export function isAuthorizedBearerRequest(req: Request, configuredToken: string | undefined): boolean {
  return isAuthorizedBearerHeader(req.header("authorization"), configuredToken);
}

export function isAuthorizedBearerHeader(header: string | undefined, configuredToken: string | undefined): boolean {
  if (configuredToken === undefined) {
    return true;
  }
  if (configuredToken.trim() === "") {
    return false;
  }

  const candidate = parseBearerToken(header);
  return candidate ? timingSafeStringEqual(candidate, configuredToken) : false;
}

function parseBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

function timingSafeStringEqual(candidate: string, expected: string): boolean {
  const candidateDigest = digest(candidate);
  const expectedDigest = digest(expected);
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
