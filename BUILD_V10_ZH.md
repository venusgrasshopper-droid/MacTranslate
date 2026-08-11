# MacTranslate v10（Apple Silicon）

v10 按成熟成品的结构打包 Signal：

- Signal JavaScript、页面和纯 JavaScript 依赖位于 `app.asar/signal-runtime`
- Signal 原生模块位于 `app.asar.unpacked/signal-runtime`
- 每个账号使用独立 `WebContentsView`、持久化 partition 和数据库
- 构建前检查完整依赖闭包和全部 ARM64 原生模块
- 打包后检查 asar 分层，并启动两个账号到二维码状态进行冒烟测试

构建：

```bash
cd ~/Downloads/MacTranslate
./scripts/build-macos-arm64.sh
```

只有终端最后出现以下内容才安装：

```text
Build and Signal runtime smoke test passed.
```
