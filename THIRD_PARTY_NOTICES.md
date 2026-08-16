# Third-Party Notices

Stem Separator is built with open-source software and runs third-party audio
separation models. The project's MIT license covers only original Stem
Separator code. Each third-party component and model remains subject to its
own terms.

This file provides prominent credits and release-review notes. Exact dependency
versions are recorded in `package-lock.json`, `src-tauri/Cargo.lock`, and
`server/uv.lock`. Distributed Python packages retain the license files from
their package metadata, and the macOS resource bundle retains the Python and
FFmpeg license files supplied with those components.

## Separation technology

- [python-audio-separator](https://github.com/HAGerox/python-audio-separator),
  copyright 2023 karaokenerds, is used under the MIT License.
- Much of python-audio-separator is derived from
  [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui).
  Credit belongs to Anjok07 and the UVR developers, including DilanBoskan,
  Kuielab and Woosung Choi, KimberleyJSN, Hv, and zhzhongshi.
- [DiffQ](https://github.com/facebookresearch/diffq), by Alexandre Défossez,
  Yossi Adi, and Gabriel Synnaeve, is included in the separation runtime under the
  [Creative Commons Attribution-NonCommercial 4.0 License](https://creativecommons.org/licenses/by-nc/4.0/).
- [PyTorch](https://github.com/pytorch/pytorch),
  [ONNX Runtime](https://github.com/microsoft/onnxruntime),
  [librosa](https://github.com/librosa/librosa), and their transitive
  dependencies retain their upstream copyright and license terms.
- [FFmpeg](https://ffmpeg.org/) is used for media inspection, audio extraction,
  and video output. Its license text is shipped beside the macOS binaries;
  Linux installations use the FFmpeg package supplied by the user's operating
  system or container image.
- The Linux GPU image is based on the
  [NVIDIA CUDA container](https://hub.docker.com/r/nvidia/cuda) and is governed
  by NVIDIA's applicable container and software license agreements.

## Application technology

- [Tauri](https://github.com/tauri-apps/tauri) and its official plugins are
  available under Apache-2.0 or MIT terms.
- [React](https://github.com/facebook/react) is copyright Meta Platforms, Inc.
  and affiliates and is available under the MIT License.
- [Lucide](https://github.com/lucide-icons/lucide) is copyright Lucide
  Contributors and is available under the ISC License.

Additional JavaScript, Rust, Python, CUDA, and operating-system components are
listed in the relevant lockfiles or installed-package metadata and remain
under their respective licenses.

## Models

Model files are downloaded on demand and are not covered by Stem Separator's
MIT License. Their authors, sources, hashes, and known license information are
recorded in the
[Stem Separator Models registry](https://github.com/HAGerox/Stem-Separator-Models/blob/main/registry.json).
An `unknown` license entry means that permission has not been established; it
does not mean unrestricted use is allowed.

## Distribution review required

Attribution alone does not make every current dependency suitable for every
kind of distribution or use.

- The FFmpeg binaries currently prepared for the macOS bundle report
  `--enable-gpl`, `--enable-version3`, and `--enable-nonfree`. FFmpeg states
  that a binary built with `--enable-nonfree` is unredistributable. Do not
  publish the current macOS binary bundle until it uses a redistributable
  FFmpeg build and the applicable source-and-notice obligations are met.
- DiffQ's CC BY-NC 4.0 terms restrict use to noncommercial purposes unless
  separate permission is obtained.
- Publication of the derived CUDA image must comply with the NVIDIA licenses
  governing its base image and included CUDA components.
- At the time of this audit, most models in the registry have an `unknown`
  license, while Becruily Deux is recorded as CC BY-NC 4.0. Model eligibility
  for a particular product or use therefore needs separate review.

This is a factual project notice, not legal advice. A release owner should
repeat the audit for the exact artifacts being distributed and obtain legal
advice where appropriate.
