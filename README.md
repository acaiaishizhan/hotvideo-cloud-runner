# hotvideo-cloud-runner

Personal automation runner.

New videos save their source thumbnail as `cover.*` through `video-infra thumbnail`
and attach it to the existing Feishu cover field. Existing attachments are preserved.
Cover failures remain recoverable even when the video record was already published.
