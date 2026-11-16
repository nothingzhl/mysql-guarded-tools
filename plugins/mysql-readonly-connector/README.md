# MySQL Guarded Connector

版本：0.7.0-rc.1。macOS 本地 MCP 插件，支持真实连接管理窗口、只读查询和受控 UPDATE。

要求 Node.js 22+、npm、Apple Command Line Tools。启动器 `node scripts/start.mjs` 会在首次启动时安装锁定依赖并编译钥匙串组件；可提前执行 `npm ci --ignore-scripts`、`npm run setup`。

密码统一通过 macOS 原生隐藏弹框录入，通过 stdin 交给 Security.framework helper；密码不进入页面、工具参数或普通配置文件。普通编辑保留旧密码。复制密码仅允许主机、端口、用户名一致；新增连接 UPDATE 默认关闭。

真实配置保存在用户 Application Support 目录，密码保存在系统钥匙串。配置窗口 URL 仅限本人使用。受限宿主可能允许读取但不允许保存，需要宿主授予配置目录与钥匙串访问权限，勿通过放宽目录权限处理。

运行 `npm test` 执行隔离测试。Git 市场安装、升级、安全限制和验收步骤见仓库根目录文档。
