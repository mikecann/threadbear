# GPUI idle work, 13 November 2026

The generic loading spinner drew the window at the display refresh rate.
The current candidate limits those decorative frames through one display-link
callback per window. It leaves main's sidebar arc layer and one-second clock
unchanged. Two kit Button controls still use their own internal loaders.

## Current-main controlled comparison, 14 November

All three binaries use source base `ea287d570` and identical read-only
`frame-stats` instrumentation. A is the stock loader, B is the retained loader
with a shared display clock, and T paints the same icon in its parent using
the existing 20 ms background timer. The build order was B/T/A/B in one
source directory, restoring fresh source contents between variants.

Tinker Desk, 60 Hz, release `automation,frame-stats`, a 1,500-turn transcript
and 1,450 other threads, 1,400 archived. Three alternating pairs follow a
separate discarded warm-up pair. Each measured interval lasts eight seconds.
Seven owned workers supply the loaded condition. CPU is percent of one core;
compare paired arms within each load condition.

| Scene | Metric | Stock A | Candidate B | B/A |
|---|---|---:|---:|---:|
| Loading, normal | App CPU | 47.533 | 29.095 | 0.612 |
| Loading, normal | Main-thread CPU | 41.350 | 25.310 | 0.612 |
| Loading, normal | Drawn frames/s | 60.868 | 31.370 | 0.515 |
| Loading, normal | Interrupt wakeups/s | 64.867 | 65.123 | 1.004 |
| Loading, seven cores busy | App CPU | 20.425 | 11.663 | 0.571 |
| Loading, seven cores busy | Drawn frames/s | 60.742 | 30.618 | 0.504 |
| Loading, seven cores busy | Interrupt wakeups/s | 69.239 | 66.986 | 0.967 |

CPU ranges do not overlap: 47.05–47.86 versus 28.78–29.14% normally,
and 20.04–20.43 versus 11.56–11.85% under load. Main-thread CPU per drawn
frame rises from 6.81 to 8.00 ms normally and 3.10 to 3.52 ms under load.
The saving comes from fewer decorative frames, not cheaper frames or a
measured input-latency improvement.

This is a separate set of three alternating T/B pairs per condition, with its
own discarded warm-up pair.

| Scene | Metric | Parent timer T | Candidate B |
|---|---|---:|---:|
| Normal | App CPU | 25.267 | 29.555 |
| Normal | Drawn frames/s | 25.248 | 32.373 |
| Normal | Interrupt wakeups/s | 88.118 | 64.737 |
| Seven cores busy | App CPU | 12.639 | 11.856 |
| Seven cores busy | Drawn frames/s | 31.121 | 31.994 |
| Seven cores busy | Interrupt wakeups/s | 94.854 | 67.360 |

The timer draws fewer frames normally and adds wakeups in both conditions.
This comparison does not independently establish a benefit from retaining a
spinner entity. A fourth control P uses B's display clock but paints directly in the parent.
Its three pairs per condition gave these medians:

| Scene | Metric | Inline parent P | Retained B |
|---|---|---:|---:|
| Normal | App CPU | 29.684 | 29.475 |
| Normal | Drawn frames/s | 32.119 | 31.873 |
| Normal | Interrupt wakeups/s | 64.364 | 64.738 |
| Normal | Main-thread ms/frame | 8.054 | 8.087 |
| Seven cores busy | App CPU | 11.767 | 11.621 |
| Seven cores busy | Drawn frames/s | 31.494 | 31.995 |
| Seven cores busy | Interrupt wakeups/s | 68.119 | 67.115 |
| Seven cores busy | Main-thread ms/frame | 3.477 | 3.457 |

Frame rates differ by less than 2%, and CPU/wakeup ranges overlap. This held
transcript scene did not establish a saving from retaining a spinner entity.
The selected implementation drops the entity and element-state machinery,
keeping the shared display clock. GPUI still redraws ancestor views.
No 120 Hz result is claimed. P's binary is
`120f72d54f8a88b65965ba748f3a0fca8c1685341e2e9cb12e3e29f47b41fd73`.
Final code adds recovery for late or lost frame callbacks while preserving
cached siblings' demand; that recovery remains to
be checked in a final native build.

The whole leased phase kept the display awake and parked the pointer outside
the app, restoring it afterwards. A bounded quiet gate required three minutes
below load 5 with Spotlight quiet. All measured samples passed the unchanged
external foreground, awake, unlocked and uncovered guards, with the native
GPUI active flag true at both endpoints. External metadata reports 60 Hz,
normal thermal state and Low Power Mode off. Window-watch rates were about
four checks/s, with no automation polling during the CPU interval.
All 32 recorded app processes and the separate Swift functional process were
gone in the subsequent PID lookup. Representative normal, loaded and Swift
window captures were inspected.

