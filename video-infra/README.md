# video-infra

`video-infra` 是视频数据与文件获取基建，不是选题系统。

它负责：

- 根据 URL 解析视频元数据
- 标准化不同平台的字段
- 下载视频文件
- 获取短期直链、字幕、封面等原始事实信号
- 给 `hotvideo`、`Discover`、`VideoCreator` 等上游提供统一 JSON

它不负责：

- 热点搜索
- 选题评分
- 内容角度生成
- 发布/剪辑业务流程
- 产品前端

## 默认输出

默认运行产物写到：

```text
out/video-infra/
  videos/
  metadata/
  thumbnails/
  subtitles/
```

调用方可以用 `--output-dir` 覆盖。例如 `hotvideo` 可以把单条视频写进自己的业务目录。

## CLI

开发态运行：

```bash
python -m video_infra parse <url>
python -m video_infra download <url>
python -m video_infra fetch <url> --output-dir ../hotvideo/videos/douyin-hotspot/<id>
```

如果没有安装包，先设置源码路径：

```powershell
$env:PYTHONPATH="F:\coding\solo-company\video-infra\src"
python -m video_infra parse "<url>"
```

## Schema 原则

`video-infra` 会保留选题可能用到的原始字段，例如播放、点赞、评论、转发、作者粉丝数、发布时间等，但不会输出 `topicScore`、`worthDoing`、`angle` 这类业务判断。

平台特殊字段统一放进 `raw`。

## 合规边界

仅用于你有权处理的视频、自己的内容、公开授权素材、研究和归档场景。调用方需要自行遵守所在地法律和平台服务条款。
