# Optional third-party assets

The source repository intentionally excludes large model and runtime binaries.
This keeps the Git history small and avoids redistributing files without a clear
license trail.

- FFmpeg: development can use `ffmpeg` and `ffprobe` from `PATH`. To package a
  Windows installer, place verified builds in `build/ffmpeg/` and keep the
  matching license and source-offer information beside them.
- Pose features: the DWPose ONNX model is optional and is not stored in Git or
  bundled in the installer. The settings page downloads it directly from the
  official `yzd-v/DWPose` Hugging Face repository, verifies the pinned size and
  SHA-256, and installs it under the current user's application-data directory.
  The pinned upstream revision is `1a7144101628d69ee7a3768d1ee3a094070dc388`;
  file `dw-ll_ucoco_384.onnx`, size `134399116`, SHA-256
  `724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843`.
  The upstream model card declares Apache-2.0. Basic text, image, video, speech
  generation and local project work do not depend on this model.

Do not open an issue asking users to download an unverified binary mirror.
