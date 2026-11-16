---
name: mysql-readonly
description: Manage one or more user-configured MySQL connections directly in Codex, run read queries, and perform guarded UPDATE operations. Use for adding, editing, deleting, testing, or selecting connections; inspecting schemas; querying data; or executing a WHERE-scoped UPDATE with mandatory review above 10 affected rows. INSERT, DELETE, and DDL are unsupported.
---

# MySQL Guarded Connector

Use the `mysql-readonly` MCP server for MySQL inspection and query tasks.

## Supported operations

- List connection settings with `mysql_list_connections`. It returns non-password fields only.
- Add or edit a connection with `mysql_save_connection`. When the target uses the same host, port, and user as an existing connection, `copy_password_from` can securely copy its Keychain password. Otherwise, open the native macOS hidden-password dialog. Never use MCP elicitation for passwords.
- Delete a connection and its Keychain password with `mysql_delete_connection` only after explicit user confirmation.
- Set or clear the default connection with `mysql_set_default_connection`.
- Run one `SELECT`, `SHOW`, `DESCRIBE`/`DESC`, `EXPLAIN`, or read-only `WITH` statement against a named connection.
- List tables and views with `mysql_list_tables`.
- Inspect columns and indexes with `mysql_describe_table`.
- Check connectivity with `mysql_health_check`.
- Run one WHERE-scoped `UPDATE` with `mysql_update` only when that connection explicitly enables updates.

## Required behavior

- Never attempt `INSERT`, `DELETE`, DDL, permission changes, explicit transaction statements, stored-procedure calls, or modifying SQL other than the guarded `mysql_update` tool.
- Never send UPDATE SQL through `mysql_query`; use `mysql_update` only.
- Before UPDATE, inspect the table when needed and prefer parameter placeholders.
- An UPDATE must contain `WHERE`. Never weaken or remove its filter to make execution succeed.
- If `mysql_update` commits at 10 affected rows or fewer, report the exact affected and changed row counts.
- If `mysql_update` returns `review_required`, the transaction has already been rolled back. Show the connection, SQL intent, parameters, and affected row count to the user, then ask for explicit confirmation.
- Never reuse a `review_token` automatically. Pass it back only after the user explicitly confirms the specific reviewed UPDATE.
- Review tokens are single-use and expire after 5 minutes. The confirmation call must use exactly the same connection, SQL, and parameters.
- If the affected row count changes during confirmation, the server rolls back and issues a new review. Ask the user again.
- Never ask the user to paste a database password into chat or pass one as an MCP tool argument. `mysql_save_connection` uses the native macOS hidden-password dialog and stores secrets in Keychain via a local Security.framework helper.
- When the user asks to open the connection manager, window, or configurator, call `mysql_open_config_window` and present its returned local URL. The window manages real connections through the existing guarded tools; passwords remain in Keychain. The URL is valid while the plugin process runs.
- For a new connection, collect only the non-secret fields needed by `mysql_save_connection`. Prefer `copy_password_from` when the user explicitly identifies an existing connection with the same host, port, and user, or when those fields are visibly identical and the user asked to add another database connection. Otherwise a native macOS hidden-password dialog appears during the tool call. On unsupported systems, stop with the platform limitation; never ask for a password in chat.
- Never use `copy_password_from` when host, port, or user differs. Never guess between multiple possible password sources.
- For an existing connection, omit unchanged fields. Set `change_password=true` only when the user explicitly asks to replace its password.
- After saving, use `mysql_health_check` when the user asked to test the connection or when validation is useful.
- Before `mysql_delete_connection`, make sure the user explicitly named the connection to delete. Pass `confirm=true` only then.
- If connection management reports `legacy_environment`, explain that these connections come from compatibility environment variables and cannot be edited by the native tools until those variables are removed and Codex is restarted.
- The local managed configuration takes precedence over legacy environment-variable connections once its configuration file exists.
- For modification requests, support only a single guarded `UPDATE` with `WHERE`. Explain that `INSERT`, `DELETE`, DDL, and every other modifying operation remain unsupported.
- When multiple connections exist, pass the intended `connection` explicitly. Never guess between similarly named production, staging, or analytics connections.
- A single SQL statement cannot join across different MySQL servers. Query each named connection separately and combine only the minimum required results in the response.
- Prefer `mysql_describe_table` before writing a query when table structure is unknown.
- Prefer parameter placeholders (`?`) plus `params` for user-provided values.
- Add selective filters and reasonable limits. The server also caps returned rows.
- Do not request or repeat database passwords in conversation.
- Treat query results as potentially sensitive. Return only fields and rows needed to answer the user's question.
- If a tool reports missing connection configuration, identify the missing environment variables and stop; do not invent credentials.

## Query workflow

1. Use `mysql_list_connections` for connection-management requests or when the target connection is unknown.
2. Use the native save, delete, and default-selection tools for requested configuration changes.
3. Use `mysql_health_check` for the selected connection when its status is unknown.
4. Discover tables or table shape when needed.
5. Execute the smallest useful read-only query, or use `mysql_update` for an explicitly requested WHERE-scoped update.
6. Stop for user confirmation whenever the update result says `review_required`.
7. Summarize configuration changes, committed updates, or query results; clearly mention truncation when `truncated` is true.
