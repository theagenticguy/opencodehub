---
title: pnpm install hangs on Amazon EFS-mounted workdir without store-dir + UV_USE_IO_URING=0
tags: [pnpm, efs, nfs, al2023, devbox, install-performance]
first_applied: 2026-05-08
repos: [opencodehub]
---

## The pattern

`pnpm install` on an EFS-mounted working directory (typical Amazon
devbox setup where home is local but the source tree is under `/efs`)
will hang for 4-8 minutes with zero stdout, then eventually complete.
Two stacked causes:

1. **pnpm CAS store lands on EFS by default.** `pnpm store path` will
   show something like `/efs/<user>/.pnpm-store/v10` when your HOME
   resolves through EFS. Every CAS lookup becomes a ~22 ms NFS
   round-trip (vs ~200 µs on local EBS/XFS) — a 100× latency gap.
   With 800+ packages × dozens of files each, install is O(N) in NFS
   stat/create syscalls.
2. **AL2023 kernel `io_uring` cleanup bug**
   ([amazonlinux/amazon-linux-2023#856](https://github.com/amazonlinux/amazon-linux-2023#856))
   causes Node processes to appear hung during cleanup. Symptom:
   pnpm's progress output stops emitting; process shows 1% CPU; then
   minutes later a flurry of "Progress: resolved X, reused Y" lines
   pops out at once.

## Fix

**User-global `~/.npmrc`** (not committed to the repo — team members
on other hosts may want different tunings):

```
store-dir=/home/<user>/.local/share/pnpm-store
package-import-method=hardlink
```

**Shell env** for installing (add to `~/.zshrc` permanently until AL2023
backports the kernel fix):

```bash
export UV_USE_IO_URING=0
```

If you're applying this change on an EFS workdir with an existing
`node_modules/`, pnpm will refuse to rebuild it without TTY — use
`CI=true pnpm install --no-frozen-lockfile` the first time so pnpm
can purge the old modules dir and repopulate from the new store
location. After the first warm install, subsequent installs hardlink
from local XFS and finish in ~5 seconds.

## Verification

Before: `pnpm install` → 8+ minutes, mostly silent
After: `pnpm install --prefer-offline` → 4.6 seconds

Check that the store moved: `pnpm store path` should no longer return
an `/efs/...` path.

## Sources

- pnpm FAQ — cross-filesystem store falls back to copy, not hardlink
- pnpm settings reference — `store-dir`, `package-import-method`,
  `virtual-store-dir`
- kdgregory blog, "EFS Performance Take 3" — bonnie++ file-create
  latency EFS 22,516 µs vs EBS 218 µs
- [amazonlinux/amazon-linux-2023#856](https://github.com/amazonlinux/amazon-linux-2023/issues/856)
  — `UV_USE_IO_URING=0` workaround for io_uring hang
