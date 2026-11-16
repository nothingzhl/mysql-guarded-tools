import { createHash, randomBytes } from "node:crypto";

export const UPDATE_REVIEW_THRESHOLD = 10;
export const UPDATE_REVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_REVIEWS = 100;

function fingerprint(payload) {
  return createHash("sha256")
    .update(JSON.stringify({
      connection: payload.connection,
      sql: payload.sql,
      params: payload.params,
    }))
    .digest("hex");
}

export class UpdateReviewStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.pending = new Map();
  }

  cleanup() {
    const current = this.now();
    for (const [token, review] of this.pending) {
      if (review.expiresAt <= current) this.pending.delete(token);
    }
  }

  issue(payload, affectedRows) {
    this.cleanup();
    while (this.pending.size >= MAX_PENDING_REVIEWS) {
      this.pending.delete(this.pending.keys().next().value);
    }
    const token = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + UPDATE_REVIEW_TTL_MS;
    this.pending.set(token, {
      fingerprint: fingerprint(payload),
      affectedRows,
      expiresAt,
    });
    return { token, expiresAt };
  }

  consume(token, payload) {
    this.cleanup();
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("review_token 必须是非空字符串。");
    }
    const review = this.pending.get(token);
    this.pending.delete(token);
    if (!review) {
      throw new Error("审查令牌不存在、已过期或已经使用。请重新执行 UPDATE 预审。 ");
    }
    if (review.fingerprint !== fingerprint(payload)) {
      throw new Error("审查令牌与当前连接、SQL 或参数不匹配。请重新执行 UPDATE 预审。");
    }
    return review;
  }

  clear() {
    this.pending.clear();
  }

  size() {
    this.cleanup();
    return this.pending.size;
  }
}
