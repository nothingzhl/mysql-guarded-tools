# MySQL Guarded Tools

MySQL 连接管理插件与 Codex Git 市场。当前开发候选为 `0.8.0-rc.1`：密码改为环境变量，不再依赖 macOS 钥匙串、Swift 或原生弹框。

**0.8.0-rc.1 尚未进行真实 MySQL 集成验收。环境变量只改变密码提供方式，不能代替数据库权限控制。**

提供连接配置窗口、表结构与只读查询，以及需要 WHERE 和行数审查的受控 UPDATE。新连接 UPDATE 默认关闭；超过 10 行先回滚再请求用户确认。目标限定为可核验无触发器的 InnoDB 单表；无法核验时拒绝。INSERT、DELETE、DDL 不支持。

## 环境与安装

要求 Node.js 22+、npm 和支持本地 MCP 的 Codex。macOS 与 Linux 有隔离测试；Windows 尚未实机验收。

```sh
npm run setup
codex plugin marketplace add .
codex plugin add mysql-readonly-connector@mysql-guarded-tools
```

启动器首次运行需要网络安装锁定的 npm 依赖；离线安装前请手动准备依赖。没有 Swift 或 Apple Command Line Tools 要求。

GitHub 仓库：[nothingzhl/mysql-guarded-tools](https://github.com/nothingzhl/mysql-guarded-tools)。当前已经发布的 `v0.7.0-rc.1` 仍使用钥匙串；不要把它当成环境变量版。环境变量版位于开发分支 feature/environment-passwords，尚未发布新 tag。可以按上面的本地市场步骤安装，或使用开发分支：

```sh
codex plugin marketplace add nothingzhl/mysql-guarded-tools --ref feature/environment-passwords
codex plugin add mysql-readonly-connector@mysql-guarded-tools
```

开发分支会随后续提交变化，正式使用前应固定到验收通过的 tag 或 Git commit。

## 密码环境变量

| 来源 | 用法 |
| --- | --- |
| MYSQL_PASSWORD | 单连接或多连接共用一个密码 |
| MYSQL_PASSWORDS_JSON | JSON 对象，名称映射到各自密码；窗口通过“密码名称”引用 |

JSON 结构示例：`{"classes":"本机填写的密码","teaching":"另一个密码"}`。这里的名称可复用来给多个连接共享同一密码；引用不存在时不会回退到 MYSQL_PASSWORD。

不要把真实密码直接写在 shell 命令历史中，也不要发给 Codex。在 Bash 终端中可隐藏读取，再启动 CLI：

```bash
read -r -s -p 'MySQL password: ' MYSQL_PASSWORD
printf '\n'
export MYSQL_PASSWORD
codex
```

多个密码时改为隐藏读取完整 JSON：

```bash
read -r -s -p 'MySQL password JSON: ' MYSQL_PASSWORDS_JSON
printf '\n'
export MYSQL_PASSWORDS_JSON
codex
```

对于桌面版：必须让**实际桌面进程**从配置了变量的环境启动，或使用宿主支持的 MCP 环境注入设置。已从 Finder 启动的 Codex 不会因另一个终端 export 而更新；仅重启 MCP 子进程也不保证获取新值。完全退出后从已配置的环境启动，再看窗口的“环境状态”。此仓库不自动设置全局环境，不写入 shell 配置、.env 或 launchctl。

窗口仅保存密码来源与名称，不接收密码。可先保存未配置的引用，连接检查会在发起网络请求前提示缺失；一个未配置连接不会阻塞其他已配置连接。修改密码环境变量后重启 Codex。

## 从钥匙串版迁移

1. 保留原连接配置，安装环境变量版。
2. 在本机重新设置环境变量。插件不会自动读取、导出或删除旧钥匙串密码。
3. 旧连接默认引用 MYSQL_PASSWORD；有不同密码时，在窗口选择 MYSQL_PASSWORDS_JSON 并填写相应名称。
4. 重启实际 Codex 进程，在窗口确认密码已设置，再检查连接。确认迁移后，如需清理旧钥匙串条目，由你手动处理。

macOS 默认配置目录沿用 Application Support；Linux 使用 XDG_CONFIG_HOME 或 ~/.config；Windows 使用 APPDATA。可以用 MYSQL_CONFIG_FILE 指定路径。

## 开发与发布

```sh
npm run setup
npm test
npm run validate
npm run audit
```

测试使用临时配置和虚构环境值，不读取业务密码。参见 [安全说明](SECURITY.md)、[审查记录](doc/security-review.md)、[发布清单](doc/release-preparation.md) 和 [变更记录](CHANGELOG.md)。
