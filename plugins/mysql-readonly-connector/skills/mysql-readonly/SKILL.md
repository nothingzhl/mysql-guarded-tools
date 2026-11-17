---
name: mysql-readonly
description: Manage MySQL connection references and run read queries or guarded UPDATE. Passwords come only from MYSQL_PASSWORD or MYSQL_PASSWORDS_JSON environment variables. INSERT, DELETE and DDL are unsupported.
---

# MySQL Guarded Connector

Use the mysql-readonly MCP server. Start with mysql_list_connections if the target is unknown. When multiple connections exist, pass the intended connection explicitly; never guess between similarly named environments.

## Connection management

- Open the actual local window with mysql_open_config_window. Present the returned URL only to the user; it contains a management token.
- mysql_save_connection accepts non-secret connection details, password_source (MYSQL_PASSWORD or MYSQL_PASSWORDS_JSON), and password_key (the JSON lookup name, defaulting to connection name).
- MYSQL_PASSWORD is a shared password. MYSQL_PASSWORDS_JSON is a JSON object of logical names to password strings. Explicit JSON references never fall back to the shared password.
- Never request or pass actual passwords in chat, tool arguments, code, logs or committed files. Tell users to set them locally in the process environment before starting Codex.
- Missing environment values may leave references saved with password_configured=false; that is not a successful database connection. Tell the user to set variables and restart Codex. Existing processes do not inherit later shell exports.
- Do not invoke Keychain, native password dialogs, change_password, or copy_password_from. This version does not access old Keychain entries or automatically export their values.
- Existing JSON connection metadata can still be listed; its default source is MYSQL_PASSWORD until explicitly changed.
- Delete connections only when explicitly requested. The tool requires confirm=true. Deletion removes metadata only and never alters external environment variables.
- Environment-managed legacy connection profiles (MYSQL_CONNECTIONS_JSON / MYSQL_URL / MYSQL_HOST) remain compatible, but native management must not overwrite them. Explain legacy_environment results and use an explicitly chosen managed config when needed.

## Queries

- Prefer mysql_describe_table when schema is unknown, selective filters and reasonable limits, and ? placeholders with params for user values.
- mysql_query permits one SELECT, SHOW, DESCRIBE/DESC, EXPLAIN or read-only WITH statement. Do not attempt INSERT, DELETE, DDL, permission changes, transaction statements or stored-procedure calls.
- Send UPDATE only through mysql_update. It must have WHERE, and the connection must explicitly enable updates. The candidate restricts targets to directly verifiable InnoDB single tables without aliases or triggers; missing metadata visibility must fail closed. Do not expand database privileges to get a test to pass.
- At 10 affected rows or fewer the update commits; report exact affected and changed counts. More than 10 rows rolls back and returns review_required.
- On review_required, show connection, SQL intent, parameters and affected count; ask the user to explicitly approve this exact operation. Never automatically reuse review_token, even for acceptance tests.
- Tokens expire after 5 minutes, are single use, and require the identical connection, SQL and params. If the affected count changes on confirmation, request a fresh review.
- One SQL cannot span different MySQL servers. Query each connection separately and combine only the necessary results.
- Minimize sensitive output and mention truncation. A metadata save or query response does not prove external business acceptance.
