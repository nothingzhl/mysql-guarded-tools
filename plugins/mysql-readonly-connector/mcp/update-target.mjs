// Fail closed: rollback guarantees require a known, transactional single-table target.
const identifier = '(?:`(?:[A-Za-z0-9_$]+)`|[A-Za-z0-9_$]+)';
const target = new RegExp(`^UPDATE\\s+(${identifier})(?:\\s*\\.\\s*(${identifier}))?\\s+SET\\s`, 'i');
export async function verifyUpdateTarget(connection, sql, timeoutMs) {
  const match = target.exec(sql);
  if(!match) throw new Error('安全 UPDATE 仅支持不带别名的单表 UPDATE；JOIN、多目标与修饰符不支持。');
  const unquote = value => value.replace(/`/g, '');
  const schema = match[2] ? unquote(match[1]) : null;
  const table = unquote(match[2] || match[1]);
  const qualified = [schema,table].filter(Boolean).map(value=>'`'+value+'`').join('.');
  // Hold a metadata lock until this transaction ends before examining table metadata.
  await connection.query({sql:`SELECT 1 FROM ${qualified} LIMIT 0`,timeout:timeoutMs});
  const [rows] = await connection.query({sql:`SELECT t.ENGINE AS engine, t.TABLE_TYPE AS table_type,
    (SELECT COUNT(*) FROM (
      SELECT GRANTEE, PRIVILEGE_TYPE, '*' AS scope_schema, '*' AS scope_table FROM information_schema.USER_PRIVILEGES
      UNION ALL SELECT GRANTEE, PRIVILEGE_TYPE, TABLE_SCHEMA, '*' FROM information_schema.SCHEMA_PRIVILEGES
      UNION ALL SELECT GRANTEE, PRIVILEGE_TYPE, TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLE_PRIVILEGES
    ) grants_seen WHERE grants_seen.PRIVILEGE_TYPE='TRIGGER'
      AND grants_seen.GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)), '@', QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))
      AND (grants_seen.scope_schema='*' OR grants_seen.scope_schema=t.TABLE_SCHEMA)
      AND (grants_seen.scope_table='*' OR grants_seen.scope_table=t.TABLE_NAME)) AS trigger_visible,
    (SELECT COUNT(*) FROM information_schema.TRIGGERS tr
     WHERE tr.EVENT_OBJECT_SCHEMA=t.TABLE_SCHEMA AND tr.EVENT_OBJECT_TABLE=t.TABLE_NAME) AS trigger_count
    FROM information_schema.TABLES t
    WHERE t.TABLE_SCHEMA=COALESCE(?, DATABASE()) AND t.TABLE_NAME=?`,timeout:timeoutMs},[schema,table]);
  if(rows.length!==1 || String(rows[0].engine).toUpperCase()!=='INNODB' || rows[0].table_type!=='BASE TABLE') {
    throw new Error('UPDATE 仅允许 InnoDB 基表；非事务引擎、视图或无法确认元数据的目标已拒绝。');
  }
  if(!(Number(rows[0].trigger_visible)>0)) throw new Error("无法确认触发器元数据可见性，已拒绝 UPDATE；当前仅支持可直接核验的 TRIGGER 元数据权限。");
  if(Number(rows[0].trigger_count)!==0) throw new Error('目标表存在触发器，无法保证所有副作用可回滚，已拒绝 UPDATE。');
}