Binary SHA-256:

- A: `8606dcf2c721f1f84c71bbd7c10ee618accee3d56f64b540968cfd0a1b3367e1`.
- T: `477d198be73b06581338c33cd2ceed3122823597d15af3fdd6475c7c5f76d255`.
- B: `ece821fa783a66ad06d431cea9125260ad2770dd80d6332d253486e699dc8c9b`.

## Earlier prototypes

The following tables describe isolated prototypes on source base `1a759443d`.
They included changes to working arcs and, later, the busy clock that the
current integration drops. Current main subsequently gained its own separate
layer for sidebar arcs. Earlier records have external foreground/coverage
proof but lack the new native active flag and thermal/Low Power metadata.
Use them as exploratory results, not as the final integrated change's proof.

## Method

Tinker Desk, release builds with `automation,frame-stats`, 60 Hz screen.
The synthetic fixture has a 1,500-turn transcript and 1,450 other threads,
1,400 of them archived. A held transcript read isolates the loading spinner;
the working-row phase instead adds a quiet running turn in another thread.
Both binaries use the same source base, `1a759443d`, apart from this change.
The timer and first display-link experiments were recorded before Tinker's
14 November macOS update.
The final refinement is built on the updated machine with the same SDK and
linker as the original binary. Its first paired measurements appear below;
absolute CPU values from either side of the OS update should not be compared.

`features/tools/idle-ab.mjs` discards a warm-up pair, alternates AB/BA, and
records each binary's SHA-256, the ambient load and every sample. The timed
interval is eight seconds, with no automation polling during it. Stress runs
keep every core but one busy with bounded, owned workers. Build commands and
measurements hold the shared host locks; only builds run at background priority.

CPU is percent of one core, from process CPU time. Main-thread CPU is measured
separately. Wakeups come from `proc_pid_rusage`; frames and main-thread CPU
come from the app's frame counters. Command round trips happen afterwards and
include automation transport and caller scheduling, so they are not a measure
of input-to-paint latency. Compare CPU within each load condition: scheduling
on different cores changes the CPU time spent doing the same work.

## Rejected timer version

Five measured pairs in each condition, reported as medians:

| Condition | Metric | Original | Timer version | Ratio |
|---|---|---:|---:|---:|
| Normal | App CPU, % of one core | 45.99 | 23.99 | 0.521 |
| Normal | Main-thread CPU, % | 42.39 | 21.38 | 0.504 |
| Normal | Frames/second | 61.87 | 30.37 | 0.491 |
| Normal | Interrupt wakeups/second | 65.87 | 93.36 | 1.417 |
| Seven of eight cores busy | App CPU, % | 21.50 | 13.01 | 0.605 |
| Seven of eight cores busy | Main-thread CPU, % | 20.48 | 12.30 | 0.601 |
| Seven of eight cores busy | Frames/second | 61.11 | 29.87 | 0.489 |
| Seven of eight cores busy | Interrupt wakeups/second | 67.96 | 89.24 | 1.313 |

The CPU saving came from drawing fewer frames. Normal main-thread CPU per
frame stayed about the same, 6.85 versus 6.96 ms. The extra timer increased
wakeups, so that version was held back.

## Display-link version

Five new paired rounds, with the same original binary and the revised
candidate. These runs were later than the timer experiment; compare the two
binaries within this table rather than absolute CPU across the experiments.

| Condition | Metric | Original | Display-link version | Ratio |
|---|---|---:|---:|---:|
| Normal | App CPU, % of one core | 49.10 | 30.80 | 0.627 |
| Normal | Main-thread CPU, % | 44.96 | 28.16 | 0.626 |
| Normal | Frames/second | 62.24 | 32.74 | 0.526 |
| Normal | Interrupt wakeups/second | 65.36 | 66.11 | 1.011 |
| Seven of eight cores busy | App CPU, % | 21.79 | 14.92 | 0.685 |
| Seven of eight cores busy | Main-thread CPU, % | 20.81 | 14.46 | 0.695 |
| Seven of eight cores busy | Frames/second | 61.62 | 31.62 | 0.513 |
| Seven of eight cores busy | Interrupt wakeups/second | 66.36 | 66.87 | 1.008 |

Loading CPU fell 37% normally and 32% under load. Wakeup ranges overlap:
65.11–66.11 versus 64.49–66.61/s normally, and 66.11–68.12 versus
65.86–67.99/s under load. This removes the timer version's extra wakeups.
Main-thread CPU per drawn frame rose, 7.21 to 8.64 ms normally and 3.38 to
4.53 ms under load. The improvement comes from drawing fewer frames.

The saved binaries are identified by SHA-256:

