import { verifyUpdateTarget } from "./update-target.mjs";
import { UPDATE_REVIEW_THRESHOLD } from "./update-review.mjs";

function updateResult(result) {
  if (!result || Array.isArray(result) || !Number.isInteger(result.affectedRows)) {
    throw new Error("数据库没有返回有效的 UPDATE 影响行数。");
  }
  return {
    affectedRows: result.affectedRows,
    changedRows: Number.isInteger(result.changedRows) ? result.changedRows : null,
    warningStatus: Number.isInteger(result.warningStatus) ? result.warningStatus : null,
  };
}

export async function runGuardedUpdateTransaction({
  connection,
  sql,
  params,
  timeoutMs,
  approvedAffectedRows,
}) {
  let transactionStarted = false;
  let committed = false;
  let outcome;
  let primaryError;
  try {
    await connection.query("SET SESSION TRANSACTION READ WRITE");
    await connection.beginTransaction();
    transactionStarted = true;
    await verifyUpdateTarget(connection, sql, timeoutMs);
    const [rawResult] = await connection.query({ sql, timeout: timeoutMs }, params);
    const result = updateResult(rawResult);

    const needsInitialReview = approvedAffectedRows === undefined
      && result.affectedRows > UPDATE_REVIEW_THRESHOLD;
    const changedSinceReview = approvedAffectedRows !== undefined
      && result.affectedRows !== approvedAffectedRows;

    if (needsInitialReview || changedSinceReview) {
      await connection.rollback();
      transactionStarted = false;
      outcome = {
        status: "review_required",
        ...result,
        changedSinceReview,
      };
    } else {
      await connection.commit();
      transactionStarted = false;
      committed = true;
      outcome = {
        status: "committed",
        ...result,
        reviewed: approvedAffectedRows !== undefined,
      };
    }
  } catch (error) {
    primaryError = error;
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch {
        connection.destroy?.();
      }
    }
    throw error;
  } finally {
    try {
      await connection.query("SET SESSION TRANSACTION READ ONLY");
    } catch {
      connection.destroy?.();
      if (!committed && !outcome && !primaryError) {
        throw new Error("无法恢复连接的只读会话状态，连接已销毁。");
      }
      if (outcome) outcome.connectionRecycled = true;
    }
  }
  return outcome;
}
