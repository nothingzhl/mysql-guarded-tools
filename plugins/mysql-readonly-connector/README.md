# MySQL Guarded Connector 0.8.0-rc.1

密码仅来自环境变量。无需 macOS 钥匙串、Swift 或密码弹框。

- MYSQL_PASSWORD：所有选择共用来源的连接使用此值。
- MYSQL_PASSWORDS_JSON：名称到密码字符串的 JSON 对象；在窗口为连接选择来源和名称。
- 连接 JSON 只保存引用。窗口不接收密码，删除连接不修改环境变量。
- 密码缺失时可先保存引用，检查连接时会明确拒绝；不会回退到其他来源。
- 修改环境变量后重启实际运行的 Codex 进程，已有进程不会获得后来的 export。

要求 Node.js 22+ 和 npm。首次启动根据锁文件安装 mysql2 依赖；可提前执行 npm ci --ignore-scripts。不再编译原生组件。

旧版连接信息仍可读取，默认来源为 MYSQL_PASSWORD；不会自动读取或删除旧钥匙串密码。安装、迁移及安全边界见仓库根目录文档。