- Original: `fafeca649231d3ae873fd57b419e47bfd5d807057512dd617b46407a669ea28e`.
- Display-link candidate: `b75400e617007897d706f2465c803c2848bb96dd99cf502e5cbcbd437bf727a1`.

The window capture under seven-core load was inspected: the loader remains
centred above the empty transcript.

The settled-idle comparison was unchanged within the sample ranges: 3.10 to
3.00% CPU, 18.00 to 17.87 wakeups/s and two frames/s. Three measured pairs.

## Rejected working-arc change

The same shared display clock also sped up the existing sidebar arc, which
already had a timer. Three paired rounds exposed a regression:

| Condition | Metric | Original | Shared-clock arc | Ratio |
|---|---|---:|---:|---:|
| Normal | App CPU, % of one core | 38.30 | 40.08 | 1.046 |
| Normal | Frames/second | 22.00 | 28.99 | 1.318 |
| Normal | Interrupt wakeups/second | 68.86 | 59.49 | 0.864 |
| Seven of eight cores busy | App CPU, % | 27.27 | 32.92 | 1.207 |
| Seven of eight cores busy | Frames/second | 23.73 | 28.36 | 1.195 |
| Seven of eight cores busy | Interrupt wakeups/second | 79.05 | 61.75 | 0.781 |

Despite lower wakeups, the extra redraws raised working-row CPU under load.
That arc scheduler is held back. The refinement restores its previous timer,
while keeping the generic loading-spinner clock. Its working-row comparison
is pending, including a loader beside a working arc: two clocks can draw on
staggered frames, so the isolated loading result does not cover that case.

## Retained loader with the original arc timer

On 14 November, after the OS update, both saved binaries ran on the same
machine. Load stayed below five and Spotlight stayed quiet for three minutes
before the run. An external watcher confirmed the owned 1180 × 800 window
stayed active, awake and uncovered throughout each interval, without enabling
the app's accessibility tree. Its largest sampling gap was 324 ms.

The combined script inherited the smoke test's disabled warm-up setting.
Discarding its first pair leaves four measured AB/BA pairs per condition:

| Condition | Metric | Original | Refinement | Ratio |
|---|---|---:|---:|---:|
| Normal | App CPU, % of one core | 48.161 | 29.086 | 0.604 |
| Normal | Main-thread CPU, % | 42.086 | 25.347 | 0.602 |
| Normal | Frames/second | 60.803 | 31.934 | 0.525 |
| Normal | Interrupt wakeups/second | 65.360 | 65.182 | 0.997 |
| Seven of eight cores busy | App CPU, % | 19.675 | 11.642 | 0.592 |
| Seven of eight cores busy | Main-thread CPU, % | 18.159 | 10.721 | 0.590 |
| Seven of eight cores busy | Frames/second | 60.613 | 31.243 | 0.516 |
| Seven of eight cores busy | Interrupt wakeups/second | 69.113 | 66.610 | 0.964 |

Normal app CPU ranges were 47.36–49.55 versus 28.93–29.86%; wakeups were
64.86–65.49 versus 64.86–66.36/s. Under load, CPU was 19.42–20.20 versus
11.51–11.93%; wakeups were 67.86–69.86 versus 65.24–67.12/s. Ambient
one-minute load ranged from 1.46 to 2.73 normally and 6.61 to 8.33 during
the seven-worker stress run.

The loader used about 40% less app CPU in each condition by drawing fewer
frames. Main-thread CPU per drawn frame rose from 6.92 to 8.05 ms normally
and 2.99 to 3.47 ms under load. These results do not measure input latency.
Both window captures were inspected; the loader remains centred in the
empty transcript under load. All 22 app processes from this run were gone
after normal completion.

Refinement SHA-256:
`a6a5443fc7d4448410b6c1671b34b4b108c4b296677649b8dc2a27b4d6304fae`.
The visible working-row, repeated offscreen, clock and Swift comparisons
are still pending. A single four-second offscreen smoke
pair passed the guards and stopped the clipped arc's extra frames; it is
validation, not a repeated performance result.

With a visible working arc beside the loader, five measured pairs followed
a discarded warm-up pair in each condition:

| Condition | Metric | Original | Refinement | Ratio |
|---|---|---:|---:|---:|
| Normal | App CPU, % of one core | 45.147 | 38.460 | 0.852 |
| Normal | Main-thread CPU, % | 42.178 | 37.063 | 0.879 |
| Normal | Frames/second | 60.740 | 23.621 | 0.389 |
| Normal | Interrupt wakeups/second | 79.613 | 70.112 | 0.881 |
| Seven of eight cores busy | App CPU, % | 36.734 | 30.503 | 0.830 |
| Seven of eight cores busy | Main-thread CPU, % | 35.326 | 29.554 | 0.837 |
| Seven of eight cores busy | Frames/second | 60.734 | 40.246 | 0.663 |
| Seven of eight cores busy | Interrupt wakeups/second | 87.115 | 82.980 | 0.953 |

