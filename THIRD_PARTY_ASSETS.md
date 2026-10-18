# Optional third-party assets

The source repository intentionally excludes large model and runtime binaries.
This keeps the Git history small and avoids redistributing files without a clear
license trail.

- FFmpeg: development can use `ffmpeg` and `ffprobe` from `PATH`. To package a
  Windows installer, place verified builds in `build/ffmpeg/` and keep the
  matching license and source-offer information beside them.
- Pose features: DWPose ONNX and copied MediaPipe/ONNX Runtime web assets are
  optional. Basic text, image, video, speech generation and local project work do
  not depend on the DWPose model. Maintainers should document the exact upstream
  release, license and checksum before publishing these assets.

Do not open an issue asking users to download an unverified binary mirror.
