// Where a live patch (desktop/scripts/hotpatch.sh) reaches the running app.
//
// subsecond swaps in new code only where a call passes through its jump
// table: GPUI sends every view's render through it (vendor/gpui-pre's
// hot_reload.rs), but anything the app handed over once and is called back
// through later (the dock's DockContent, the runner's event loop) holds the
// old code, and a fix there never showed (Seth, 18 Nov: the header's patch
// built and nothing changed). `call` is such a pass; without the hotpatch
// feature, a plain call.

#[cfg(feature = "hotpatch")]
#[inline(always)]
pub(crate) fn call<R>(f: impl FnMut() -> R) -> R {
    subsecond::call(f)
}

#[cfg(not(feature = "hotpatch"))]
#[inline(always)]
pub(crate) fn call<R>(mut f: impl FnMut() -> R) -> R {
    f()
}
