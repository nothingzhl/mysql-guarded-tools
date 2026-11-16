const ALLOWED_FIRST_KEYWORDS = new Set([
  "SELECT",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "EXPLAIN",
  "WITH",
]);

const MAX_SQL_LENGTH = 65536;

const BLOCKED_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "MERGE",
  "UPSERT",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "GRANT",
  "REVOKE",
  "CALL",
  "DO",
  "SET",
  "USE",
  "LOCK",
  "UNLOCK",
  "FLUSH",
  "RESET",
  "ANALYZE",
  "OPTIMIZE",
  "REPAIR",
  "INSTALL",
  "UNINSTALL",
  "LOAD",
  "HANDLER",
  "PREPARE",
  "PROCEDURE",
  "EXECUTE",
  "DEALLOCATE",
  "BEGIN",
  "START",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "XA",
  "KILL",
  "SHUTDOWN",
]);

const BLOCKED_FUNCTIONS = new Set([
  "BENCHMARK",
  "GET_LOCK",
  "IS_FREE_LOCK",
  "IS_USED_LOCK",
  "LOAD_FILE",
  "MASTER_POS_WAIT",
  "RELEASE_ALL_LOCKS",
  "RELEASE_LOCK",
  "SLEEP",
  "SYS_EXEC",
  "SYS_EVAL",
]);

function scanSql(sql) {
  let sanitized = "";
  let semicolonPositions = [];
  let state = "normal";

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (state === "single") {
      if (char === "\\") {
        sanitized += "  ";
        index += 1;
      } else if (char === "'" && next === "'") {
        sanitized += "  ";
        index += 1;
      } else if (char === "'") {
        state = "normal";
        sanitized += " ";
      } else {
        sanitized += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "double") {
      if (char === "\\") {
        sanitized += "  ";
        index += 1;
      } else if (char === '"' && next === '"') {
        sanitized += "  ";
        index += 1;
      } else if (char === '"') {
        state = "normal";
        sanitized += " ";
      } else {
        sanitized += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "backtick") {
      if (char === "`" && next === "`") {
        sanitized += "  ";
        index += 1;
      } else if (char === "`") {
        state = "normal";
        sanitized += " ";
      } else {
        sanitized += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (char === "'") {
      state = "single";
      sanitized += " ";
      continue;
    }
    if (char === '"') {
      state = "double";
      sanitized += " ";
      continue;
    }
    if (char === "`") {
      state = "backtick";
      sanitized += " ";
      continue;
    }

    const startsDashComment = char === "-" && next === "-" && /\s/.test(sql[index + 2] ?? "");
    if (startsDashComment || char === "#" || (char === "/" && next === "*")) {
      throw new Error("不允许在 SQL 中使用注释，以防隐藏或拼接修改语句。");
    }

    if (char === ";") {
      semicolonPositions.push(index);
    }
    sanitized += char;
  }

  if (state !== "normal") {
    throw new Error("SQL 中存在未闭合的字符串或标识符。");
  }

  return { sanitized, semicolonPositions };
}

function normalizeSingleStatement(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("sql 必须是非空字符串。");
  }
  if (Buffer.byteLength(input, "utf8") > MAX_SQL_LENGTH) {
    throw new Error(`SQL 不能超过 ${MAX_SQL_LENGTH} 字节。`);
  }

  const sql = input.trim();
  const { sanitized, semicolonPositions } = scanSql(sql);
  if (semicolonPositions.length > 1) {
    throw new Error("只允许执行单条 SQL，不能使用多语句。");
  }
  if (semicolonPositions.length === 1) {
    const tail = sql.slice(semicolonPositions[0] + 1).trim();
    if (tail !== "") {
      throw new Error("只允许执行单条 SQL，分号只能出现在语句末尾。");
    }
  }

  return {
    sql: sql.replace(/;\s*$/, "").trim(),
    sanitized: sanitized.replace(/;\s*$/, "").trim(),
  };
}

function topLevelWords(sql) {
  const words = [];
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z_]/.test(sql[end])) end += 1;
      if (depth === 0) words.push(sql.slice(index, end).toUpperCase());
      index = end;
      continue;
    }
    index += 1;
  }
  return words;
}

