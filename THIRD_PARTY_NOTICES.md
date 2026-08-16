# Third-Party Notices

Stem Separator is MIT-licensed, but the self-contained app also includes a few
third-party components under their own terms:

- [FFmpeg 9.0.1](https://ffmpeg.org/) is included under LGPL-2.1-or-later. It is
  built without GPL or nonfree components from unmodified official source. The
  app includes its license and build details, and each macOS GitHub release
  includes the exact source archive.
- [python-audio-separator](https://github.com/HAGerox/python-audio-separator),
  copyright 2023 karaokenerds, is included under the MIT License. It builds on
  work by the [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui)
  project and its contributors.
- [DiffQ](https://github.com/facebookresearch/diffq), by Alexandre Défossez,
  Yossi Adi, and Gabriel Synnaeve, is included unmodified under
  [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/).
- The optional Linux GPU image uses the official
  [NVIDIA CUDA base image](https://hub.docker.com/r/nvidia/cuda) under NVIDIA's
  [Deep Learning Container License](https://developer.nvidia.com/ngc/nvidia-deep-learning-container-license).

Other bundled open-source packages retain the license information supplied in
their package metadata. Model files are downloaded directly from their
original hosts and are not distributed by this project; they remain subject to
their authors' terms.