App CPU ranges did not overlap: 44.90–45.52 versus 38.02–38.77% normally,
and 36.18–37.22 versus 30.13–30.99% under load. The normal mixed scene drew
22.87–24.75 frames/s in the refinement, below the isolated loader's cadence.
Main-thread CPU per drawn frame was 6.96 versus 15.69 ms normally and 5.82
versus 7.38 ms under load. This result measures the two clocks together;
it does not establish that a working row without a loader is cheaper.

The mixed run held a display-awake assertion throughout its quiet gate and
both arms. The pointer was saved, moved outside the app without a click and
restored on exit. Two earlier attempts recorded no samples because the strict
coverage watcher rejected the pointer's own WindowServer window. Its bounds
were 28 × 40 points and its layer matched the SDK's cursor level. The guard
was kept unchanged; only its diagnostic gained layer and bounds. Both final
window captures were inspected, all 24 recorded app processes were gone, and
the wrapper confirmed pointer restoration and normal completion.

## Input latency context

The separate [hover measurements](perf-hover.md) on current main used a
1,400-thread mock shaped like Mike's data. In three paired runs, pointer to
the display link's target presentation time had median thread-row hover
latency of 65–66 ms normally and 63–64 ms with seven cores busy. Projects
rows were 63 ms normally and 61–63 ms busy; presses were 76 and 61 ms.
About 5 ms preceded handling, 28 ms preceded frame handover, and 31 ms
followed handover to the target presentation time. These are hover/press
frames on a different build, and do not establish an input-latency improvement
from the loading-spinner change.

## Priority and Swift reference

Read-only snapshots of the installed GPUI app showed nice 0, priority 54 while
active and priority 4 while inactive. Those snapshots do not establish a
thread's QoS policy, but do not support forcing a priority override. The
self-updater relaunches through LaunchServices, using `open -g` when the app
should return behind another application. No priority change is included.

The runner's LaunchAgent sets no `ProcessType`, nice value or low-priority I/O
policy. The separate GitHub-token helper is marked Background and does not
launch the GUI. A later read-only thread snapshot of the installed app showed
nice 0 and priorities in the normal UI range; it was not an idle CPU sample.

In the pinned `gpui-pre-apple` 0.3.11 dispatcher, foreground tasks go to the
main GCD queue, while delayed tasks use a high-priority global queue. On
macOS 14 and later the platform paces windows with `CAMetalDisplayLink`.
I found no explicit user-interactive QoS request in the Apple/macOS platform
paths. These paths and priority snapshots do not establish every thread's
effective QoS, but give no evidence for a blanket priority override.

The available Swift reference is a cached debug build, launched directly by
the benchmark's owned-process adapter. Its launch/readiness/cleanup smoke
passed against the same binary launched through LaunchServices, but the
observed priorities differed: 37 for direct launch and 47 for LaunchServices,
both nice 0. This does not prove timing, QoS or App Nap equivalence.
The original reference smoke also did not record the foreground process.
A later strict check rejected the Swift launch because it was not the active
app, while GPUI was covered by a system crash-report dialog. Those runs
recorded no CPU samples. A subsequent functional check targeted the existing private PID with
`NSRunningApplication`, checked its canonical executable path, and requested
activation without launching a replacement. It recorded the owned PID as the
foreground app, `isActive: true`, and then passed the unchanged two-second
external coverage watch. Priority was 37, nice 0. This establishes foreground
app activation for that smoke, not key-window state or production equivalence.
CPU reference intervals remain pending.

Any Swift comparison is labelled debug/direct and covers app-process CPU and
wakeups. It excludes animation work in the render server; GPUI's process
counters also exclude Chromium helper processes. Swift's loading dump has no
spinner field, so the reference covers settled and working-thread phases.

## Checks

Eight renderer tests and the existing arc-fade test cover timed repaints through cached parents, a loader
beside a legacy working arc, an early callback that draws nothing, and one
callback/notification per painted parent even with multiple loaders. They also
cover Reduce Motion, clipping, hiding, window close and recovery from a stale
clock record without dropping another cached parent's demand. A generation test checks that an old callback cannot create a
second replacement chain. The CI gate enumerates at least nine tests before
running them, so a missing feature gate cannot silently pass with zero tests.

Earlier observer tests established that the retained candidate did not notify
its parent model. They did not establish that it avoided parent rendering.
The selected inline implementation notifies painted parent views and makes
no observer-isolation claim. The sidebar arc layer is unchanged.

The reviewed deadline starts at paint time. Long frames can therefore reduce
the indicator's cadence below 30 Hz; frame rate is reported beside CPU rather
than attributing every CPU reduction to cheaper frames.
