# 墨游 v0.6.4：讨论功能补丁

此补丁已准备并完成 15 项针对性验证，尚未应用到 lishbuwe/moyu 的 main。当前 GitHub 连接向该仓库写入返回 403（Resource not accessible by integration）；你的协作者账号有 push 权限，但连接应用未获仓库写入授权。

- 目标基线：`lishbuwe/moyu@09cd99fabfe88dd9870b508f5f09d578f8add503`（v0.6.3）。
- 讨论功能来源：`YL2C/yl2c-c@d67a06d81c845879f1d7ce54ac7c82ccac7d947a`，按用户选择使用【克】版。
- 补丁文件：同分支的 `moyu-v0.6.4.patch`。
- 只修改下列 12 个文件，其中新增 `js/discuss.js`、`js/views/discuss.js`。

- `README.md`
- `css/app.css`
- `js/db.js`
- `js/discuss.js`
- `js/main.js`
- `js/prompt.js`
- `js/state.js`
- `js/util.js`
- `js/views/discuss.js`
- `js/views/play.js`
- `js/views/story-edit.js`
- `sw.js`

## 合并内容

新增独立讨论页：读取当前故事的设定、角色卡和当前分支记忆；整理后逐条确认写回，并支持撤销最近一次写回；可根据讨论预填新故事。新增全局备忘并接入正常游玩提示词和备份。

保留原项目名称、`moyu` IndexedDB 名称、数据库版本 2、`moyu.curStory` 本地标识和既有 API 连接。未更换页面入口、应用清单、图标或旧版文件。兼容原 moyu 与独立 yl2c 备份；默认导出仍排除 API 密钥。

`APP_VERSION` 已设为 `0.6.4`，Service Worker 缓存名改为 `moyu-v0.6.4`，缓存列表包含两个新模块。另加了防重复发送保护，并让整理清单最多 6 条，与界面说明一致。

## 应用与验证

仓库拥有者可在目标仓库根目录下载补丁后执行：

```sh
git switch main
git pull --ff-only
git apply --check /path/to/moyu-v0.6.4.patch
git apply /path/to/moyu-v0.6.4.patch
git diff --stat
```

若基线已有新提交，请先核对差异；不要强行覆盖或重置 main。运行原项目的完整测试，检查旧故事、API 连接和记忆仍可读取，再提交以上文件并推送 main。

已通过：全部模块语法和真实导入/导出链接、旧数据库与当前故事标识保留、讨论存取、当前分支记忆隔离、修改清单校验与 6 条上限、按勾选写回、撤销恢复、无前情档案时的补充处理、全局备忘提示词注入、备份和密钥保留、缓存安装/升级以及外部 API 不缓存。Git 已验证补丁格式。测试使用内存数据，模型 API 调用为 0。

补丁尚未部署，线上刷新与实际设备显示仍需在应用补丁后检查；这不代替原作者的完整测试。
