# MySQL Guarded Tools

用于 macOS 本地 Codex 的 MySQL 连接管理插件及 Git 插件市场。当前候选版本：`0.7.0-rc.1`。

提供真实连接配置窗口、表结构查看、只读查询，以及带 WHERE 和行数审查的 UPDATE。新连接默认禁止 UPDATE；超过 10 行先回滚，再由用户明确确认。INSERT、DELETE 和 DDL 不支持。UPDATE 仅支持可确认无触发器的 InnoDB 单表，别名、JOIN、多目标、视图和非事务表会被拒绝。无法核验触发器元数据权限时也会拒绝；详见 SECURITY.md。

## 环境

- macOS，Node.js 22+、npm、Git。
- Apple Command Line Tools（`xcode-select --install`），用于编译 Security.framework 钥匙串组件。
- 支持本地 MCP 插件的 Codex。插件进程需有用户配置目录和钥匙串访问权限。
- 首次启动需要网络下载锁文件中的 npm 依赖。无网络环境请先在插件目录执行 `npm ci --ignore-scripts` 和 `npm run setup`。

Linux CI 只验证隔离逻辑，不代表支持 Linux 密码管理。

## 从本地仓库安装

在仓库根目录执行：

```sh
npm run setup
codex plugin marketplace add .
codex plugin add mysql-readonly-connector@mysql-guarded-tools
```

重新加载插件或重启 Codex 后，输入“打开 MySQL 配置窗口”。窗口关闭插件后失效；刷新保留当前标签页授权。窗口地址可管理真实连接，勿转发。

## 从 Git 市场安装

发布仓库后，将下列 `OWNER/REPOSITORY` 换成实际 Git 仓库路径；这不是已经存在的远端地址。

```sh
codex plugin marketplace add OWNER/REPOSITORY --ref v0.7.0-rc.1
codex plugin add mysql-readonly-connector@mysql-guarded-tools
```

启动器首次启动会根据锁文件安装依赖并编译本机钥匙串组件；输出只写 stderr，不污染 MCP 协议。若宿主启动超时，按“本地仓库安装”先手动准备依赖，再重新安装插件。首次编译可能需要用户安装 Apple Command Line Tools。

升级时先备份各自本机的 `connections.json`，然后获取已审查的新 Git tag，重新添加对应 ref 的市场，再安装插件。请用 `codex plugin marketplace list` 核实跟踪的版本。候选版本不得当作正式稳定版。

## 密码与数据

密码只通过 macOS 隐藏弹框或同账号钥匙串复制流程进入插件，通过 stdin 管道交给 Security.framework 组件。页面、MCP 工具参数、Git 仓库、普通配置文件都不应包含密码。插件和数据库驱动运行时仍会在内存中持有密码。

配置和密码属于各自用户电脑。默认配置位于 `~/Library/Application Support/mysql-readonly-connector/connections.json`，钥匙串服务名沿用 `mysql-readonly-connector`，连接账号键为 `connection:<name>`。升级兼容原有条目。

## 开发与检查

```sh
npm run setup
npm test
npm run validate
npm run audit
```

测试使用临时配置和模拟钥匙串；不连接真实数据库，也不弹出密码框。macOS 测试会编译密码脚本，但不会执行弹框。

## 发布前阅读

- [安全审查与验证记录](doc/security-review.md)
- [发布步骤及待办](doc/release-preparation.md)
- [安全边界](SECURITY.md)
- [版本变更](CHANGELOG.md)

仓库只提供 Git 市场分发准备，未申请进入公共官方插件目录。
