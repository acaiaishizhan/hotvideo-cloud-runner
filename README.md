# hotvideo-cloud-runner

Personal automation runner.

## Production paused (2026-09-14)

Both GitHub workflows are disabled. Production collection, audio transcription,
video analysis and Feishu delivery now run on the existing Windows host through
`solo-company/hotvideo`. Cloud Files uploads failed with both upload clients even
after compression, while the local path passed real delivery checks.
Queue files and receipts are retained for investigation. Do not automatically
resume old queue files or reactivate these workflows.

New videos save their source thumbnail as `cover.*` through `video-infra thumbnail`
and attach it to the existing Feishu cover field. Existing attachments are preserved.
Cover failures remain recoverable even when the video record was already published.

Source-confirmed image posts carry `context.nonVideoReason` and are excluded before
download and analysis. Missing duration alone is not sufficient evidence.
Analysis concurrency is 2; transient chat request errors get at most 2 retries with
30/60 second delays. Invalid inputs and authentication errors are not retried.
The analyzer default follows the current source runtime: `doubao-seed-2.1-turbo`.