export function validateReadOnlySql(input) {
  const { sql: withoutTrailingSemicolon, sanitized: sanitizedWithoutTrailingSemicolon } = normalizeSingleStatement(input);
  const words = sanitizedWithoutTrailingSemicolon.toUpperCase().match(/[A-Z_]+/g) ?? [];
  const firstKeyword = words[0];

  if (!ALLOWED_FIRST_KEYWORDS.has(firstKeyword)) {
    throw new Error(
      "仅支持 SELECT、SHOW、DESCRIBE/DESC、EXPLAIN 和只读 WITH 查询。",
    );
  }

  const blockedKeyword = words.find((word) => BLOCKED_KEYWORDS.has(word));
  if (blockedKeyword) {
    throw new Error(`检测到不允许的关键字 ${blockedKeyword}，插件不支持修改类 SQL。`);
  }

  const blockedFunction = words.find((word) => BLOCKED_FUNCTIONS.has(word));
  if (blockedFunction) {
    throw new Error(`检测到不安全函数 ${blockedFunction}，已拒绝执行。`);
  }

  if (/\bINTO\b/i.test(sanitizedWithoutTrailingSemicolon)) {
    throw new Error("不允许 SELECT ... INTO 变量或文件写入操作。");
  }

  if (sanitizedWithoutTrailingSemicolon.includes(":=")) {
    throw new Error("不允许在查询中给会话变量赋值。");
  }

  if (/\bFOR\s+SHARE\b/i.test(sanitizedWithoutTrailingSemicolon)) {
    throw new Error("不允许执行会获取共享锁的 SELECT ... FOR SHARE 查询。");
  }

  return withoutTrailingSemicolon;
}

const UPDATE_BLOCKED_KEYWORDS = new Set([
  "INSERT",
  "DELETE",
  "REPLACE",
  "MERGE",
  "UPSERT",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "GRANT",
  "REVOKE",
  "CALL",
  "DO",
  "USE",
  "LOCK",
  "UNLOCK",
  "FLUSH",
  "RESET",
  "ANALYZE",
  "OPTIMIZE",
  "REPAIR",
  "INSTALL",
  "UNINSTALL",
  "LOAD",
  "HANDLER",
  "PREPARE",
  "PROCEDURE",
  "EXECUTE",
  "DEALLOCATE",
  "BEGIN",
  "START",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "XA",
  "KILL",
  "SHUTDOWN",
  "IGNORE",
]);

export function validateUpdateSql(input) {
  const { sql, sanitized } = normalizeSingleStatement(input);
  const words = sanitized.toUpperCase().match(/[A-Z_]+/g) ?? [];
  const outerWords = topLevelWords(sanitized);
  if (outerWords[0] !== "UPDATE") {
    throw new Error("受控写操作只支持单条 UPDATE SQL。INSERT、DELETE 和 DDL 不受支持。");
  }
  const setIndex = outerWords.indexOf("SET");
  const whereIndex = outerWords.indexOf("WHERE");
  if (setIndex < 0) {
    throw new Error("UPDATE SQL 缺少 SET 子句。");
  }
  if (whereIndex < 0 || whereIndex < setIndex) {
    throw new Error("UPDATE 必须包含 WHERE 条件，禁止全表更新。");
  }

  const blockedKeyword = words.slice(1).find((word) => UPDATE_BLOCKED_KEYWORDS.has(word));
  if (blockedKeyword) {
    throw new Error(`UPDATE 中检测到不允许的关键字 ${blockedKeyword}。`);
  }
  const blockedFunction = words.find((word) => BLOCKED_FUNCTIONS.has(word));
  if (blockedFunction) {
    throw new Error(`UPDATE 中检测到不安全函数 ${blockedFunction}，已拒绝执行。`);
  }
  if (sanitized.includes(":=")) {
    throw new Error("不允许在 UPDATE 中给会话变量赋值。");
  }

  return sql;
}

export function validateIdentifier(input, fieldName) {
  if (typeof input !== "string" || !/^[A-Za-z0-9_$]+$/.test(input)) {
    throw new Error(`${fieldName} 只能包含字母、数字、下划线和 $。`);
  }
  return input;
}
