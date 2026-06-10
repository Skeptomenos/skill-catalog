import type { Request, Response } from "express";
import type { RateLimitConfig } from "../types.js";

export type RateLimitMiddleware = (req: Request, res: Response) => boolean;
export type RateLimitResponder = (res: Response) => void;

export function createInMemoryRateLimiter(
  limit: RateLimitConfig,
  respond: RateLimitResponder
): RateLimitMiddleware {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (req, res) => {
    if (!limit.enabled) {
      return true;
    }

    const now = Date.now();
    const key = clientKey(req);
    if (!buckets.has(key) && buckets.size >= limit.maxEntries) {
      pruneExpiredBuckets(buckets, now);
      if (buckets.size >= limit.maxEntries) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey) {
          buckets.delete(oldestKey);
        }
      }
    }

    const existing = buckets.get(key);
    const bucket =
      existing && existing.resetAt > now
        ? existing
        : {
            count: 0,
            resetAt: now + limit.windowMs
          };

    bucket.count += 1;
    buckets.set(key, bucket);

    if (bucket.count <= limit.maxRequests) {
      return true;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    respond(res);
    return false;
  };
}

function pruneExpiredBuckets(buckets: Map<string, { count: number; resetAt: number }>, now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}
