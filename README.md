# B站大航海详情公开安装包

本仓库只保存由私有源码仓库自动生成并验证的公开安装产物，不接受手工编辑构建文件。

- 油猴安装：打开 `userscript/bilibili-guard.user.js`。
- 油猴更新元数据：`userscript/bilibili-guard.meta.js`。
- Chrome/Edge ZIP：下载 `extension/bilibili-guard-extension.zip`，解压后以开发者模式加载。
- 当前版本和 SHA-256：查看 `latest.json`。
- 历史产物：查看 `releases/<version>/`。

油猴更新由 Tampermonkey/Violentmonkey 和用户设置控制。ZIP 或“加载已解压”安装的扩展无法静默替换自身，只会提示新版本；扩展商店安装版由浏览器负责升级。

扩展和用户脚本不读取 Cookie、浏览历史或浏览器档案，不持久保存成员名单。问题请在源码仓库报告，不要提交账号数据、成员名单或凭据。
