# 发布准备

## 当前交付

Git 市场及插件发布候选 `0.7.0-rc.1`，远端为 public 仓库 `nothingzhl/mysql-guarded-tools`。候选源码和同名 tag 可用于审阅与测试；不代表真实钥匙串和 MySQL 验收通过。未覆盖当前 0.6.0 安装。

仓库遵循 `.agents/plugins/marketplace.json` + `plugins/<name>/.codex-plugin/plugin.json` 结构。市场路径相对于仓库根目录，全部使用相对路径。依据：[OpenAI 插件打包与市场文档](https://developers.openai.com/plugins/build/plugins)。这属于 Git 自建市场，不代表进入官方公共目录。

## 发布前验收

- [x] 安全修复与隔离回归；55 项测试通过。
- [x] Security.framework helper 本机编译通过。
- [x] 依赖锁文件，npm audit 未报告漏洞。
- [x] 市场清单、版本、启动器及个人数据扫描。
- [x] Codex CLI 能识别候选插件；未安装、未修改当前市场配置。
- [x] 同一台机器的干净 Git 副本首次启动成功：自动安装依赖、编译 helper、MCP 初始化、隔离配置窗口 API 及 UI JavaScript 语法检查。该结果不等同于新机器或真实钥匙串验收。
- [ ] 新机器或隔离 macOS 用户：Git 市场安装、首次下载依赖与编译、Codex MCP 启动。
- [ ] 人工验收原生密码弹框：新增、取消、普通编辑不弹框、换密、同账号复制、删除确认。
- [ ] 首次钥匙串授权及旧条目升级；不将现有业务账号当作测试账号。
- [ ] 浏览器刷新与重新打开窗口验收。
- [ ] 测试数据库中的只读和受控 UPDATE 集成验收。
- [x] Git 托管目标为 GitHub public 仓库 `nothingzhl/mysql-guarded-tools`。
- [ ] 确认私密安全问题报告入口已启用。
- [ ] 远端 GitHub Actions 成功；确认维护者姓名、许可证及版本说明。

## 正式发布步骤（候选源码发布不等于正式验收）

1. 决定远端与 public/private，并建立私密安全问题报告渠道。
2. 创建空 Git 仓库，添加 remote；先推候选分支供审阅。
3. 在新环境按 README 使用候选 Git tag 安装并完成上方验收。
4. 准备正式版时同步更新根 package.json、插件 package.json、package-lock.json 与插件 manifest，更新 CHANGELOG。
5. 测试、validate 和 audit 通过后创建对应 tag，并发布源码归档和校验和。
6. 使用 Git 市场 ref 固定已审查版本；升级时指向新的已验收 tag，不复用旧 tag。

候选 tag 为 `v0.7.0-rc.1`。本次只发布候选源码和 tag，未创建正式版 GitHub Release。

## 回退

保留旧 Git tag。关闭所有插件进程，备份非密码配置，重新安装旧 tag 并重启 Codex。钥匙串服务名与账号键保持兼容；不要通过 Git 备份钥匙串密码。若有遗留 lock，确认没有运行中的写入进程后才能清理。
