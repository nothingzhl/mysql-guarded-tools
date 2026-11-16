import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigStore } from "../mcp/config-store.mjs";
import {
  deleteManagedConnection,
  managedConnectionState,
  saveManagedConnection,
  setManagedDefaultConnection,
} from "../mcp/connection-manager.mjs";

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "mysql-native-manager-"));
  const secrets = new Map();
  const keychain = {
    get: (name) => secrets.get(name) ?? null,
    set: (name, password) => secrets.set(name, password),
    delete: (name) => secrets.delete(name),
  };
  const store = new ConfigStore({ configPath: join(directory, "connections.json"), keychain });
  const changes = [];
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return { store, secrets, changes, onChanged: async (name) => changes.push(name) };
}

test("新增连接时通过本机弹窗取得密码", async (context) => {
  const { store, secrets, changes, onChanged } = fixture(context);
  let prompts = 0;
  const result = await saveManagedConnection({
    store,
    args: {
      name: "staging",
      host: "db.example",
      user: "operator",
      database: "app",
      allow_update: true,
      set_default: true,
    },
    promptPassword: async () => {
      prompts += 1;
      return "native-secret";
    },
    onChanged,
  });
  assert.equal(prompts, 1);
  assert.equal(secrets.get("staging"), "native-secret");
  assert.equal(result.action, "created");
  assert.equal(result.connection.allow_update, true);
  assert.equal(result.default_connection, "staging");
  assert.deepEqual(changes, ["staging"]);
});

test("局部编辑默认保留原密码", async (context) => {
  const { store, secrets, onChanged } = fixture(context);
  store.saveConnection("staging", {
    host: "old.example",
    user: "operator",
    password: "original-secret",
    database: "app",
  });
  const result = await saveManagedConnection({
    store,
    args: { name: "staging", host: "new.example", allow_update: true },
    promptPassword: async () => {
      throw new Error("不应弹窗");
    },
    onChanged,
  });
  assert.equal(result.connection.host, "new.example");
  assert.equal(result.password_action, "kept_existing");
  assert.equal(secrets.get("staging"), "original-secret");
});

test("修改密码时重新弹出原生密码框", async (context) => {
  const { store, secrets, onChanged } = fixture(context);
  store.saveConnection("staging", {
    host: "db.example",
    user: "operator",
    password: "old-secret",
    database: "app",
  });
  await saveManagedConnection({
    store,
    args: { name: "staging", change_password: true },
    promptPassword: async () => "new-secret",
    onChanged,
  });
  assert.equal(secrets.get("staging"), "new-secret");
});

test("新增连接可以从同账号连接复制钥匙串密码", async (context) => {
  const { store, secrets, onChanged } = fixture(context);
  store.saveConnection("classes", {
    host: "db.example",
    port: 3306,
    user: "reader",
    password: "shared-secret",
    database: "groot_classes",
  });
  let prompted = false;
  const result = await saveManagedConnection({
    store,
    args: {
      name: "user_account",
      host: "db.example",
      port: 3306,
      user: "reader",
      database: "groot_user_account",
      copy_password_from: "classes",
    },
    promptPassword: async () => {
      prompted = true;
      return "should-not-be-used";
    },
    onChanged,
  });
  assert.equal(prompted, false);
  assert.equal(secrets.get("user_account"), "shared-secret");
  assert.equal(result.password_action, "copied_from_keychain");
  assert.equal(result.password_source, "classes");
});

test("复制密码要求主机端口和用户名完全一致", async (context) => {
  const { store, secrets, onChanged } = fixture(context);
  store.saveConnection("classes", {
    host: "db.example",
    user: "reader",
    password: "shared-secret",
    database: "groot_classes",
  });
  await assert.rejects(
    saveManagedConnection({
      store,
      args: {
        name: "other",
        host: "other.example",
        user: "reader",
        database: "groot_user_account",
        copy_password_from: "classes",
      },
      promptPassword: async () => "unused",
      onChanged,
    }),
    /主机、端口和用户名完全一致/,
  );
  assert.equal(secrets.has("other"), false);
});

test("复制密码与弹窗换密不能同时使用", async (context) => {
  const { store, onChanged } = fixture(context);
  await assert.rejects(
    saveManagedConnection({
      store,
      args: {
        name: "other",
        copy_password_from: "classes",
        change_password: true,
      },
      promptPassword: async () => "unused",
      onChanged,
    }),
    /不能同时使用/,
  );
});

test("普通配置不完整时不会先弹出密码框", async (context) => {
  const { store, onChanged } = fixture(context);
  let prompted = false;
  await assert.rejects(
    saveManagedConnection({
      store,
      args: { name: "staging", host: "db.example" },
      promptPassword: async () => {
        prompted = true;
        return "secret";
      },
      onChanged,
    }),
    /缺少配置/,
  );
  assert.equal(prompted, false);
});

test("可以列出、设置默认值和删除连接", async (context) => {
  const { store, secrets, onChanged } = fixture(context);
  for (const name of ["one", "two"]) {
    store.saveConnection(name, {
      host: "db.example",
      user: "reader",
      password: `${name}-secret`,
      database: name,
    });
  }
  await setManagedDefaultConnection({ store, name: "two", onChanged });
  const state = managedConnectionState(store);
  assert.equal(state.default_connection, "two");
  assert.equal(state.connections.length, 2);
  assert.equal(state.connections[0].password, undefined);
  await deleteManagedConnection({ store, name: "two", onChanged });
  assert.equal(secrets.has("two"), false);
  assert.equal(store.read().defaultConnection, "one");
});
