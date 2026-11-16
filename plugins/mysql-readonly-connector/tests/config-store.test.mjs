import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigStore } from "../mcp/config-store.mjs";

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "mysql-config-store-"));
  const secrets = new Map();
  const keychain = {
    get: (name) => secrets.get(name) ?? null,
    set: (name, password) => secrets.set(name, password),
    delete: (name) => secrets.delete(name),
  };
  const configPath = join(directory, "connections.json");
  const store = new ConfigStore({ configPath, keychain });
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return { store, configPath, secrets };
}

test("配置文件不保存密码，密码由钥匙串提供", (context) => {
  const { store, configPath, secrets } = fixture(context);
  store.saveConnection("classes", {
    host: "db.example",
    port: 3306,
    user: "reader",
    password: "top-secret",
    database: "classes",
    setDefault: true,
  });
  const file = readFileSync(configPath, "utf8");
  assert.doesNotMatch(file, /top-secret/);
  assert.equal(secrets.get("classes"), "top-secret");
  const resolved = store.resolvedProfiles();
  assert.equal(resolved.profiles.classes.password, "top-secret");
  assert.equal(resolved.defaultConnection, "classes");
  assert.equal(resolved.profiles.classes.allowUpdate, false);
});

test("UPDATE 权限默认关闭且可以按连接保存", (context) => {
  const { store } = fixture(context);
  store.saveConnection("analytics", {
    host: "db.example",
    user: "operator",
    password: "secret",
    database: "analytics",
    allowUpdate: true,
  });
  assert.equal(store.read().connections.analytics.allowUpdate, true);
  assert.equal(store.publicState().connections[0].allowUpdate, true);
});

test("编辑时密码留空会保留原密码", (context) => {
  const { store, secrets } = fixture(context);
  store.saveConnection("classes", {
    host: "old.example",
    user: "reader",
    password: "secret",
    database: "classes",
  });
  store.saveConnection("classes", {
    host: "new.example",
    user: "reader",
    password: "",
    database: "classes",
  });
  assert.equal(secrets.get("classes"), "secret");
  assert.equal(store.resolvedProfiles().profiles.classes.host, "new.example");
});

test("删除连接会同时删除钥匙串密码并调整默认连接", (context) => {
  const { store, secrets } = fixture(context);
  for (const name of ["classes", "teaching"]) {
    store.saveConnection(name, {
      host: "db.example",
      user: "reader",
      password: `${name}-secret`,
      database: name,
      setDefault: name === "classes",
    });
  }
  store.deleteConnection("classes");
  assert.equal(secrets.has("classes"), false);
  assert.equal(store.read().defaultConnection, "teaching");
});
