# hotvideo-cloud-runner

公开的热门视频云端执行器。Windows 只负责复用已登录的抖音 Chrome 抓取榜单；本仓库通过 GitHub Actions 完成视频下载、豆包分析和飞书多维表发布。

```text
Windows Chrome 登录态
  -> queue/<run-id>.json
  -> push main
  -> GitHub Actions
  -> 下载视频
  -> 豆包分析
  -> 飞书 Base（bot 身份）
```

## 仓库边界

- 仓库只保存公开网页 URL 和榜单上下文，不保存视频文件、飞书记录或运行结果。
- 所有凭据只放 GitHub Actions Secrets。
- 云端不抓取抖音热点宝，不需要也不接收 Chrome Cookie。
- 请只处理你有权处理的视频，并遵守平台规则和所在地法律。

## Actions Secrets

| 名称 | 用途 |
| --- | --- |
| `ARK_API_KEY` | 火山方舟 Coding Plan 视频分析 |
| `LARK_APP_ID` | 飞书应用 ID |
| `LARK_APP_SECRET` | 飞书应用密钥 |
| `HOTVIDEO_FEISHU_BASE_TOKEN` | 目标多维表 token |
| `HOTVIDEO_FEISHU_TABLE_ID` | 目标数据表 ID |

飞书应用需拥有目标 Base 的 bot 访问权限，以及记录读写、字段读取和附件上传权限。

## 本地测试

```bash
npm test
python -m pip install -e ./video-infra
```
