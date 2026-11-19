// The Terminal panel (⌘J, View > Show Terminal): a real terminal in the dock,
// as VS Code and T3 Code have under their editor (TerminalPanel.swift).
// alacritty_terminal keeps the screen and runs your login shell in a pty, so
// colours, the cursor keys and full-screen programs (vim, htop, claude) work as
// in Terminal; terminal_element.rs draws it, and the rules with no window in
// them (the keys, the folder, putting a command) are threadbear_core::terminal.
//
// Each thread has shells of its own, as tabs along the top of the panel (+
// for another, ✕ to close one, double-click or right-click to rename one),
// started in the thread's folder (its worktree when it has one) and kept
// running while you look at other threads, so switching back finds them as
// you left them. `exit` in one of several closes its tab. A thread on another machine gets
// a shell on this Mac in your home folder, with a line saying so, as its folder
// isn't here; with no thread open it's a shell in your home folder too.
//
// A shell only starts when you ask for one: ⌘J, clicking the empty panel, or a
// shell block's play icon. Clicking through threads with the panel open, or
// launching with it left open, starts nothing, as each login shell reads your
// whole profile. A thread's shell stops when the thread is archived or deleted
// (a dev server left running there would otherwise keep going in a worktree
// the next thread gets), and every shell stops when the app quits.
use crate::app::Threadbear;
use crate::style::{self, px};
use crate::terminal_element::TerminalElement;
use crate::tips::Tip as _;
use alacritty_terminal::event::{Event as TermEvent, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{
    Boundary, Column, Direction, Line as GridLine, Point as GridPoint, Side,
};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::search::{Match, RegexSearch};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::tty;
use alacritty_terminal::vte::ansi::{CursorShape, CursorStyle};
use gpui_kit::component::input::{Input, InputEvent as FieldEvent, InputState};
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenuItem};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use threadbear_core::terminal::{
    self as rules, KeyAction, Line, ShellBlock, Step, Target, TerminalKey,
};
use threadbear_dock::{DockDrop, DockEdge, DockNode, DockSplit};

// ---------------------------------------------------------------- hooking in

/// The app's one set of shells, reached from the panel, the menus, a shell
/// block's play icon and the automation.
struct TerminalsGlobal(Entity<Terminals>);
impl Global for TerminalsGlobal {}

/// Made with the app (`Threadbear::new`), before anything can ask for a shell.
pub(crate) fn install(app: &Entity<Threadbear>, cx: &mut App) {
    cx.bind_keys(own_keys());
    let terminals = cx.new(|cx| Terminals::new(app, cx));
    cx.set_global(TerminalsGlobal(terminals));
}

/// The keys that go no further than the terminal's own key handler. Tab and
/// Shift-Tab move the keyboard between controls, and ⌘C copies a text
/// selection, in the window's root (gpui-kit's own keys): in the terminal
/// they're the shell's (completion, and ^C off the Mac). And its copy, paste
/// and select-all keys off the Mac, Control-Shift C, V and A, are its own
/// too: Control-Shift-C is also Copy Transcript as Markdown there, so in the
/// terminal it copied the whole thread rather than what was selected (11
/// Nov). The app's command keys have no context, which ties with these at
/// the terminal's depth, and a tie goes to whichever was bound last, so
/// `apply_shortcuts` binds these again after binding the commands.
pub(crate) fn own_keys() -> Vec<KeyBinding> {
    let mut chords = vec!["tab", "shift-tab"];
    let ctx = Some(KEY_CONTEXT);
    if !cfg!(target_os = "macos") {
        chords.extend(["ctrl-c", "ctrl-shift-c", "ctrl-shift-v", "ctrl-shift-a"]);
        return chords
            .into_iter()
            .map(|chord| KeyBinding::new(chord, NoAction, ctx))
            .collect();
    }
    // ⌘⌫, ⌘← and ⌘→ are the shell's line editing keys (`rules::command_key`),
    // sent from the key handler, so no command in shortcuts.json takes them.
    chords.extend(["cmd-backspace", "cmd-left", "cmd-right"]);
    let mut keys: Vec<KeyBinding> = chords
        .into_iter()
        .map(|chord| KeyBinding::new(chord, NoAction, ctx))
        .collect();
    // Terminal.app's keys, where they don't clash with Threadbear's own
    // (⌘K is Open Anything, ⌘1 to ⌘7 the sidebar, ⇧⌘[ and ⇧⌘] the panel's
    // tabs, ⌘W the window, ⌘E Archive, ⌘. Stop): ⌘L clears rather than ⌘K,
    // and ⌃Tab goes between shells. Copy, Paste and Select All are actions,
    // so the right-click menu shows their keys.
    keys.extend([
        KeyBinding::new("cmd-c", TerminalCopy, ctx),
        KeyBinding::new("cmd-v", TerminalPaste, ctx),
        KeyBinding::new("cmd-a", TerminalSelectAll, ctx),
        KeyBinding::new("ctrl-cmd-v", PasteEscaped, ctx),
        KeyBinding::new("cmd-l", ClearToStart, ctx),
        KeyBinding::new("alt-cmd-k", ClearScrollback, ctx),
        KeyBinding::new("alt-cmd-r", ResetTerminal, ctx),
        KeyBinding::new("cmd-f", FindInTerminal, ctx),
        KeyBinding::new("cmd-g", FindOlder, ctx),
        KeyBinding::new("cmd-shift-g", FindNewer, ctx),
        KeyBinding::new("cmd-t", NewShell, ctx),
        KeyBinding::new("ctrl-tab", NextShell, ctx),
        KeyBinding::new("ctrl-shift-tab", PreviousShell, ctx),
        KeyBinding::new("cmd-up", PreviousMark, ctx),
        KeyBinding::new("cmd-down", NextMark, ctx),
        KeyBinding::new("cmd-home", ScrollToTop, ctx),
        KeyBinding::new("cmd-end", ScrollToBottom, ctx),
    ]);
    keys
}

actions!(
    terminal,
    [
        TerminalCopy,
        TerminalPaste,
        TerminalSelectAll,
        PasteEscaped,
        ClearToStart,
        ClearScrollback,
        ResetTerminal,
        FindInTerminal,
        FindOlder,
        FindNewer,
        NewShell,
        NextShell,
        PreviousShell,
        PreviousMark,
        NextMark,
        ScrollToTop,
        ScrollToBottom,
        OpenMenuLink,
    ]
);

pub(crate) const KEY_CONTEXT: &str = "Terminal";

fn terminals(cx: &App) -> Option<Entity<Terminals>> {
    cx.try_global::<TerminalsGlobal>().map(|g| g.0.clone())
}

/// The Terminal draws its own text rather than using a kit input. Its
/// keyboard focus must suppress an older reply selection in text services.
/// This only reads existing focus handles; it never starts a shell.
pub(crate) fn has_focus(window: &Window, cx: &App) -> bool {
    terminals(cx).is_some_and(|terminals| {
        terminals
            .read(cx)
            .all()
            .any(|session| session.read(cx).focus.is_focused(window))
    })
}

/// Whether any shell has something an update's restart would lose, as
/// quitting ends every shell: a program running in it, or words at its
/// prompt (core's `holds_a_restart`). Asked once a second (app_update.rs).
pub(crate) fn holds_a_restart(cx: &App) -> bool {
    let Some(terminals) = terminals(cx) else {
        return false;
    };
    terminals.read(cx).all().any(|s| {
        let s = s.read(cx);
        rules::holds_a_restart(s.running(), s.shell_alone_in_front(), &s.line)
    })
}

/// What the dock shows for the Terminal panel: the panel's own view, which
/// draws again only when it or its shell changes, not with the whole app.
pub(crate) fn panel_view(cx: &mut App) -> AnyElement {
    match terminals(cx) {
        Some(t) => AnyView::from(t)
            .cached(StyleRefinement::default().size_full())
            .into_any_element(),
        None => div().into_any_element(),
    }
}

/// ⌘J (`toggleTerminal`): hides the Terminal if it's showing, else brings it
/// up under the thread (a third of its height, as VS Code opens its own) with
/// the thread's shell, started if it has none, and gives it the keyboard.
pub(crate) fn toggle(app: &mut Threadbear, window: &mut Window, cx: &mut Context<Threadbear>) {
    if app.dock.read(cx).is_showing(crate::shell::TERMINAL) {
        app.dock
            .update(cx, |m, cx| m.close(crate::shell::TERMINAL, cx));
        return;
    }
    bring_up(app, cx);
    let target = target_of(app);
    if let Some(terminals) = terminals(cx) {
        terminals.update(cx, |t, cx| {
            t.set_target(target.clone(), cx);
            let session = t.open(&target, cx);
            t.focus(&session, window, cx);
        });
    }
}

/// Shows the panel with nothing started in it (the automation's `show`, for
/// what the panel says before a shell is asked for).
fn show_panel(app: &mut Threadbear, cx: &mut Context<Threadbear>) {
    if !app.dock.read(cx).is_showing(crate::shell::TERMINAL) {
        bring_up(app, cx);
    }
}

/// `bringUpTerminal`: under the main panel with a third of its height, or
/// where it was if it's in the layout already.
fn bring_up(app: &mut Threadbear, cx: &mut Context<Threadbear>) {
    use crate::shell::{MAIN, TERMINAL};
    let layout = app.dock.read(cx).layout().clone();
    if layout.contains(TERMINAL) {
        app.dock.update(cx, |m, cx| {
            m.show(TERMINAL, &[], DockDrop::window(DockEdge::Bottom), cx)
        });
        return;
    }
    let Some(main) = layout.group_containing(MAIN) else {
        app.dock.update(cx, |m, cx| {
            m.open(TERMINAL, DockDrop::window(DockEdge::Bottom), cx)
        });
        return;
    };
    let mut layout = layout;
    layout.add(TERMINAL, DockDrop::edge(main.id, DockEdge::Bottom));
    if let Some((id, 2)) =
        split_around(TERMINAL, &layout.root).map(|s| (s.id.clone(), s.children.len()))
    {
        layout.set_fractions(&id, &[0.68, 0.32]);
    }
    app.dock.update(cx, |m, cx| m.set_layout(layout, cx));
}

/// The split a panel's group sits directly in.
fn split_around<'a>(panel: &str, node: &'a DockNode) -> Option<&'a DockSplit> {
    let DockNode::Split(split) = node else {
        return None;
    };
    for child in &split.children {
        if let DockNode::Group(group) = child {
            if group.panels.iter().any(|p| p == panel) {
                return Some(split);
            }
        }
        if let Some(inner) = split_around(panel, child) {
            return Some(inner);
        }
    }
    None
}

/// The shell the open thread's Terminal is (`TerminalTarget.for`).
fn target_of(app: &Threadbear) -> Target {
    let thread = app.open_thread();
    let runner = thread
        .and_then(|t| t.runner_id.as_deref())
        .map(|id| app.runner_name_of(id));
    rules::target_for(
        thread,
        &crate::files::home_dir(),
        runner.as_deref(),
        |path| {
            threadbear_core::open_policy::local_metadata(std::path::Path::new(path))
                .is_ok_and(|m| m.is_dir())
        },
    )
}

/// The runner said a thread changed (`thread.updated`): an archive it's agreed
/// to stops that thread's shell. Only the runner's word counts, not the app's
/// own guess at an archive it's still sending, which may yet be refused and put
/// back (`archivesInFlight`).
pub(crate) fn thread_updated(thread: &threadbear_core::inbox::ThreadSummary, cx: &mut App) {
    if thread.is_archived() && !thread.is_remote() {
        stop(&TerminalKey::Thread(thread.id.clone()), cx);
    }
}

/// A thread deleted (`forget`): its shell goes with it.
pub(crate) fn thread_deleted(id: &str, cx: &mut App) {
    stop(&TerminalKey::Thread(id.to_owned()), cx);
}

/// The runner's whole list came back (on connecting): a shell whose thread
/// isn't in it was deleted while the app wasn't listening, and one whose
/// thread is archived there goes too (`stopAll(except:)`, `stopArchived`).
pub(crate) fn list_loaded(
    threads: &HashMap<String, std::sync::Arc<threadbear_core::inbox::ThreadSummary>>,
    cx: &mut App,
) {
    let Some(terminals) = terminals(cx) else {
        return;
    };
    let keys: Vec<TerminalKey> = terminals.read(cx).sessions.keys().cloned().collect();
    let keeping: HashSet<&str> = threads.keys().map(String::as_str).collect();
    let mut going = rules::gone(&keys, &keeping);
    going.extend(rules::archived(&keys, threads));
    for key in going {
        stop(&key, cx);
    }
}

/// The grid the element last drew at, for the next shell's first size.
pub(crate) fn note_size(size: GridSize, cx: &mut App) {
    if let Some(terminals) = terminals(cx) {
        if terminals.read(cx).last_size != Some(size) {
            terminals.update(cx, |t, _| t.last_size = Some(size));
        }
    }
}

fn stop(key: &TerminalKey, cx: &mut App) {
    if let Some(terminals) = terminals(cx) {
        terminals.update(cx, |t, cx| t.stop(key, cx));
    }
}

/// Whether a shell block in `block_thread`'s transcript may put its command in
/// the Terminal (`canPutInTerminal(from:)`).
pub(crate) fn can_put(app: &Threadbear, block_thread: &str) -> bool {
    rules::can_put(Some(block_thread), app.selected.as_deref(), &target_of(app))
}

/// The same for drawing a play icon, from the target the panel last worked
/// out, so a frame doesn't look for the thread's folder on disk.
pub(crate) fn shows_put(block_thread: &str, cx: &App) -> bool {
    let Some(terminals) = terminals(cx) else {
        return false;
    };
    let t = terminals.read(cx);
    let Some(app) = t.app.upgrade() else {
        return false;
    };
    rules::can_put(
        Some(block_thread),
        app.read(cx).selected.as_deref(),
        &t.target,
    )
}

/// The app, for a shell block's icons, which are drawn where there's none to hand.
pub(crate) fn app(cx: &App) -> Option<Entity<Threadbear>> {
    terminals(cx)?.read(cx).app.upgrade()
}

/// What putting a command in a shell came to (`Terminals.PutOutcome`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PutOutcome {
    Typed,
    AlreadyThere,
    /// Copied instead: another program has the terminal, or someone's own
    /// text is on the prompt.
    Busy,
    /// Copied instead: another command put here is waiting for Return.
    Occupied,
}

/// A shell block's play icon (`putInTerminal`): the command at its thread's
/// prompt, checked again here against the thread it came from, with the panel
/// brought up for it. None when it can't go there (or one is on its way).
pub(crate) fn put_in_terminal(
    app: &mut Threadbear,
    block: ShellBlock,
    block_thread: &str,
    window: &mut Window,
    cx: &mut Context<Threadbear>,
) -> Option<Task<Option<PutOutcome>>> {
    if !can_put(app, block_thread) {
        return None;
    }
    let target = target_of(app);
    if !app.dock.read(cx).is_showing(crate::shell::TERMINAL) {
        bring_up(app, cx);
    }
    let terminals = terminals(cx)?;
    Some(terminals.update(cx, |t, cx| {
        t.set_target(target.clone(), cx);
        t.put(block, target, window, cx)
    }))
}

// ---------------------------------------------------------------- the panel

/// A thread's shells, as tabs along the top of the panel (`TerminalTab`s),
/// one of them showing. Never empty: a thread with none has no entry.
struct Tabs {
    shells: Vec<Tab>,
    current: usize,
}

struct Tab {
    session: Entity<Session>,
    _ended: Subscription,
}

impl Tabs {
    fn current(&self) -> &Entity<Session> {
        &self.shells[self.current.min(self.shells.len() - 1)].session
    }

    fn index_of(&self, id: EntityId) -> Option<usize> {
        self.shells.iter().position(|t| t.session.entity_id() == id)
    }
}

/// A tab being renamed: its field, in place of its title.
struct Renaming {
    session: EntityId,
    field: Entity<InputState>,
    _sub: Subscription,
}

/// Every shell the app has, by thread (`Terminals`), and the panel that shows
/// the open thread's.
pub(crate) struct Terminals {
    pub(crate) app: WeakEntity<Threadbear>,
    sessions: HashMap<TerminalKey, Tabs>,
    renaming: Option<Renaming>,
    /// The open thread's shell, as of the app's last change.
    pub(crate) target: Target,
    /// What the target was worked out from (the open thread, its folder, and
    /// whether it's archived or another machine's), so the folder is only
    /// looked for on disk when one of those changes, not at every event.
    seen: Option<(Option<String>, String, bool, Option<String>)>,
    /// Shells with a command on its way, so a second click while one is still
    /// starting doesn't queue another.
    putting: HashSet<TerminalKey>,
    /// The grid the last shell was drawn at, so a new one starts the size of
    /// the panel rather than 80 by 24 and redrawn.
    pub(crate) last_size: Option<GridSize>,
    _subs: Vec<Subscription>,
}

impl Terminals {
    fn new(app: &Entity<Threadbear>, cx: &mut Context<Self>) -> Self {
        // Not read here: the app is still being made.
        let watching = cx.observe(app, |this: &mut Terminals, app, cx| {
            let a = app.read(cx);
            let thread = a.open_thread();
            let seen = (
                a.selected.clone(),
                thread.map(|t| t.cwd.clone()).unwrap_or_default(),
                thread.is_some_and(|t| t.is_archived()),
                thread.and_then(|t| t.runner_id.clone()),
            );
            if this.seen.as_ref() != Some(&seen) {
                let target = target_of(a);
                this.seen = Some(seen);
                this.set_target(target, cx);
            }
        });
        // Every shell ends with the app, as closing Terminal's windows does.
        let quitting = cx.on_app_quit(|this: &mut Terminals, cx| {
            // Before the shells end: their text, for when the app opens again.
            this.save_all(cx);
            #[cfg(unix)]
            {
                // Those still being ended after their thread went too: the
                // thread that would finish them goes with the app.
                let mut shells: Vec<(i32, Born)> =
                    this.all().filter_map(|s| s.read(cx).process()).collect();
                shells.extend(
                    ENDING
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .iter()
                        .copied(),
                );
                end_shells_now(&shells);
            }
            #[cfg(not(unix))]
            {
                let all: Vec<Entity<Session>> = this.all().cloned().collect();
                let closing: Vec<_> = all
                    .iter()
                    .map(|s| {
                        s.update(cx, |s, _| {
                            s.shut_down();
                            s.shared.clone()
                        })
                    })
                    .collect();
                // GPUI gives returned quit futures only 200ms. Like the Unix
                // branch, finish closing here before returning that future.
                let deadline = Instant::now() + Duration::from_secs(5);
                while closing
                    .iter()
                    .any(|s| !s.reader_closed.load(Ordering::Acquire))
                    && Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            async {}
        });
        prune_saved();
        let home = crate::files::home_dir();
        Terminals {
            app: app.downgrade(),
            sessions: HashMap::new(),
            renaming: None,
            target: Target {
                key: TerminalKey::Home,
                cwd: home,
                note: None,
            },
            seen: None,
            putting: HashSet::new(),
            last_size: None,
            _subs: vec![watching, quitting],
        }
    }

    fn set_target(&mut self, target: Target, cx: &mut Context<Self>) {
        if self.target != target {
            self.target = target;
            cx.notify();
        }
    }

    /// Every shell, in every thread's tabs.
    fn all(&self) -> impl Iterator<Item = &Entity<Session>> {
        self.sessions
            .values()
            .flat_map(|tabs| tabs.shells.iter().map(|t| &t.session))
    }

    /// The tab showing for a thread, if it has any.
    fn current(&self, key: &TerminalKey) -> Option<&Entity<Session>> {
        self.sessions.get(key).map(Tabs::current)
    }

    /// The target's showing shell, starting one if it has none (`Terminals.open`).
    fn open(&mut self, target: &Target, cx: &mut Context<Self>) -> Entity<Session> {
        if let Some(session) = self.current(&target.key) {
            return session.clone();
        }
        if let Some(session) =
            take_saved(&target.key).and_then(|(saved, when)| self.restore(target, saved, &when, cx))
        {
            return session;
        }
        self.add(target, cx)
    }

    /// A thread's shells as they were when Threadbear last quit: each tab
    /// back with its name and its text above a new shell's prompt, as
    /// Terminal.app brings back its windows.
    fn restore(
        &mut self,
        target: &Target,
        saved: rules::SavedTabs,
        when: &str,
        cx: &mut Context<Self>,
    ) -> Option<Entity<Session>> {
        let shells: Vec<Tab> = saved
            .tabs
            .into_iter()
            .take(8)
            .enumerate()
            .map(|(ix, tab)| {
                self.make(
                    target,
                    ix + 1,
                    tab.name,
                    rules::restored_bytes(&tab.text, when),
                    cx,
                )
            })
            .collect();
        if shells.is_empty() {
            return None;
        }
        let current = saved.current.min(shells.len() - 1);
        let session = shells[current].session.clone();
        self.sessions
            .insert(target.key.clone(), Tabs { shells, current });
        cx.notify();
        Some(session)
    }

    /// Every thread's shells' text and names, for `restore` (on quit).
    fn save_all(&self, cx: &App) {
        let dir = saved_dir();
        for (key, tabs) in &self.sessions {
            let saved = rules::SavedTabs {
                tabs: tabs
                    .shells
                    .iter()
                    .filter_map(|t| t.session.read(cx).saved())
                    .collect(),
                current: tabs.current,
            };
            if saved
                .tabs
                .iter()
                .all(|t| t.text.is_empty() && t.name.is_none())
            {
                continue;
            }
            if let Ok(json) = serde_json::to_vec(&saved) {
                write_private(&dir, &rules::saved_file_name(key), &json);
            }
        }
    }

    /// A new shell in a tab of its own, after the others, and shown (+).
    fn add(&mut self, target: &Target, cx: &mut Context<Self>) -> Entity<Session> {
        let taken: Vec<usize> = self
            .sessions
            .get(&target.key)
            .map(|t| t.shells.iter().map(|s| s.session.read(cx).number).collect())
            .unwrap_or_default();
        let tab = self.make(target, rules::next_tab_number(&taken), None, Vec::new(), cx);
        let session = tab.session.clone();
        let tabs = self
            .sessions
            .entry(target.key.clone())
            .or_insert_with(|| Tabs {
                shells: Vec::new(),
                current: 0,
            });
        tabs.shells.push(tab);
        tabs.current = tabs.shells.len() - 1;
        cx.notify();
        session
    }

    fn make(
        &mut self,
        target: &Target,
        number: usize,
        name: Option<String>,
        restored: Vec<u8>,
        cx: &mut Context<Self>,
    ) -> Tab {
        let size = self.last_size.unwrap_or_default();
        // Its own view: what it prints redraws it, not the panel round it.
        let session = cx.new(|cx| Session::start(target.clone(), number, name, size, restored, cx));
        let ended = cx.subscribe(
            &session,
            |this: &mut Terminals, session, _: &ShellEnded, cx| this.ended(session.entity_id(), cx),
        );
        Tab {
            session,
            _ended: ended,
        }
    }

    /// Shows a thread's tab and gives it the keyboard.
    fn select(
        &mut self,
        key: &TerminalKey,
        id: EntityId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tabs) = self.sessions.get_mut(key) else {
            return;
        };
        let Some(ix) = tabs.index_of(id) else { return };
        tabs.current = ix;
        let session = tabs.current().clone();
        session.update(cx, |s, _| s.rang = false);
        self.focus(&session, window, cx);
        cx.notify();
    }

    /// ✕ or Close Terminal: the tab goes and its shell ends. With a program
    /// still running in it (a dev server, vim), it asks first, as Terminal.app
    /// does, so a stray click doesn't end it.
    fn close(
        &mut self,
        key: &TerminalKey,
        id: EntityId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let busy = self.find(id).and_then(|s| {
            let s = s.read(cx);
            s.busy_with().map(|program| (s.tab_title(), program))
        });
        if let Some((title, program)) = busy.filter(|_| !cfg!(feature = "automation")) {
            let key = key.clone();
            // From a task: the question's loop can't run inside an update.
            cx.spawn_in(window, async move |this, cx| {
                let detail = format!("{program} is still running in it. Closing the tab ends it.");
                if crate::alert::confirm(&format!("Close {title}?"), &detail, "Close", "Cancel") {
                    let _ = this.update_in(cx, |t, window, cx| t.close_now(&key, id, window, cx));
                }
            })
            .detach();
            return;
        }
        self.close_now(key, id, window, cx);
    }

    fn close_now(
        &mut self,
        key: &TerminalKey,
        id: EntityId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(session) = self.remove_tab(key, id, cx) {
            session.update(cx, |s, _| s.shut_down());
        }
        if let Some(session) = self.current(key).cloned() {
            self.focus(&session, window, cx);
        }
    }

    /// Takes a tab out, showing the one that took its place (the next, or
    /// the one before when it was last), as Terminal.app's tabs do.
    fn remove_tab(
        &mut self,
        key: &TerminalKey,
        id: EntityId,
        cx: &mut Context<Self>,
    ) -> Option<Entity<Session>> {
        let tabs = self.sessions.get_mut(key)?;
        let ix = tabs.index_of(id)?;
        let tab = tabs.shells.remove(ix);
        if tabs.current > ix {
            tabs.current -= 1;
        }
        tabs.current = tabs.current.min(tabs.shells.len().saturating_sub(1));
        if tabs.shells.is_empty() {
            self.sessions.remove(key);
            self.putting.remove(key);
        }
        if self.renaming.as_ref().is_some_and(|r| r.session == id) {
            self.renaming = None;
        }
        cx.notify();
        Some(tab.session)
    }

    /// A shell ended by itself (`exit`): one of several closes its tab, and
    /// the last stays, saying so, with New Shell.
    fn ended(&mut self, id: EntityId, cx: &mut Context<Self>) {
        let Some(key) = self
            .sessions
            .iter()
            .find(|(_, tabs)| tabs.index_of(id).is_some())
            .map(|(k, _)| k.clone())
        else {
            return;
        };
        if self
            .sessions
            .get(&key)
            .is_some_and(|tabs| tabs.shells.len() > 1)
        {
            self.remove_tab(&key, id, cx);
        }
    }

    /// A fresh shell in the showing tab's place, keeping its number and name.
    fn replace_current(
        &mut self,
        key: &TerminalKey,
        cx: &mut Context<Self>,
    ) -> Option<Entity<Session>> {
        let old = self.current(key)?.clone();
        let (target, number, name) = {
            let s = old.read(cx);
            (s.target.clone(), s.number, s.name.clone())
        };
        old.update(cx, |s, _| s.shut_down());
        let tab = self.make(&target, number, name, Vec::new(), cx);
        let session = tab.session.clone();
        let tabs = self.sessions.get_mut(key)?;
        let ix = tabs.current.min(tabs.shells.len() - 1);
        tabs.shells[ix] = tab;
        cx.notify();
        Some(session)
    }

    /// Double-click or Rename…: the tab's title becomes a field.
    fn start_rename(
        &mut self,
        key: &TerminalKey,
        id: EntityId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.select(key, id, window, cx);
        let Some(session) = self.find(id) else { return };
        let title = session.read(cx).tab_title();
        let field = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Name")
                .default_value(title)
        });
        field.update(cx, |s, cx| s.select_all(window, cx));
        let sub = cx.subscribe(
            &field,
            |this: &mut Terminals, _, ev: &FieldEvent, cx| match ev {
                FieldEvent::PressEnter { .. } | FieldEvent::Blur => this.finish_rename(true, cx),
                _ => {}
            },
        );
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        crate::web_panels::keyboard_to_app(window);
        self.renaming = Some(Renaming {
            session: id,
            field,
            _sub: sub,
        });
        cx.notify();
    }

    /// Return or clicking away keeps the name, Escape leaves it; an empty
    /// one goes back to the shell's own.
    fn finish_rename(&mut self, keep: bool, cx: &mut Context<Self>) {
        let Some(renaming) = self.renaming.take() else {
            return;
        };
        if keep {
            let name = rules::tab_name(&renaming.field.read(cx).value());
            self.set_name(renaming.session, name, cx);
        }
        cx.notify();
    }

    fn set_name(&mut self, id: EntityId, name: Option<String>, cx: &mut Context<Self>) {
        if let Some(session) = self.find(id) {
            session.update(cx, |s, cx| {
                s.name = name;
                cx.notify();
            });
            cx.notify();
        }
    }

    fn find(&self, id: EntityId) -> Option<Entity<Session>> {
        self.all().find(|s| s.entity_id() == id).cloned()
    }

    fn focus(&self, session: &Entity<Session>, window: &mut Window, cx: &mut App) {
        let handle = session.read(cx).focus.clone();
        window.focus(&handle, cx);
        crate::web_panels::keyboard_to_app(window);
    }

    /// Ends a thread's shell (it was archived or deleted). Never the shared
    /// home shell, whatever a thread is called: its key is its own.
    fn stop(&mut self, key: &TerminalKey, cx: &mut Context<Self>) {
        // Its saved text goes with it: nothing comes back for a thread that's gone.
        let _ = std::fs::remove_file(saved_dir().join(rules::saved_file_name(key)));
        if let Some(tabs) = self.sessions.remove(key) {
            for tab in tabs.shells {
                tab.session.update(cx, |s, _| s.shut_down());
            }
            self.putting.remove(key);
            cx.notify();
        }
    }

    /// ⌃Tab and ⌃⇧Tab: the next tab, or the one before, going round.
    fn cycle(
        &mut self,
        key: &TerminalKey,
        back: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tabs) = self.sessions.get(key) else {
            return;
        };
        if tabs.shells.len() < 2 {
            return;
        }
        let ix = rules::cycled_tab(
            tabs.current.min(tabs.shells.len() - 1),
            tabs.shells.len(),
            back,
        );
        let id = tabs.shells[ix].session.entity_id();
        self.select(key, id, window, cx);
    }

    /// ⌘T: another shell in the same folder, as + does.
    fn new_shell(&mut self, target: &Target, window: &mut Window, cx: &mut Context<Self>) {
        let session = self.add(target, cx);
        self.focus(&session, window, cx);
    }

    /// A new shell in place of one that has exited (New Shell).
    fn restart(&mut self, key: &TerminalKey, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(session) = self.replace_current(key, cx) {
            self.focus(&session, window, cx);
        }
    }

    /// Types `block` at the target's prompt, starting a shell if it needs one,
    /// and gives it the keyboard (`Terminals.put`). Never presses Return: the
    /// command came out of a reply, so a person gets to read it first.
    fn put(
        &mut self,
        block: ShellBlock,
        target: Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Option<PutOutcome>> {
        if !self.putting.insert(target.key.clone()) {
            return Task::ready(None);
        }
        // Into the showing tab, a fresh shell if that one has exited.
        let session = match self.current(&target.key) {
            Some(s) if s.read(cx).exited => self.replace_current(&target.key, cx),
            _ => None,
        };
        let session = session.unwrap_or_else(|| self.open(&target, cx));
        self.focus(&session, window, cx);
        let key = target.key.clone();
        cx.spawn(async move |this, cx| {
            let outcome = loop {
                // Worked out and typed in one go, so nothing comes between.
                let step = session.update(cx, |s, cx| {
                    let step = s.put_step(&block);
                    if step == Step::Type {
                        s.put(&block.command, cx);
                    }
                    step
                });
                match step {
                    Step::Wait => {
                        cx.background_executor()
                            .timer(Duration::from_millis(50))
                            .await
                    }
                    Step::Type => break Some(PutOutcome::Typed),
                    Step::AlreadyThere => break Some(PutOutcome::AlreadyThere),
                    Step::Occupied => break Some(PutOutcome::Occupied),
                    Step::Busy => break Some(PutOutcome::Busy),
                }
            };
            this.update(cx, |t, _| t.putting.remove(&key)).ok();
            outcome
        })
    }
}

impl Render for Terminals {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let target = self.target.clone();
        let session = self.current(&target.key).cloned();
        let folder =
            threadbear_core::new_thread::abbreviate_home(&target.cwd, &crate::files::home_dir());
        let mut panel = v_flex().id("terminal-panel").size_full();
        if let Some(note) = target.note.clone() {
            // Over the terminal, when its folder isn't the thread's.
            panel = panel.child(crate::highlights::tipped_as(
                div()
                    .id("terminal-note")
                    .flex_none()
                    .w_full()
                    .px(px(10.))
                    .py(px(5.))
                    .text_size(px(style::size::DETAIL))
                    .line_height(px(style::natural_line(style::size::DETAIL)))
                    .text_color(style::secondary_text(cx))
                    .line_clamp(2)
                    .child(note.clone()),
                note,
                gpui_kit::Role::GenericContainer,
            ));
        }
        if session.is_some() {
            panel = panel.child(self.render_tabs(&target, &folder, cx));
        }
        let body = match session {
            Some(session) => div()
                .flex_1()
                .min_h_0()
                .w_full()
                .child(session)
                .into_any_element(),
            // No shell for this thread yet: one starts on a click here or ⌘J,
            // not just from looking.
            None => {
                let key = target.key.clone();
                // Its tip is what a spec presses it by, as in the Swift app.
                let tip = format!("Start your login shell in {folder}");
                let start = div()
                    .id("terminal-start")
                    .role(Role::Button)
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let target = this.target.clone();
                        if target.key != key {
                            return;
                        }
                        let session = this.open(&target, cx);
                        this.focus(&session, window, cx);
                    }))
                    .child(
                        h_flex()
                            .gap(px(5.))
                            .text_size(px(style::size::LABEL))
                            .line_height(px(style::natural_line(style::size::LABEL)))
                            .text_color(style::secondary_text(cx))
                            .child(
                                crate::icons::symbol("terminal")
                                    .with_size(px(14.))
                                    .text_color(style::secondary_text(cx)),
                            )
                            .child("Start a shell"),
                    );
                crate::highlights::tipped(start, tip).into_any_element()
            }
        };
        panel.child(body)
    }
}

impl Terminals {
    /// The tabs above the terminal (`TerminalTabStrip`): one per shell, ✕ to
    /// close one, + for another, then a line under them.
    fn render_tabs(&self, target: &Target, folder: &str, cx: &mut Context<Self>) -> AnyElement {
        let Some(tabs) = self.sessions.get(&target.key) else {
            return div().into_any_element();
        };
        let closable = tabs.shells.len() > 1;
        let current = tabs.current.min(tabs.shells.len() - 1);
        let buttons: Vec<AnyElement> = tabs
            .shells
            .iter()
            .enumerate()
            .map(|(ix, tab)| {
                self.render_tab(&target.key, ix, &tab.session, ix == current, closable, cx)
            })
            .collect();
        let add_target = target.clone();
        let hover = style::hover_fill(cx);
        let add = crate::highlights::tipped(
            div()
                .id("terminal-add-tab")
                .flex_none()
                .size(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.))
                .cursor_pointer()
                .hover(move |s| s.bg(hover)),
            format!("Open another terminal in {folder}"),
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
            if this.target.key != add_target.key {
                return;
            }
            let session = this.add(&add_target, cx);
            this.focus(&session, window, cx);
        }))
        .child(
            crate::icons::symbol("plus")
                .with_size(px(12.))
                .text_color(style::secondary_text(cx)),
        );
        v_flex()
            .flex_none()
            .w_full()
            .child(
                h_flex()
                    .h(px(30.))
                    .px(px(6.))
                    .gap(px(2.))
                    .items_center()
                    .child(
                        h_flex()
                            .id("terminal-tabs")
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .items_center()
                            .overflow_x_scroll()
                            .children(buttons),
                    )
                    .child(add),
            )
            .child(div().h(px(1.)).w_full().bg(style::hairline(cx)))
            .into_any_element()
    }

    /// One tab (`TerminalTabButton`): click shows it, double-click or its
    /// right-click menu's Rename… names it, ✕ closes it.
    fn render_tab(
        &self,
        key: &TerminalKey,
        ix: usize,
        session: &Entity<Session>,
        selected: bool,
        closable: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = session.entity_id();
        let s = session.read(cx);
        let title = s.tab_title();
        let named = s.name.is_some();
        // The bell rang in a tab you weren't looking at, as Terminal.app badges it.
        let rang = s.rang && !selected;
        let tip = if s.exited {
            "This shell has ended".to_owned()
        } else {
            format!("Switch to {title}. Double-click to rename it")
        };
        let secondary = style::secondary_text(cx);
        let group: SharedString = format!("terminal-tab-{ix}").into();
        let label = match self.renaming.as_ref().filter(|r| r.session == id) {
            Some(renaming) => div()
                .id("terminal-tab-name")
                .w(px(120.))
                .font_weight(FontWeight::MEDIUM)
                .text_size(px(style::size::SMALL + 0.5))
                .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                    if ev.keystroke.key == "escape" {
                        this.finish_rename(false, cx);
                        cx.stop_propagation();
                    }
                }))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .tip("Press Return to keep the name, Escape to leave it. Empty goes back to the shell's own")
                .child(Input::new(&renaming.field).appearance(false).small().pl(px(0.)))
                .into_any_element(),
            None => div()
                .max_w(px(140.))
                .truncate()
                .text_size(px(style::size::SMALL + 0.5))
                .when(selected, |d| d.font_weight(FontWeight::MEDIUM))
                .text_color(if selected { cx.theme().foreground } else { secondary })
                .child(title.clone())
                .into_any_element(),
        };
        let close = closable.then(|| {
            let (key, hover) = (key.clone(), style::hover_fill(cx));
            crate::highlights::tipped(
                div()
                    .id(("terminal-tab-close", ix))
                    .flex_none()
                    .size(px(14.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(3.))
                    .hover(move |s| s.bg(hover))
                    .when(!selected, |d| {
                        d.invisible().group_hover(group.clone(), |s| s.visible())
                    }),
                format!("Close {title} and end its shell"),
            )
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                cx.stop_propagation();
                this.close(&key, id, window, cx);
            }))
            .child(
                crate::icons::symbol("xmark")
                    .with_size(px(8.5))
                    .text_color(secondary),
            )
        });
        let fill = if selected {
            style::primary_opacity(cx, 0.1)
        } else {
            gpui_kit::transparent_black()
        };
        let hover = style::primary_opacity(cx, if selected { 0.1 } else { 0.05 });
        let click_key = key.clone();
        // A tab to VoiceOver, its tip its label (the automation finds it by that).
        let tab = crate::highlights::tipped_as(
            div()
                .id(("terminal-tab", ix))
                .group(group)
                .flex_none()
                .h(px(22.))
                .pl(px(8.))
                .pr(px(if closable { 4. } else { 8. }))
                .flex()
                .items_center()
                .gap(px(4.))
                .rounded(px(5.))
                .bg(fill)
                .hover(move |s| s.bg(hover))
                .cursor_pointer(),
            tip,
            gpui_kit::Role::Tab,
        )
        .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
            if ev.click_count() >= 2 {
                this.start_rename(&click_key, id, window, cx);
            } else {
                this.select(&click_key, id, window, cx);
            }
        }))
        .children(rang.then(|| {
            div()
                .flex_none()
                .size(px(6.))
                .rounded_full()
                .bg(cx.theme().primary)
        }))
        .child(label)
        .children(close);
        let (weak, menu_key) = (cx.entity().downgrade(), key.clone());
        div()
            .id(("terminal-tab-menu", ix))
            .flex_none()
            .child(tab)
            .context_menu(move |menu, _, _| {
                tab_menu(menu, weak.clone(), menu_key.clone(), id, named, closable)
            })
            .into_any_element()
    }
}

/// A tab's right-click menu, with icons as every right-click menu has.
fn tab_menu(
    menu: gpui_kit::component::menu::PopupMenu,
    terminals: WeakEntity<Terminals>,
    key: TerminalKey,
    id: EntityId,
    named: bool,
    closable: bool,
) -> gpui_kit::component::menu::PopupMenu {
    let act =
        |f: fn(&mut Terminals, &TerminalKey, EntityId, &mut Window, &mut Context<Terminals>)| {
            let (terminals, key) = (terminals.clone(), key.clone());
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                if let Some(t) = terminals.upgrade() {
                    t.update(cx, |t, cx| f(t, &key, id, window, cx));
                }
            }
        };
    let mut menu = menu.item(
        PopupMenuItem::new("Rename…")
            .icon(crate::icons::symbol("pencil"))
            .on_click(act(|t, key, id, window, cx| {
                // After the menu has gone, so its closing doesn't take the field's keyboard.
                let key = key.clone();
                cx.spawn_in(window, async move |this, cx| {
                    let _ =
                        this.update_in(cx, |t, window, cx| t.start_rename(&key, id, window, cx));
                })
                .detach();
                let _ = t;
            })),
    );
    if named {
        menu = menu.item(
            PopupMenuItem::new("Use the Shell's Name")
                .icon(crate::icons::symbol("arrow.uturn.backward"))
                .on_click(act(|t, _, id, _, cx| t.set_name(id, None, cx))),
        );
    }
    if closable {
        menu = menu.separator().item(
            PopupMenuItem::new("Close Terminal")
                .icon(crate::icons::symbol("xmark"))
                .on_click(act(|t, key, id, window, cx| t.close(key, id, window, cx))),
        );
    }
    menu
}

// ---------------------------------------------------------------- one shell

/// The grid a shell is drawn at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GridSize {
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) cell_width: f32,
    pub(crate) cell_height: f32,
}

impl Default for GridSize {
    fn default() -> Self {
        GridSize {
            cols: 80,
            rows: 24,
            cell_width: 8.,
            cell_height: 17.,
        }
    }
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.rows as usize
    }
    fn screen_lines(&self) -> usize {
        self.rows as usize
    }
    fn columns(&self) -> usize {
        self.cols as usize
    }
}

impl GridSize {
    fn window_size(self) -> WindowSize {
        WindowSize {
            num_lines: self.rows,
            num_cols: self.cols,
            cell_width: self.cell_width.round() as u16,
            cell_height: self.cell_height.round() as u16,
        }
    }
}

/// Where the grid was last drawn, for turning the pointer into a cell.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DrawnAt {
    pub(crate) origin: Point<Pixels>,
    pub(crate) cell_width: Pixels,
    pub(crate) cell_height: Pixels,
}

/// What the reader thread tells the app.
enum Note {
    Wakeup,
    Exited,
    Title(String),
    /// A program put this on the clipboard (OSC 52; reading it back is off).
    Copy(String),
    /// A program rang the bell (^G).
    Bell,
    /// A program asked what colour one of its numbered colours is.
    Colour(
        usize,
        Arc<dyn Fn(alacritty_terminal::vte::ansi::Rgb) -> String + Sync + Send + 'static>,
    ),
}

/// Shared between the shell's reader thread and the app.
struct Shared {
    /// A redraw is on its way: the reader sends one wakeup per frame at most.
    dirty: AtomicBool,
    exited: AtomicBool,
    #[cfg(not(unix))]
    reader_closed: AtomicBool,
    sender: OnceLock<EventLoopSender>,
    size: Mutex<WindowSize>,
    notes: tokio::sync::mpsc::UnboundedSender<Note>,
}

/// What alacritty_terminal tells us as it reads the shell. Called on the
/// reader thread, so the app hears through a channel; replies the terminal
/// owes the program (where the cursor is, how big it is) go straight back.
#[derive(Clone)]
pub(crate) struct Listener(Arc<Shared>);

impl EventListener for Listener {
    fn send_event(&self, event: TermEvent) {
        let shared = &self.0;
        match event {
            TermEvent::Wakeup | TermEvent::MouseCursorDirty | TermEvent::CursorBlinkingChange => {
                if !shared.dirty.swap(true, Ordering::AcqRel) {
                    let _ = shared.notes.send(Note::Wakeup);
                }
            }
            TermEvent::PtyWrite(text) => {
                if let Some(sender) = shared.sender.get() {
                    let _ = sender.send(Msg::Input(Cow::Owned(text.into_bytes())));
                }
            }
            TermEvent::TextAreaSizeRequest(format) => {
                let size = *shared.size.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(sender) = shared.sender.get() {
                    let _ = sender.send(Msg::Input(Cow::Owned(format(size).into_bytes())));
                }
            }
            TermEvent::ChildExit(_) | TermEvent::Exit => {
                if !shared.exited.swap(true, Ordering::AcqRel) {
                    let _ = shared.notes.send(Note::Exited);
                }
            }
            TermEvent::Title(title) => {
                let _ = shared.notes.send(Note::Title(title));
            }
            TermEvent::ResetTitle => {
                let _ = shared.notes.send(Note::Title(String::new()));
            }
            TermEvent::ClipboardStore(_, text) => {
                let _ = shared.notes.send(Note::Copy(text));
            }
            TermEvent::ColorRequest(index, format) => {
                let _ = shared.notes.send(Note::Colour(index, format));
            }
            TermEvent::Bell => {
                let _ = shared.notes.send(Note::Bell);
            }
            TermEvent::ClipboardLoad(..) => {}
        }
    }
}

/// A shell ended by itself (`exit`), for its tab to close.
pub(crate) struct ShellEnded;

/// The link under the pointer, underlined: the screen rows it's on, with the
/// columns it covers in each, and where it goes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Hover {
    pub(crate) cells: Vec<(usize, std::ops::Range<usize>)>,
    pub(crate) url: String,
}

/// One shell in one pty (`TerminalSession`), and its tab.
pub(crate) struct Session {
    pub(crate) target: Target,
    /// Its tab's number, the lowest free when it started ("Terminal 2").
    pub(crate) number: usize,
    /// A name given it (double-click or Rename…), over the shell's own.
    pub(crate) name: Option<String>,
    /// The web address under the pointer, and the cell the pointer was last
    /// over, to look again when the screen changes under it.
    pub(crate) hover: Option<Hover>,
    pointer: Option<(usize, usize)>,
    pub(crate) term: Arc<FairMutex<Term<Listener>>>,
    shared: Arc<Shared>,
    /// The shell's process, which leads its own session, and when it
    /// started, which tells it from a later process given the same pid.
    pid: Option<i32>,
    born: Option<Born>,
    /// The shell's program, symlinks followed, which has to be what owns
    /// the terminal before anything's typed there.
    shell: Option<PathBuf>,
    /// Our own copy of the pty's controller, to ask who has the terminal.
    #[cfg(unix)]
    pty: Option<std::os::fd::OwnedFd>,
    started: Instant,
    pub(crate) exited: bool,
    /// Why it couldn't start, if it couldn't.
    pub(crate) failed: Option<String>,
    pub(crate) title: String,
    /// What's on its prompt, as far as keys and play icons say.
    pub(crate) line: Line,
    pub(crate) focus: FocusHandle,
    pub(crate) size: GridSize,
    pub(crate) drawn_at: Option<DrawnAt>,
    /// It had the keyboard when it was last drawn.
    pub(crate) focused: bool,
    /// An input method's text still being composed (a Japanese word, an
    /// accent waiting for its letter), drawn at the cursor until it's typed.
    pub(crate) marked: String,
    /// Part of a line scrolled by a trackpad that hasn't added up to a line.
    scroll_rest: f32,
    /// A drag selecting text, or one going to the program (mouse reporting).
    dragging: Option<Drag>,
    /// The cursor's blink, while it has the keyboard: shown and gone 0.7 s
    /// each, as SwiftTerm's caret fades out and back, and shown while you
    /// type (`kept` skips a beat after a key).
    pub(crate) blink_shown: bool,
    blink_kept: bool,
    _blink: Task<()>,
    _events: Task<()>,
    /// Lines Return was pressed on at the prompt, for ⌘↑ and ⌘↓.
    marks: rules::Marks,
    /// The Find bar (⌘F), while it's open.
    finding: Option<Finding>,
    /// The bell's flash, until this.
    bell_until: Option<Instant>,
    /// The bell rang while this shell wasn't the one with the keyboard: its
    /// tab has a dot until it's looked at.
    pub(crate) rang: bool,
    /// An ⌥-click, for moving the cursor there if it doesn't become a drag.
    option_click: Option<(usize, usize)>,
    /// The cell a right-click menu was opened over, for its Open Link.
    menu_cell: Option<(usize, usize)>,
}

/// The Find bar: its field, the match showing, and how many there are.
struct Finding {
    field: Entity<InputState>,
    at: Option<Match>,
    count: String,
    _sub: Subscription,
}

#[derive(Clone, Copy, PartialEq)]
enum Drag {
    Selecting,
    Reporting,
}

impl Session {
    fn start(
        target: Target,
        number: usize,
        name: Option<String>,
        size: GridSize,
        restored: Vec<u8>,
        cx: &mut Context<Self>,
    ) -> Self {
        let (notes, mut incoming) = tokio::sync::mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            dirty: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            #[cfg(not(unix))]
            reader_closed: AtomicBool::new(false),
            sender: OnceLock::new(),
            size: Mutex::new(size.window_size()),
            notes,
        });
        // SwiftTerm keeps 500 lines back, which loses a build's errors, so
        // this keeps alacritty's 10,000. The cursor blinks, as SwiftTerm's
        // does, unless a program asks for a steady one.
        let config = Config {
            default_cursor_style: CursorStyle {
                shape: CursorShape::Block,
                blinking: true,
            },
            ..Config::default()
        };
        let term = Arc::new(FairMutex::new(Term::new(
            config,
            &size,
            Listener(shared.clone()),
        )));
        if !restored.is_empty() {
            // The text it had when the app quit, above the new shell's prompt.
            let mut parser = alacritty_terminal::vte::ansi::Processor::<
                alacritty_terminal::vte::ansi::StdSyncHandler,
            >::new();
            parser.advance(&mut *term.lock(), &restored);
        }
        let events = cx.spawn(async move |this, cx| {
            while let Some(note) = incoming.recv().await {
                if this.update(cx, |s, cx| s.heard(note, cx)).is_err() {
                    break;
                }
            }
        });
        // A beat every 0.7 s that only redraws while the terminal has the
        // keyboard: an idle terminal behind others costs nothing.
        let blink = cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(Duration::from_millis(700))
                .await;
            let alive = this.update(cx, |s, cx| {
                if std::mem::take(&mut s.blink_kept) || !s.focused {
                    if !s.blink_shown {
                        s.blink_shown = true;
                        cx.notify();
                    }
                    return;
                }
                s.blink_shown = !s.blink_shown;
                cx.notify();
            });
            if alive.is_err() {
                break;
            }
        });
        let mut session = Session {
            target,
            number,
            name,
            hover: None,
            pointer: None,
            term,
            shared,
            pid: None,
            born: None,
            shell: None,
            #[cfg(unix)]
            pty: None,
            started: Instant::now(),
            exited: false,
            failed: None,
            title: String::new(),
            line: Line::Empty,
            focus: cx.focus_handle(),
            size,
            drawn_at: None,
            focused: false,
            marked: String::new(),
            scroll_rest: 0.,
            dragging: None,
            blink_shown: true,
            blink_kept: false,
            _blink: blink,
            _events: events,
            marks: rules::Marks::default(),
            finding: None,
            bell_until: None,
            rang: false,
            option_click: None,
            menu_cell: None,
        };
        if let Err(e) = session.spawn_shell() {
            session.exited = true;
            session.failed = Some(e.to_string());
            #[cfg(not(unix))]
            session.shared.reader_closed.store(true, Ordering::Release);
        }
        session
    }

    /// Starts the login shell in the target's folder, and the thread that
    /// reads it (`TerminalSession.start`).
    fn spawn_shell(&mut self) -> std::io::Result<()> {
        let shell = std::env::var("SHELL").ok();
        let lang = std::env::var("LANG").ok();
        let launch = rules::launch(rules::Os::current(), shell.as_deref(), lang.as_deref());
        #[allow(
            clippy::needless_update,
            reason = "Windows' tty::Options has a field more than the others"
        )]
        let options = tty::Options {
            shell: Some(tty::Shell::new(launch.program, launch.args)),
            working_directory: Some(std::path::PathBuf::from(&self.target.cwd)),
            drain_on_exit: true,
            env: launch.env.into_iter().collect(),
            ..Default::default()
        };
        // Starts a program: the shell, as above, in a folder the thread names.
        // Nothing a link, a file or a page says (open_gate_source.rs allows it).
        let pty = tty::new(&options, self.size.window_size(), 0)?;
        self.shell = std::fs::canonicalize(&launch.shell).ok();
        #[cfg(unix)]
        {
            use std::os::fd::AsFd as _;
            let pid = pty.child().id() as i32;
            self.pid = Some(pid);
            self.born = born(pid);
            self.pty = pty.file().as_fd().try_clone_to_owned().ok();
        }
        let event_loop = EventLoop::new(
            self.term.clone(),
            Listener(self.shared.clone()),
            pty,
            true,
            false,
        )?;
        let _ = self.shared.sender.set(event_loop.channel());
        // Its thread runs until the shell ends or is told to stop; nothing
        // waits for it.
        let reader = event_loop.spawn();
        #[cfg(unix)]
        drop(reader);
        #[cfg(not(unix))]
        {
            let shared = self.shared.clone();
            std::thread::spawn(move || {
                drop(reader.join()); // drops ConPTY, including its shell
                shared.reader_closed.store(true, Ordering::Release);
            });
        }
        Ok(())
    }

    fn heard(&mut self, note: Note, cx: &mut Context<Self>) {
        match note {
            Note::Wakeup => {
                self.shared.dirty.store(false, Ordering::Release);
                // What's under the pointer may have changed.
                if let Some((col, row)) = self.pointer {
                    self.hover = self.hover_at(col, row);
                }
            }
            Note::Exited => {
                let first = !self.exited;
                self.exited = true;
                self.hover = None;
                if first {
                    cx.emit(ShellEnded);
                }
                #[cfg(unix)]
                {
                    self.pty = None;
                }
            }
            Note::Title(title) => self.title = title,
            Note::Copy(text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            Note::Bell => self.ring(cx),
            Note::Colour(index, format) => {
                let colours = crate::terminal_element::Colours::current(cx);
                let (r, g, b) = colours.indexed(index);
                self.write(format(alacritty_terminal::vte::ansi::Rgb { r, g, b }).into_bytes());
            }
        }
        cx.notify();
    }

    /// Its tab's title: a name given it, the shell's own, or its number.
    pub(crate) fn tab_title(&self) -> String {
        rules::tab_title(self.name.as_deref(), &self.title, self.number)
    }

    fn sender(&self) -> Option<&EventLoopSender> {
        if self.exited {
            return None;
        }
        self.shared.sender.get()
    }

    pub(crate) fn write(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        if let Some(sender) = self.sender() {
            let _ = sender.send(Msg::Input(Cow::Owned(bytes)));
        }
    }

    /// The grid the element worked out for the panel's size.
    pub(crate) fn resize(&mut self, size: GridSize) {
        if self.size == size {
            return;
        }
        self.size = size;
        self.term.lock().resize(size);
        *self.shared.size.lock().unwrap_or_else(|e| e.into_inner()) = size.window_size();
        // Not once the shell has gone: the library ends the whole app if the
        // pty's size can't be set.
        if let Some(sender) = self.sender() {
            let _ = sender.send(Msg::Resize(size.window_size()));
        }
    }

    /// Ends the shell (`end_shell`), then the reader thread, which closes
    /// the pty once the shell has gone.
    fn shut_down(&mut self) {
        #[cfg(unix)]
        if let (Some(pid), Some(when), true) = (self.pid, self.born, self.running()) {
            end_shell(pid, when);
        }
        if let Some(sender) = self.shared.sender.get() {
            let _ = sender.send(Msg::Shutdown);
        }
        self.exited = true;
        #[cfg(unix)]
        {
            self.pty = None;
        }
    }

    /// The shell's process, while it's running.
    #[cfg(unix)]
    fn process(&self) -> Option<(i32, Born)> {
        let (pid, born) = (self.pid?, self.born?);
        self.running().then_some((pid, born))
    }

    fn running(&self) -> bool {
        !self.exited && !self.shared.exited.load(Ordering::Acquire)
    }

    /// The shell owns the terminal, rather than a program it's running.
    pub(crate) fn shell_in_front(&self) -> bool {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd as _;
            let (Some(pid), Some(pty), Some(shell)) =
                (self.pid, self.pty.as_ref(), self.shell.as_ref())
            else {
                return false;
            };
            if !self.running() {
                return false;
            }
            // SAFETY: takes a descriptor by value and touches no memory of
            // ours; `pty` is borrowed from self, so the fd is open.
            let group = unsafe { libc::tcgetpgrp(pty.as_raw_fd()) };
            // Its own group has the terminal, and it's still the shell:
            // `exec ssh` and `exec vim` keep both its pid and its group.
            group > 0
                && group == pid
                && program_of(pid).is_some_and(|now| rules::is_the_shell(shell, &now))
        }
        #[cfg(not(unix))]
        false
    }

    /// The shell alone has the terminal, which is what a command is typed
    /// into: in front, and nothing else in its group. With job control off
    /// (`unsetopt monitor`) a program the shell runs stays in the shell's
    /// group, so the group having the terminal doesn't say the shell is the
    /// one reading it: `ssh -tt elsewhere` would be (Codex's review, 11 Nov).
    /// Only asked when typing, as on Linux it reads every process's group.
    fn shell_alone_in_front(&self) -> bool {
        #[cfg(unix)]
        {
            self.shell_in_front() && self.pid.is_some_and(alone_in_group)
        }
        #[cfg(not(unix))]
        false
    }

    fn mode(&self) -> TermMode {
        *self.term.lock().mode()
    }

    /// What putting `block` here should do now (`putStep`).
    fn put_step(&self, block: &ShellBlock) -> Step {
        if self.exited {
            return Step::Busy;
        }
        let starting = self.started.elapsed().as_secs_f64() < rules::STARTING_FOR_SECS;
        rules::step(
            block,
            self.shell_alone_in_front(),
            self.mode().contains(TermMode::BRACKETED_PASTE),
            starting,
            &self.line,
        )
    }

    /// Pasted as the terminal's own paste is, in brackets (only ever typed
    /// when the shell has asked for them), so a newline in it runs nothing.
    fn put(&mut self, command: &str, cx: &mut Context<Self>) {
        self.scroll_to_bottom();
        self.write(rules::paste_bytes(command, true));
        self.set_line(Line::Put(command.to_owned()), cx);
    }

    fn set_line(&mut self, line: Line, cx: &mut Context<Self>) {
        if self.line != line {
            self.line = line;
            cx.notify();
        }
    }

    /// A command is waiting at the prompt for Return, so the panel says so.
    pub(crate) fn waiting_for_return(&self) -> bool {
        matches!(self.line, Line::Put(_)) && !self.exited
    }

    fn scroll_to_bottom(&mut self) {
        let mut term = self.term.lock();
        if term.grid().display_offset() != 0 {
            term.scroll_display(Scroll::Bottom);
        }
    }

    /// The screen's lines as text, trailing spaces gone.
    pub(crate) fn screen_lines(&self) -> Vec<String> {
        let term = self.term.lock();
        let offset = term.grid().display_offset() as i32;
        let cols = term.columns();
        (0..term.screen_lines() as i32)
            .map(|row| {
                let line = GridLine(row - offset);
                let text: String = (0..cols).map(|c| term.grid()[line][Column(c)].c).collect();
                text.trim_end().to_owned()
            })
            .collect()
    }

    /// The screen as lines of text rather than rows: a row the text wrapped
    /// from (the grid marks it) is joined to the next, and trailing spaces
    /// go. For the specs, as a command after a long prompt wraps in a narrow
    /// panel, and the rows alone can't say which of them are one line.
    #[cfg(feature = "automation")]
    pub(crate) fn screen_text_lines(&self) -> Vec<String> {
        use alacritty_terminal::term::cell::Flags;
        let term = self.term.lock();
        let grid = term.grid();
        let offset = grid.display_offset() as i32;
        let cols = term.columns();
        let mut lines = Vec::new();
        let mut line = String::new();
        for row in 0..term.screen_lines() as i32 {
            let row = &grid[GridLine(row - offset)];
            // As the screen draws them (terminal_element.rs): a wide
            // character's spacer cells aren't characters, and an accent
            // typed after its letter rides on that letter's cell.
            for c in 0..cols {
                let cell = &row[Column(c)];
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                line.push(cell.c);
                line.extend(cell.zerowidth().into_iter().flatten());
            }
            if cols == 0 || !row[Column(cols - 1)].flags.contains(Flags::WRAPLINE) {
                lines.push(line.trim_end().to_owned());
                line.clear();
            }
        }
        if !line.is_empty() {
            lines.push(line.trim_end().to_owned());
        }
        lines
    }

    // ---- Keys and text ----

    pub(crate) fn key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Keys typed in the Find bar come up through here too: they're its.
        if !self.focus.is_focused(window) {
            return;
        }
        let k = &event.keystroke;
        let m = k.modifiers;
        // ⌘ on the Mac, Control and Shift elsewhere, as terminals there have it.
        let command = if cfg!(target_os = "macos") {
            m.platform
        } else {
            m.control && m.shift
        };
        if command {
            match k.key.as_str() {
                "c" => {
                    self.copy(cx);
                    cx.stop_propagation();
                }
                "v" => {
                    self.paste(cx);
                    cx.stop_propagation();
                }
                "a" => {
                    self.select_all(cx);
                    cx.stop_propagation();
                }
                // The rest are the app's (⌘J, ⌘E, ⌘N...), but for the
                // shell's line editing keys on the Mac.
                _ => {}
            }
            if !(cfg!(target_os = "macos") && rules::COMMAND_KEYS.contains(&k.key.as_str())) {
                return;
            }
        }
        if self.exited {
            return;
        }
        let modes = {
            let mode = self.mode();
            rules::Modes {
                app_cursor: mode.contains(TermMode::APP_CURSOR),
                alt_screen: mode.contains(TermMode::ALT_SCREEN),
                option_is_meta: true,
            }
        };
        let key = rules::Key {
            key: &k.key,
            typed: k.key_char.as_deref(),
            shift: m.shift,
            control: m.control,
            alt: m.alt,
            command: m.platform,
        };
        match rules::encode_key(&key, modes) {
            KeyAction::Send(bytes) => {
                if k.key == "enter"
                    && !(m.shift || m.control || m.alt || m.platform)
                    && !modes.alt_screen
                    && self.shell_in_front()
                {
                    self.mark_here();
                }
                self.note_key(&k.key, m);
                self.typed(bytes, cx);
                cx.stop_propagation();
            }
            KeyAction::ScrollPage(direction) => {
                let mut term = self.term.lock();
                term.scroll_display(if direction < 0 {
                    Scroll::PageUp
                } else {
                    Scroll::PageDown
                });
                drop(term);
                cx.notify();
                cx.stop_propagation();
            }
            KeyAction::Nothing => cx.stop_propagation(),
            // A plain character comes back through the input method
            // (`replace_text_in_range`), which is how accents, other
            // languages' input and dictation reach a terminal too.
            KeyAction::Pass => {}
        }
        let _ = window;
    }

    /// Keys for a running program (vim's `q`) say nothing about the prompt.
    fn note_key(&mut self, key: &str, m: Modifiers) {
        if self.shell_in_front() {
            self.line =
                rules::line_after_key(&self.line, key, m.control, m.alt, m.shift, m.platform);
        }
    }

    /// Bytes from the keyboard: the view goes back to the bottom, as
    /// Terminal's does when you type, and a selection goes.
    fn typed(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) {
        {
            let mut term = self.term.lock();
            term.selection = None;
            if term.grid().display_offset() != 0 {
                term.scroll_display(Scroll::Bottom);
            }
        }
        self.write(bytes);
        self.blink_shown = true;
        self.blink_kept = true;
        cx.notify();
    }

    /// Text from the input method, a paste or dictation: anything but Return
    /// counts as someone's own text on the prompt.
    pub(crate) fn insert_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.marked.clear();
        if text.is_empty() || self.exited {
            cx.notify();
            return;
        }
        // More than one character at once with a line break or another
        // control in it (an input method's or a text expander's snippet,
        // dictated paragraphs) is a paste, not keys: each break would be
        // Return and run the line before it (Codex's review, 11 Nov). Line
        // breaks on their own are still Return.
        if rules::is_bulk_text(text) {
            self.paste_text(text.to_owned(), cx);
            return;
        }
        if text != "\r" && text != "\n" && self.shell_in_front() {
            self.line = Line::Edited;
        }
        self.typed(text.replace('\n', "\r").into_bytes(), cx);
    }

    pub(crate) fn set_marked(&mut self, text: &str, cx: &mut Context<Self>) {
        self.marked = text.to_owned();
        cx.notify();
    }

    fn copy(&mut self, cx: &mut Context<Self>) {
        let text = self.term.lock().selection_to_string();
        if let Some(text) = text.filter(|t| !t.is_empty()) {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    /// ⌘V: the clipboard's text as a paste, in brackets when the program
    /// asked. When it hasn't and the text has a line break, each line would
    /// run as it arrived, so that's asked about first (`paste_runs`).
    fn paste(&mut self, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.paste_text(text, cx);
        }
    }

    /// `text` as a paste: in brackets when the program asked, or asked
    /// about first when it hasn't and a line break would run what's before
    /// it. What's asked about is what's sent.
    fn paste_text(&mut self, text: String, cx: &mut Context<Self>) {
        if text.is_empty() || self.paste_now(&text, false, cx) {
            return;
        }
        // From a task: the question's loop can't run inside an update.
        cx.spawn(async move |this, cx| {
            let (title, detail) = rules::paste_question(&text);
            if crate::alert::confirm(&title, detail, "Paste", "Cancel") {
                let _ = this.update(cx, |s, cx| s.paste_now(&text, true, cx));
            }
        })
        .detach();
    }

    /// Pastes `text` for the mode the program's in now (read once, for both
    /// the check and the bytes), unless it would run lines and that hasn't
    /// been said yes to: false then, with nothing sent.
    fn paste_now(&mut self, text: &str, asked: bool, cx: &mut Context<Self>) -> bool {
        if self.exited {
            return true;
        }
        let bracketed = self.mode().contains(TermMode::BRACKETED_PASTE);
        if !bracketed && !asked && rules::paste_runs(text) {
            return false;
        }
        if self.shell_in_front() {
            self.line = Line::Edited;
        }
        self.typed(rules::paste_bytes(text, bracketed), cx);
        true
    }

    fn select_all(&mut self, cx: &mut Context<Self>) {
        let mut term = self.term.lock();
        let top = term.grid().topmost_line();
        let bottom = term.grid().bottommost_line();
        let last = term.grid().last_column();
        let mut selection = Selection::new(
            SelectionType::Simple,
            GridPoint::new(top, Column(0)),
            Side::Left,
        );
        selection.update(GridPoint::new(bottom, last), Side::Right);
        term.selection = Some(selection);
        drop(term);
        cx.notify();
    }

    // ---- The mouse ----

    /// The cell under `position`, and which half of it.
    fn cell_at(&self, position: Point<Pixels>, clamp: bool) -> Option<(usize, usize, Side)> {
        let at = self.drawn_at?;
        let x = f32::from(position.x - at.origin.x);
        let y = f32::from(position.y - at.origin.y);
        let (w, h) = (f32::from(at.cell_width), f32::from(at.cell_height));
        let (cols, rows) = (self.size.cols as f32, self.size.rows as f32);
        if !clamp && (x < 0. || y < 0. || x >= w * cols || y >= h * rows) {
            return None;
        }
        let col = (x / w).floor().clamp(0., cols - 1.);
        let row = (y / h).floor().clamp(0., rows - 1.);
        let side = if x - col * w < w / 2. {
            Side::Left
        } else {
            Side::Right
        };
        Some((col as usize, row as usize, side))
    }

    fn grid_point(&self, col: usize, row: usize) -> GridPoint {
        let offset = self.term.lock().grid().display_offset() as i32;
        GridPoint::new(GridLine(row as i32 - offset), Column(col))
    }

    fn reports_mouse(&self, shift: bool) -> bool {
        !shift && self.mode().intersects(TermMode::MOUSE_MODE) && !self.exited
    }

    /// A hyperlink printed by the program, or a path/address in its text.
    /// The scan follows soft-wrapped lines, capped so a very long line can
    /// never make a click stall the app.
    fn link_at(&self, col: usize, row: usize) -> Option<String> {
        self.link_span_at(col, row).map(|(link, _)| link)
    }

    /// `link_at`, with the screen rows and columns the link covers.
    fn link_span_at(
        &self,
        col: usize,
        row: usize,
    ) -> Option<(String, Vec<(usize, std::ops::Range<usize>)>)> {
        use alacritty_terminal::term::cell::Flags;
        let term = self.term.lock();
        let grid = term.grid();
        let cols = term.columns();
        if col >= cols || row >= term.screen_lines() {
            return None;
        }
        // Output can clear scrollback between two locks. Map the click and
        // inspect its cells under this one lock, so it stays the same row.
        let point = GridPoint::new(
            GridLine(row as i32 - grid.display_offset() as i32),
            Column(col),
        );
        let cell = &grid[point];
        let offset = grid.display_offset() as i32;
        if let Some(link) = cell.hyperlink() {
            if link.uri().len() > 4096 {
                return None;
            }
            // Along the row while the cells carry the same link.
            let same = |c: usize| grid[point.line][Column(c)].hyperlink().as_ref() == Some(&link);
            let (mut start, mut end) = (col, col + 1);
            while start > 0 && same(start - 1) {
                start -= 1;
            }
            while end < cols && same(end) {
                end += 1;
            }
            return Some((link.uri().to_owned(), vec![(row, start..end)]));
        }
        let mut first = point.line;
        while first > grid.topmost_line()
            && ((point.line.0 - first.0 + 2) as usize) * cols <= 4096
            && grid[GridLine(first.0 - 1)][Column(cols - 1)]
                .flags
                .contains(Flags::WRAPLINE)
        {
            first = GridLine(first.0 - 1);
        }
        let mut chars = Vec::new();
        // Where each character is: its line and its cell.
        let mut at = Vec::new();
        let mut clicked = None;
        let mut line = first;
        loop {
            for column in 0..cols {
                let cell = &grid[line][Column(column)];
                if line == point.line && column == col {
                    clicked = Some(chars.len());
                }
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    if line == point.line && column == col {
                        clicked = chars.len().checked_sub(1);
                    }
                    continue;
                }
                chars.push(cell.c);
                at.push((line.0, column));
                for c in cell.zerowidth().into_iter().flatten() {
                    chars.push(*c);
                    at.push((line.0, column));
                }
                if chars.len() > 4096 {
                    return None;
                }
            }
            if line >= grid.bottommost_line()
                || !grid[line][Column(cols - 1)].flags.contains(Flags::WRAPLINE)
            {
                break;
            }
            line = GridLine(line.0 + 1);
        }
        let span = rules::link_word_span(&chars, clicked?)?;
        let link: String = chars[span.clone()].iter().collect();
        // The cells it covers, a run per screen row (a wide character's
        // spacer included), leaving out rows scrolled out of sight.
        let mut cells: Vec<(usize, std::ops::Range<usize>)> = Vec::new();
        for &(line, column) in &at[span] {
            let Ok(screen_row) = usize::try_from(line + offset) else {
                continue;
            };
            if screen_row >= term.screen_lines() {
                continue;
            }
            let wide = grid[GridLine(line)][Column(column)]
                .flags
                .contains(Flags::WIDE_CHAR);
            let end = column + if wide { 2 } else { 1 };
            match cells.last_mut() {
                Some((r, run)) if *r == screen_row => run.end = run.end.max(end),
                _ => cells.push((screen_row, column..end)),
            }
        }
        Some((link, cells))
    }

    /// The web address under a cell, for the underline.
    fn hover_at(&self, col: usize, row: usize) -> Option<Hover> {
        let (url, cells) = self.link_span_at(col, row)?;
        rules::underlines(&url).then_some(Hover { cells, url })
    }

    /// The pointer moved over the window: the link under it, if any, is
    /// underlined, only once the cell it's over changes.
    fn follow_pointer(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let cell = if self.exited {
            None
        } else {
            self.cell_at(position, false)
                .map(|(col, row, _)| (col, row))
        };
        if cell == self.pointer {
            return;
        }
        self.pointer = cell;
        let hover = cell.and_then(|(col, row)| self.hover_at(col, row));
        if hover != self.hover {
            self.hover = hover;
            cx.notify();
        }
    }

    fn open_link_at(&self, col: usize, row: usize, cx: &mut App) -> bool {
        let Some(link) = self.link_at(col, row) else {
            return false;
        };
        let link = if link
            .get(..7)
            .is_some_and(|s| s.eq_ignore_ascii_case("file://"))
        {
            rules::local_file_url(&link, &system_hostname()).unwrap_or(link)
        } else {
            link
        };
        let home = crate::files::home_dir();
        let target = rules::link_target(&link, &self.target.cwd, &home, |p| {
            threadbear_core::open_policy::local_metadata(std::path::Path::new(p)).is_ok()
        });
        match target {
            Some(rules::Link::File(path)) => {
                crate::open_gate::open_file(&path, crate::open_gate::Origin::ThisMac, cx)
            }
            Some(rules::Link::Url(url)) => crate::open_gate::open_link(
                &url,
                crate::open_gate::Origin::ThisMac,
                &self.target.cwd,
                cx,
            ),
            None => return false,
        }
        true
    }

    fn report(
        &self,
        button: rules::MouseButton,
        pressed: bool,
        motion: bool,
        col: usize,
        row: usize,
        m: Modifiers,
    ) {
        let sgr = self.mode().contains(TermMode::SGR_MOUSE);
        if let Some(bytes) = rules::mouse_report(
            button, pressed, motion, col, row, m.shift, m.alt, m.control, sgr,
        ) {
            self.write(bytes);
        }
    }

    pub(crate) fn mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        crate::web_panels::keyboard_to_app(window);
        let Some((col, row, side)) = self.cell_at(event.position, false) else {
            return;
        };
        // Command-click (Control-click off the Mac) follows a link; ordinary
        // drags and the program's mouse reporting keep their usual behavior.
        let follow = if cfg!(target_os = "macos") {
            event.modifiers.platform
        } else {
            event.modifiers.control
        };
        if follow
            && !event.modifiers.shift
            && event.button == MouseButton::Left
            && event.click_count == 1
            && self.open_link_at(col, row, cx)
        {
            cx.stop_propagation();
            return;
        }
        let button = match event.button {
            MouseButton::Left => rules::MouseButton::Left,
            MouseButton::Middle => rules::MouseButton::Middle,
            MouseButton::Right => rules::MouseButton::Right,
            _ => return,
        };
        if self.reports_mouse(event.modifiers.shift) {
            self.report(button, true, false, col, row, event.modifiers);
            self.dragging = Some(Drag::Reporting);
            return;
        }
        // Right-click, or Control-click on the Mac: the terminal's own menu.
        let menu_click = event.button == MouseButton::Right
            || (cfg!(target_os = "macos")
                && event.button == MouseButton::Left
                && event.modifiers.control);
        if menu_click {
            self.menu_cell = Some((col, row));
            let menu = self.context_menu(col, row, cx);
            let at = event.position;
            window.defer(cx, move |window, cx| menu.show(at, window, cx));
            return;
        }
        if event.button != MouseButton::Left {
            return;
        }
        let point = self.grid_point(col, row);
        // ⌥-click moves the cursor there on the prompt, and ⌥-drag selects a
        // rectangle, as in Terminal.app.
        let option = event.modifiers.alt && !event.modifiers.shift && event.click_count == 1;
        self.option_click = option.then_some((col, row));
        let mut term = self.term.lock();
        match (
            event.click_count,
            event.modifiers.shift,
            term.selection.as_mut(),
        ) {
            // Shift-click carries the selection on to here.
            (1, true, Some(selection)) => selection.update(point, side),
            (n, _, _) => {
                let kind = match n {
                    _ if option => SelectionType::Block,
                    2 => SelectionType::Semantic,
                    3.. => SelectionType::Lines,
                    _ => SelectionType::Simple,
                };
                term.selection = Some(Selection::new(kind, point, side));
            }
        }
        drop(term);
        self.dragging = Some(Drag::Selecting);
        cx.notify();
    }

    pub(crate) fn mouse_moved(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some(drag) = self.dragging else {
            self.follow_pointer(event.position, cx);
            return;
        };
        if event.pressed_button.is_none() {
            self.dragging = None;
            return;
        }
        let Some((col, row, side)) = self.cell_at(event.position, true) else {
            return;
        };
        match drag {
            Drag::Reporting => {
                if self
                    .mode()
                    .intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION)
                {
                    self.report(
                        rules::MouseButton::Left,
                        true,
                        true,
                        col,
                        row,
                        event.modifiers,
                    );
                }
            }
            Drag::Selecting => {
                let point = self.grid_point(col, row);
                if let Some(selection) = self.term.lock().selection.as_mut() {
                    selection.update(point, side);
                }
                cx.notify();
            }
        }
    }

    pub(crate) fn mouse_up(&mut self, event: &MouseUpEvent, cx: &mut Context<Self>) {
        // Every button let go in the window comes here; only a drag that
        // started in the terminal is its business.
        let Some(drag) = self.dragging.take() else {
            return;
        };
        if drag == Drag::Reporting {
            if let Some((col, row, _)) = self.cell_at(event.position, true) {
                let button = match event.button {
                    MouseButton::Middle => rules::MouseButton::Middle,
                    MouseButton::Right => rules::MouseButton::Right,
                    _ => rules::MouseButton::Left,
                };
                self.report(button, false, false, col, row, event.modifiers);
            }
        }
        // A click that selected nothing leaves no selection behind.
        let mut term = self.term.lock();
        let empty = term.selection.as_ref().is_none_or(|s| s.is_empty());
        if empty {
            term.selection = None;
        }
        drop(term);
        if let Some(to) = self.option_click.take().filter(|_| empty) {
            self.move_cursor_to(to);
        }
        cx.notify();
    }

    /// The wheel or a trackpad: back through what's scrolled off, or for a
    /// full-screen program, its own scrolling (the arrow keys, or the wheel
    /// itself when it asked for the mouse), as Terminal does.
    pub(crate) fn scrolled(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        let Some(at) = self.drawn_at else { return };
        let dy = f32::from(event.delta.pixel_delta(at.cell_height).y);
        self.scroll_rest += dy / f32::from(at.cell_height);
        let lines = self.scroll_rest.trunc() as i32;
        if lines == 0 {
            return;
        }
        self.scroll_rest -= lines as f32;
        let mode = self.mode();
        if self.reports_mouse(event.modifiers.shift) {
            let (col, row, _) = self
                .cell_at(event.position, true)
                .unwrap_or((0, 0, Side::Left));
            let button = if lines > 0 {
                rules::MouseButton::WheelUp
            } else {
                rules::MouseButton::WheelDown
            };
            for _ in 0..lines.unsigned_abs().min(20) {
                self.report(button, true, false, col, row, event.modifiers);
            }
        } else if mode.contains(TermMode::ALT_SCREEN) && mode.contains(TermMode::ALTERNATE_SCROLL) {
            let arrow = match (lines > 0, mode.contains(TermMode::APP_CURSOR)) {
                (true, true) => "\x1bOA",
                (true, false) => "\x1b[A",
                (false, true) => "\x1bOB",
                (false, false) => "\x1b[B",
            };
            self.write(
                arrow
                    .repeat(lines.unsigned_abs().min(20) as usize)
                    .into_bytes(),
            );
        } else {
            self.term.lock().scroll_display(Scroll::Delta(lines));
            if let Some((col, row)) = self.pointer {
                self.hover = self.hover_at(col, row);
            }
            cx.notify();
        }
        cx.stop_propagation();
    }

    // ---- Terminal.app's comforts ----

    /// The bell (^G): a short flash, and a dot on its tab if you were
    /// looking elsewhere. Not a sound: an agent's build ringing it in a
    /// background tab shouldn't beep at you.
    fn ring(&mut self, cx: &mut Context<Self>) {
        let now = Instant::now();
        if self.bell_until.is_some_and(|until| now < until) {
            return;
        }
        self.bell_until = Some(now + Duration::from_millis(150));
        // Marked either way: a shell in a tab that isn't showing isn't drawn,
        // so its `focused` is stale. The one with the keyboard clears it as
        // it draws, and only tabs not showing have a dot.
        self.rang = true;
        if let Some(terminals) = terminals(cx) {
            terminals.update(cx, |_, cx| cx.notify());
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(160))
                .await;
            let _ = this.update(cx, |s, cx| {
                s.bell_until = None;
                cx.notify();
            });
        })
        .detach();
    }

    /// Return at the prompt: a mark on the line, for ⌘↑ and ⌘↓.
    fn mark_here(&mut self) {
        let term = self.term.lock();
        let line = term.grid().history_size() as i64 + term.grid().cursor.point.line.0 as i64;
        drop(term);
        self.marks.add(line);
    }

    /// ⌘↑ and ⌘↓: the command before or after the one at the top of the
    /// view, scrolled to the top. Past the last, ⌘↓ goes to the bottom.
    fn jump_to_mark(&mut self, up: bool, cx: &mut Context<Self>) {
        let mut term = self.term.lock();
        let history = term.grid().history_size() as i64;
        let offset = term.grid().display_offset() as i64;
        match rules::next_mark(self.marks.lines(), history - offset, up) {
            Some(mark) => {
                let to = (history - mark).clamp(0, history);
                term.scroll_display(Scroll::Delta((to - offset) as i32));
            }
            None if !up => term.scroll_display(Scroll::Bottom),
            None => {}
        }
        drop(term);
        self.after_scroll(cx);
    }

    fn scroll_to(&mut self, scroll: Scroll, cx: &mut Context<Self>) {
        self.term.lock().scroll_display(scroll);
        self.after_scroll(cx);
    }

    fn after_scroll(&mut self, cx: &mut Context<Self>) {
        if let Some((col, row)) = self.pointer {
            self.hover = self.hover_at(col, row);
        }
        cx.notify();
    }

    /// ⌘L, Terminal.app's Clear to Start: everything above the cursor's
    /// line goes, scrollback too, and that line (the prompt, with what's
    /// typed on it) moves to the top. A full-screen program keeps its screen;
    /// only the scrollback under it goes.
    fn clear_to_start(&mut self, cx: &mut Context<Self>) {
        use alacritty_terminal::vte::ansi::{ClearMode, Handler as _};
        let mut term = self.term.lock();
        if !term.mode().contains(TermMode::ALT_SCREEN) {
            let cursor = term.grid().cursor.point;
            if cursor.line.0 > 0 {
                term.scroll_up(cursor.line.0 as usize);
                term.goto(0, cursor.column.0);
            }
        }
        term.clear_screen(ClearMode::Saved);
        term.selection = None;
        drop(term);
        self.marks.clear();
        self.after_scroll(cx);
    }

    /// ⌥⌘K: only what's scrolled off goes.
    fn clear_scrollback(&mut self, cx: &mut Context<Self>) {
        use alacritty_terminal::vte::ansi::{ClearMode, Handler as _};
        self.term.lock().clear_screen(ClearMode::Saved);
        self.marks.clear();
        self.after_scroll(cx);
    }

    /// ⌥⌘R: the terminal back to how it started (modes, colours, screen),
    /// for after a program left it in a mess. The shell is asked to draw its
    /// prompt again (^L) when it's the one in front.
    fn reset(&mut self, cx: &mut Context<Self>) {
        use alacritty_terminal::vte::ansi::Handler as _;
        self.term.lock().reset_state();
        self.marks.clear();
        if self.shell_in_front() {
            self.write(vec![0x0c]);
        }
        self.after_scroll(cx);
    }

    /// ⌃⌘V: the clipboard's text as one word for the shell, escaped.
    fn paste_escaped(&mut self, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.paste_text(rules::shell_escaped(&text), cx);
        }
    }

    /// Files dropped on the terminal: their paths, escaped, as a paste.
    fn drop_paths(&mut self, paths: &[PathBuf], window: &mut Window, cx: &mut Context<Self>) {
        let paths: Vec<String> = paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let text = rules::dropped_paths(&paths);
        if !text.is_empty() {
            window.focus(&self.focus, cx);
            crate::web_panels::keyboard_to_app(window);
            self.paste_text(text, cx);
        }
    }

    /// ⌥-click: the cursor to the clicked cell, with arrow keys, when the
    /// shell's at its prompt and the cell is on the line being typed (the
    /// cursor's row and those it wraps onto).
    fn move_cursor_to(&mut self, to: (usize, usize)) {
        use alacritty_terminal::term::cell::Flags;
        if !self.shell_in_front() {
            return;
        }
        let term = self.term.lock();
        let mode = *term.mode();
        if term.grid().display_offset() != 0 || mode.contains(TermMode::ALT_SCREEN) {
            return;
        }
        let (cols, rows) = (term.columns(), term.screen_lines() as i32);
        if cols == 0 {
            return;
        }
        let grid = term.grid();
        let cursor = grid.cursor.point;
        let last = Column(cols - 1);
        let wraps = |line: i32| grid[GridLine(line)][last].flags.contains(Flags::WRAPLINE);
        let (mut top, mut bottom) = (cursor.line.0, cursor.line.0);
        while top > 0 && wraps(top - 1) {
            top -= 1;
        }
        while bottom < rows - 1 && wraps(bottom) {
            bottom += 1;
        }
        let from = (cursor.column.0, cursor.line.0.max(0) as usize);
        let row = to.1 as i32;
        drop(term);
        if row < top || row > bottom {
            return;
        }
        if let Some(bytes) =
            rules::cursor_moves(from, to, cols, mode.contains(TermMode::APP_CURSOR))
        {
            self.line = Line::Edited;
            self.write(bytes);
        }
    }

    /// The program running in front of the shell, by name, for asking
    /// before its tab closes. None at an idle prompt or once it's ended.
    pub(crate) fn busy_with(&self) -> Option<String> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd as _;
            if !self.running() {
                return None;
            }
            let (pid, pty) = (self.pid?, self.pty.as_ref()?);
            // SAFETY: takes a descriptor by value and touches no memory of
            // ours; `pty` is borrowed from self, so the fd is open.
            let group = unsafe { libc::tcgetpgrp(pty.as_raw_fd()) };
            if group <= 0 || self.shell_alone_in_front() {
                return None;
            }
            if group == pid {
                return Some("A program".to_owned());
            }
            Some(
                program_of(group)
                    .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                    .unwrap_or_else(|| "A program".to_owned()),
            )
        }
        #[cfg(not(unix))]
        None
    }

    /// This shell's name and its last lines of text, for when the app
    /// opens again. A full-screen program's screen isn't kept (only the
    /// name is), as it's not a shell's text.
    fn saved(&self) -> Option<rules::SavedTab> {
        use alacritty_terminal::term::cell::Flags;
        if self.failed.is_some() {
            return None;
        }
        let term = self.term.lock();
        if term.mode().contains(TermMode::ALT_SCREEN) {
            return Some(rules::SavedTab {
                name: self.name.clone(),
                text: String::new(),
            });
        }
        let grid = term.grid();
        let cols = term.columns();
        let bottom = grid.bottommost_line().0;
        let top = grid
            .topmost_line()
            .0
            .max(bottom - (rules::SAVED_LINES as i32 * 2));
        let mut lines = Vec::new();
        let mut line = String::new();
        for row in top..=bottom {
            let row = &grid[GridLine(row)];
            for c in 0..cols {
                let cell = &row[Column(c)];
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                line.push(cell.c);
            }
            if cols == 0 || !row[Column(cols - 1)].flags.contains(Flags::WRAPLINE) {
                lines.push(line.trim_end().to_owned());
                line.clear();
            }
        }
        Some(rules::SavedTab {
            name: self.name.clone(),
            text: rules::saved_text(&lines),
        })
    }

    /// The right-click menu, as Terminal.app's: the link under it, the
    /// clipboard, Find, and the clears, each with its key.
    fn context_menu(
        &self,
        col: usize,
        row: usize,
        cx: &App,
    ) -> gpui_kit::component::native_menu::NativeMenu {
        use gpui_kit::component::native_menu::NativeMenu;
        let has_selection = self
            .term
            .lock()
            .selection
            .as_ref()
            .is_some_and(|s| !s.is_empty());
        let mut menu = NativeMenu::new();
        if self.link_at(col, row).is_some() {
            menu = menu.menu("Open Link", Box::new(OpenMenuLink)).separator();
        }
        let _ = cx;
        menu.menu_with_disabled("Copy", !has_selection, Box::new(TerminalCopy))
            .menu_with_disabled("Paste", self.exited, Box::new(TerminalPaste))
            .menu_with_disabled("Paste Escaped Text", self.exited, Box::new(PasteEscaped))
            .menu("Select All", Box::new(TerminalSelectAll))
            .separator()
            .menu("Find…", Box::new(FindInTerminal))
            .separator()
            .menu("Clear to Start", Box::new(ClearToStart))
            .menu("Clear Scrollback", Box::new(ClearScrollback))
            .menu("Reset", Box::new(ResetTerminal))
            .separator()
            .menu("New Shell", Box::new(NewShell))
    }

    /// Runs `f` on the app's shells after this event, as it may come back
    /// to this one (which is being updated now).
    fn with_terminals(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut Terminals, &Target, &mut Window, &mut Context<Terminals>) + 'static,
    ) {
        let target = self.target.clone();
        window.defer(cx, move |window, cx| {
            if let Some(terminals) = terminals(cx) {
                terminals.update(cx, |t, cx| f(t, &target, window, cx));
            }
        });
    }

    // ---- Find (⌘F) ----

    /// ⌘F: the Find bar, its field holding the selection if there's a short
    /// one, or the bar's field again when it's already open.
    fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(finding) = &self.finding {
            let field = finding.field.clone();
            field.update(cx, |s, cx| s.select_all(window, cx));
            let handle = field.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
            crate::web_panels::keyboard_to_app(window);
            return;
        }
        let seed = self
            .term
            .lock()
            .selection_to_string()
            .filter(|s| !s.contains('\n') && s.chars().count() <= 200)
            .unwrap_or_default();
        let field = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Find")
                .default_value(seed.clone())
        });
        field.update(cx, |s, cx| s.select_all(window, cx));
        let sub = cx.subscribe(
            &field,
            |this: &mut Session, _, ev: &FieldEvent, cx| match ev {
                FieldEvent::Change => this.find_step(None, cx),
                FieldEvent::PressEnter { shift, .. } => this.find_step(Some(!*shift), cx),
                _ => {}
            },
        );
        let handle = field.read(cx).focus_handle(cx);
        self.finding = Some(Finding {
            field,
            at: None,
            count: String::new(),
            _sub: sub,
        });
        window.focus(&handle, cx);
        crate::web_panels::keyboard_to_app(window);
        if !seed.is_empty() {
            self.find_step(None, cx);
        }
        cx.notify();
    }

    fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.finding = None;
        window.focus(&self.focus, cx);
        crate::web_panels::keyboard_to_app(window);
        cx.notify();
    }

    /// Finds what's typed: `None` for the newest match (typing), `Some(true)`
    /// for the one above the match showing (Return, ⌘G), `Some(false)` for
    /// the one below (⇧Return, ⇧⌘G). The match is selected and scrolled to,
    /// so ⌘C copies it.
    fn find_step(&mut self, older: Option<bool>, cx: &mut Context<Self>) {
        let Some(finding) = self.finding.as_ref() else {
            return;
        };
        let typed = finding.field.read(cx).value().to_string();
        let from = older.and(finding.at.clone());
        let mut term = self.term.lock();
        let found = find_in(&term, &typed, from.as_ref(), older.unwrap_or(true));
        if let Some(m) = &found.at {
            let mut selection = Selection::new(SelectionType::Simple, *m.start(), Side::Left);
            selection.update(*m.end(), Side::Right);
            term.selection = Some(selection);
            term.scroll_to_point(*m.start());
        } else {
            term.selection = None;
        }
        drop(term);
        let count = if typed.is_empty() {
            String::new()
        } else {
            rules::find_count(found.index, found.total, found.capped)
        };
        if let Some(finding) = self.finding.as_mut() {
            finding.at = found.at;
            finding.count = count;
        }
        self.after_scroll(cx);
    }

    // ---- For the automation ----

    fn summary(&self) -> String {
        format!(
            "{} {} in {}",
            self.target.key,
            if self.exited { "exited" } else { "running" },
            self.target.cwd
        )
    }
}

/// The OS's hostname, never DNS or an environment variable a shell controls.
#[cfg(unix)]
fn system_hostname() -> String {
    let mut name = [0u8; 256];
    // SAFETY: gethostname writes at most `name.len()` bytes into `name`.
    if unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len()) } != 0 {
        return String::new();
    }
    std::ffi::CStr::from_bytes_until_nul(&name)
        .ok()
        .and_then(|s| s.to_str().ok())
        .unwrap_or("")
        .to_owned()
}

#[cfg(windows)]
fn system_hostname() -> String {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetComputerNameExW(kind: i32, buffer: *mut u16, size: *mut u32) -> i32;
    }
    let mut name = [0u16; 256];
    let mut size = name.len() as u32;
    // SAFETY: `size` holds the buffer's length in u16s, and the call writes
    // no more than that into `name`.
    if unsafe { GetComputerNameExW(1, name.as_mut_ptr(), &mut size) } == 0 {
        return String::new();
    }
    String::from_utf16_lossy(&name[..(size as usize).min(name.len())])
}

#[cfg(not(any(unix, windows)))]
fn system_hostname() -> String {
    String::new()
}

impl EventEmitter<ShellEnded> for Session {}

impl Focusable for Session {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Session {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colours = crate::terminal_element::Colours::current(cx);
        let focused = self.focus.is_focused(window);
        self.focused = focused;
        if focused {
            self.rang = false;
        }
        let me = cx.entity();
        let mut view = div()
            .id("terminal-session")
            .relative()
            .size_full()
            .bg(colours.background_hsla())
            .track_focus(&self.focus)
            .key_context(KEY_CONTEXT)
            .on_key_down(cx.listener(Self::key_down))
            .on_action(cx.listener(|this, _: &TerminalCopy, _, cx| this.copy(cx)))
            .on_action(cx.listener(|this, _: &TerminalPaste, _, cx| this.paste(cx)))
            .on_action(cx.listener(|this, _: &TerminalSelectAll, _, cx| this.select_all(cx)))
            .on_action(cx.listener(|this, _: &PasteEscaped, _, cx| this.paste_escaped(cx)))
            .on_action(cx.listener(|this, _: &ClearToStart, _, cx| this.clear_to_start(cx)))
            .on_action(cx.listener(|this, _: &ClearScrollback, _, cx| this.clear_scrollback(cx)))
            .on_action(cx.listener(|this, _: &ResetTerminal, _, cx| this.reset(cx)))
            .on_action(
                cx.listener(|this, _: &FindInTerminal, window, cx| this.open_find(window, cx)),
            )
            .on_action(cx.listener(|this, _: &FindOlder, window, cx| {
                if this.finding.is_none() {
                    this.open_find(window, cx);
                }
                this.find_step(Some(true), cx);
            }))
            .on_action(cx.listener(|this, _: &FindNewer, window, cx| {
                if this.finding.is_none() {
                    this.open_find(window, cx);
                }
                this.find_step(Some(false), cx);
            }))
            .on_action(cx.listener(|this, _: &PreviousMark, _, cx| this.jump_to_mark(true, cx)))
            .on_action(cx.listener(|this, _: &NextMark, _, cx| this.jump_to_mark(false, cx)))
            .on_action(cx.listener(|this, _: &ScrollToTop, _, cx| this.scroll_to(Scroll::Top, cx)))
            .on_action(
                cx.listener(|this, _: &ScrollToBottom, _, cx| this.scroll_to(Scroll::Bottom, cx)),
            )
            .on_action(cx.listener(|this, _: &NewShell, window, cx| {
                this.with_terminals(window, cx, |t, target, window, cx| {
                    t.new_shell(target, window, cx)
                })
            }))
            .on_action(cx.listener(|this, _: &NextShell, window, cx| {
                this.with_terminals(window, cx, |t, target, window, cx| {
                    t.cycle(&target.key, false, window, cx)
                })
            }))
            .on_action(cx.listener(|this, _: &PreviousShell, window, cx| {
                this.with_terminals(window, cx, |t, target, window, cx| {
                    t.cycle(&target.key, true, window, cx)
                })
            }))
            .on_action(cx.listener(|this, _: &OpenMenuLink, _, cx| {
                if let Some((col, row)) = this.menu_cell.take() {
                    this.open_link_at(col, row, cx);
                }
            }))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.drop_paths(paths.paths(), window, cx)
            }))
            .drag_over::<ExternalPaths>(|style, _, _, cx| {
                style.border_2().border_color(cx.theme().primary)
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                    crate::web_panels::keyboard_to_app(window);
                }),
            )
            // A little in from the panel's edges, on the terminal's own
            // background (TerminalHost.Container.inset).
            .child(
                div()
                    .size_full()
                    .px(px(10.))
                    .py(px(6.))
                    .child(TerminalElement::new(me, focused, self.blink_shown)),
            );
        if let (Some(hover), Some(at)) = (&self.hover, self.drawn_at) {
            // Over the link's first cells, for its tip; the terminal still
            // takes the click (it doesn't block the pointer).
            if let Some((row, cols)) = hover.cells.first() {
                let tip = format!("⌘-click to open {}", hover.url);
                let tip = if cfg!(target_os = "macos") {
                    tip
                } else {
                    tip.replacen("⌘-click", "Ctrl-click", 1)
                };
                view = view.child(crate::highlights::tipped_as(
                    div()
                        .id("terminal-link")
                        .absolute()
                        .left(px(10.) + at.cell_width * cols.start as f32)
                        .top(px(6.) + at.cell_height * *row as f32)
                        .w(at.cell_width * cols.len() as f32)
                        .h(at.cell_height),
                    tip,
                    gpui_kit::Role::Link,
                ));
            }
        }
        if self.bell_until.is_some() {
            view = view.child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .bg(style::primary_opacity(cx, 0.1)),
            );
        }
        if let Some(finding) = &self.finding {
            view = view.child(self.render_find(finding, cx));
        }
        if self.waiting_for_return() && self.finding.is_none() {
            // Over whatever's in the terminal's top corner.
            view = view.child(
                div()
                    .absolute()
                    .top(px(5.))
                    .right(px(6.))
                    .px(px(6.))
                    .py(px(2.))
                    .rounded(px(4.))
                    .bg(material(cx))
                    .text_size(px(style::size::DETAIL))
                    .line_height(px(style::natural_line(style::size::DETAIL)))
                    .text_color(style::secondary_text(cx))
                    .child("Return runs it"),
            );
        }
        if self.exited {
            let folder = threadbear_core::new_thread::abbreviate_home(
                &self.target.cwd,
                &crate::files::home_dir(),
            );
            let words = match &self.failed {
                Some(why) => format!("The shell couldn't start: {why}"),
                None => "The shell has exited.".to_owned(),
            };
            let key = self.target.key.clone();
            view = view.child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .flex()
                    .justify_center()
                    .child(
                        h_flex()
                            .m(px(10.))
                            .p(px(8.))
                            .gap(px(8.))
                            .rounded(px(8.))
                            .bg(material(cx))
                            .text_size(px(style::size::LABEL))
                            .line_height(px(style::natural_line(style::size::LABEL)))
                            .child(div().text_color(style::secondary_text(cx)).child(words))
                            .child(new_shell_button(key, &folder, cx)),
                    ),
            );
        }
        view
    }
}

impl Session {
    /// The Find bar over the terminal's top corner: the field, "3 of 12",
    /// older and newer, and close.
    fn render_find(&self, finding: &Finding, cx: &mut Context<Self>) -> AnyElement {
        let secondary = style::secondary_text(cx);
        let hover = style::hover_fill(cx);
        let button =
            |id: &'static str,
             icon: &'static str,
             tip: &'static str,
             cx: &mut Context<Self>,
             f: fn(&mut Session, &mut Window, &mut Context<Session>)| {
                crate::highlights::tipped(
                    div()
                        .id(id)
                        .flex_none()
                        .size(px(20.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(4.))
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover)),
                    tip,
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| f(this, window, cx)))
                .child(
                    crate::icons::symbol(icon)
                        .with_size(px(11.))
                        .text_color(secondary),
                )
            };
        let older = button(
            "terminal-find-older",
            "chevron.up",
            "Find the match above (Return or ⌘G)",
            cx,
            |this, _, cx| this.find_step(Some(true), cx),
        );
        let newer = button(
            "terminal-find-newer",
            "chevron.down",
            "Find the match below (Shift-Return or ⇧⌘G)",
            cx,
            |this, _, cx| this.find_step(Some(false), cx),
        );
        let close = button(
            "terminal-find-close",
            "xmark",
            "Close Find (Escape)",
            cx,
            |this, window, cx| this.close_find(window, cx),
        );
        div()
            .id("terminal-find")
            .absolute()
            .top(px(5.))
            .right(px(6.))
            .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                if ev.keystroke.key == "escape" {
                    this.close_find(window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                h_flex()
                    .gap(px(4.))
                    .pl(px(6.))
                    .pr(px(4.))
                    .py(px(3.))
                    .rounded(px(7.))
                    .bg(material(cx))
                    .border_1()
                    .border_color(style::hairline(cx))
                    .child(
                        div().w(px(170.)).child(
                            Input::new(&finding.field)
                                .appearance(false)
                                .small()
                                .pl(px(0.)),
                        ),
                    )
                    .child(
                        div()
                            .min_w(px(56.))
                            .text_size(px(style::size::DETAIL))
                            .text_color(secondary)
                            .child(finding.count.clone()),
                    )
                    .child(older)
                    .child(newer)
                    .child(close),
            )
            .into_any_element()
    }
}

/// New Shell: a SwiftUI push button.
fn new_shell_button(key: TerminalKey, folder: &str, cx: &App) -> AnyElement {
    crate::push_button::PushButton::new(
        "terminal-new-shell",
        "New Shell",
        format!("Start a new shell in {folder}"),
    )
    .render(cx, move |_, window, cx| {
        if let Some(terminals) = terminals(cx) {
            let key = key.clone();
            terminals.update(cx, |t, cx| t.restart(&key, window, cx));
        }
    })
}

/// SwiftUI's `.regularMaterial` over the terminal: a frosted grey, lighter
/// than the dark terminal and darker than the light one.
fn material(cx: &App) -> Hsla {
    if cx.theme().is_dark() {
        hsla(0., 0., 0.21, 0.94)
    } else {
        hsla(0., 0., 0.95, 0.94)
    }
}

/// What a search found: the match, its place among them all, and how many
/// there are (counted to `FIND_LIMIT`).
#[derive(Default)]
struct Found {
    at: Option<Match>,
    index: Option<usize>,
    total: usize,
    capped: bool,
}

const FIND_LIMIT: usize = 1000;

/// The match nearest `from` going up (`older`) or down, round past the end,
/// or with no `from` the newest, nearest the bottom.
fn find_in(term: &Term<Listener>, typed: &str, from: Option<&Match>, older: bool) -> Found {
    let Some(pattern) = rules::find_pattern(typed) else {
        return Found::default();
    };
    let Ok(mut regex) = RegexSearch::new(&pattern) else {
        return Found::default();
    };
    let grid = term.grid();
    let (origin, direction) = match from {
        Some(m) if older => (m.start().sub(term, Boundary::None, 1), Direction::Left),
        Some(m) => (m.end().add(term, Boundary::None, 1), Direction::Right),
        None => (
            GridPoint::new(grid.bottommost_line(), grid.last_column()),
            Direction::Left,
        ),
    };
    let at = term.search_next(&mut regex, origin, direction, Side::Left, None);
    // Every match, top to bottom, until the search comes round again.
    let mut all: Vec<Match> = Vec::new();
    let mut next = GridPoint::new(grid.topmost_line(), Column(0));
    while all.len() < FIND_LIMIT {
        let Some(m) = term.search_next(&mut regex, next, Direction::Right, Side::Left, None) else {
            break;
        };
        if all.last().is_some_and(|last| m.start() <= last.start()) {
            break;
        }
        next = m.end().add(term, Boundary::None, 1);
        all.push(m);
    }
    let index = at.as_ref().and_then(|at| all.iter().position(|m| m == at));
    Found {
        at,
        index,
        total: all.len(),
        capped: all.len() >= FIND_LIMIT,
    }
}

/// Where shells' text is kept between launches (`SavedTabs`): beside the
/// app's drafts in the runner's data folder.
fn saved_dir() -> PathBuf {
    threadbear_client::config::RunnerConfig::from_env()
        .home
        .join("desktop-terminal")
}

/// Saved text older than this is never brought back, and goes.
const SAVED_FOR: Duration = Duration::from_secs(14 * 24 * 60 * 60);

/// Writes a file only you can read, in a folder only you can open
/// (private_file.rs): a shell's text can have anything in it.
fn write_private(dir: &std::path::Path, name: &str, bytes: &[u8]) {
    if threadbear_core::private_file::dir(dir).is_ok() {
        let _ = threadbear_core::private_file::write(&dir.join(name), bytes);
    }
}

/// A thread's saved shells, and when they were saved, taken: the file goes
/// as it's read, so text only ever comes back once.
fn take_saved(key: &TerminalKey) -> Option<(rules::SavedTabs, String)> {
    let path = saved_dir().join(rules::saved_file_name(key));
    let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    let bytes = std::fs::read(&path).ok();
    let _ = std::fs::remove_file(&path);
    if modified.elapsed().map_or(true, |age| age > SAVED_FOR) {
        return None;
    }
    let saved: rules::SavedTabs = serde_json::from_slice(&bytes?).ok()?;
    Some((saved, rules::saved_when(modified)))
}

/// Saved text for threads that never opened their terminal again goes
/// after `SAVED_FOR`.
fn prune_saved() {
    let Ok(dir) = std::fs::read_dir(saved_dir()) else {
        return;
    };
    for entry in dir.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age > SAVED_FOR);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---------------------------------------------------------------- the input method

impl EntityInputHandler for Session {
    fn text_for_range(
        &mut self,
        range: std::ops::Range<usize>,
        adjusted: &mut Option<std::ops::Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let utf16: Vec<u16> = self.marked.encode_utf16().collect();
        let range = range.start.min(utf16.len())..range.end.min(utf16.len());
        *adjusted = Some(range.clone());
        Some(String::from_utf16_lossy(&utf16[range]))
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.marked.encode_utf16().count();
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<std::ops::Range<usize>> {
        (!self.marked.is_empty()).then(|| 0..self.marked.encode_utf16().count())
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.marked.clear();
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<std::ops::Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.insert_text(text, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<std::ops::Range<usize>>,
        new_text: &str,
        _new_selected: Option<std::ops::Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.set_marked(new_text, cx);
    }

    /// The cursor's cell, so the input method's window opens beside it.
    fn bounds_for_range(
        &mut self,
        _range: std::ops::Range<usize>,
        _element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let at = self.drawn_at?;
        let term = self.term.lock();
        let cursor = term.grid().cursor.point;
        let row = cursor.line.0 + term.grid().display_offset() as i32;
        let origin = point(
            at.origin.x + at.cell_width * cursor.column.0 as f32,
            at.origin.y + at.cell_height * row.max(0) as f32,
        );
        Some(Bounds {
            origin,
            size: size(at.cell_width, at.cell_height),
        })
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }

    fn accepts_text_input(&self, _window: &mut Window, _cx: &mut Context<Self>) -> bool {
        !self.exited
    }
}

// ---------------------------------------------------------------- the automation

/// The Terminal for the dump, in the Swift app's shape: whether it's showing,
/// the open thread's shell and its screen, and every shell.
#[cfg(feature = "automation")]
pub(crate) fn dump(app: &Threadbear, cx: &App) -> Value {
    let Some(terminals) = terminals(cx) else {
        return Value::Null;
    };
    let t = terminals.read(cx);
    let target = target_of(app);
    let session = t.current(&target.key).map(|s| s.read(cx));
    let mut shells: Vec<String> = t.all().map(|s| s.read(cx).summary()).collect();
    let tabs: Vec<Value> = t.sessions.get(&target.key).map(|tabs| {
        let current = tabs.current();
        tabs.shells.iter().map(|tab| json!({ "title": tab.session.read(cx).tab_title(), "current": &tab.session == current })).collect()
    }).unwrap_or_default();
    let renaming = t
        .renaming
        .as_ref()
        .map(|r| r.field.read(cx).value().to_string());
    shells.sort();
    json!({
        "shown": app.dock.read(cx).is_showing(crate::shell::TERMINAL),
        "cwd": target.cwd,
        "note": target.note,
        "shell": session.map_or("none", |s| if s.exited { "exited" } else { "running" }),
        "waitingForReturn": session.is_some_and(|s| s.waiting_for_return()),
        "pastesMarked": session.is_some_and(|s| !s.exited && s.mode().contains(TermMode::BRACKETED_PASTE)),
        "focused": session.is_some_and(|s| s.focused),
        "cols": session.map(|s| s.size.cols),
        "rows": session.map(|s| s.size.rows),
        "screen": session.map(|s| s.screen_lines()),
        "lines": session.map(|s| s.screen_text_lines()),
        "shells": shells,
        "tabs": tabs,
        "renaming": renaming,
        "hoveredLink": session.and_then(|s| s.hover.as_ref().map(|h| h.url.clone())),
        "find": session.and_then(|s| s.finding.as_ref().map(|f| json!({ "text": f.field.read(cx).value().to_string(), "count": f.count }))),
        "selection": session.and_then(|s| s.term.lock().selection_to_string()),
        "rang": t.sessions.get(&target.key).map(|tabs| tabs.shells.iter().filter(|tab| tab.session.read(cx).rang).count()),
    })
}

// ---------------------------------------------------------------- the shell's process

/// When a process started, which tells it from a later one given the same
/// pid: the library reaps the shell when it ends, and its pid can then go to
/// anything else, so a signal only goes to the same pid started at the same
/// time. None once it has ended, a zombie included. Between the check and
/// the signal a pid could in theory be reaped and handed on, but both
/// systems give pids out in turn, so that needs every pid used in between.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(unix),
    allow(dead_code, reason = "only Unix reads when a process was born")
)]
struct Born(u64, u64);

#[cfg(target_os = "macos")]
fn born(pid: i32) -> Option<Born> {
    // SAFETY: proc_bsdinfo is a plain C struct of integers and char arrays,
    // for which all zero bytes is a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: `info` is `size` bytes, and proc_pidinfo writes no more.
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    // 5 is SZOMB: it has ended and is waiting to be reaped.
    (read == size && info.pbi_status != 5)
        .then_some(Born(info.pbi_start_tvsec, info.pbi_start_tvusec))
}

#[cfg(target_os = "linux")]
fn born(pid: i32) -> Option<Born> {
    // The 22nd field of /proc/<pid>/stat, clock ticks from boot to its
    // start, counted after the name in brackets, which can have spaces in.
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let mut fields = stat[stat.rfind(')')? + 1..].split_whitespace();
    // The state comes first: Z or X has ended.
    if matches!(fields.next()?, "Z" | "X") {
        return None;
    }
    Some(Born(fields.nth(18)?.parse().ok()?, 0))
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn born(_pid: i32) -> Option<Born> {
    None
}

/// Whether `pid`'s group has no other process in it.
#[cfg(target_os = "macos")]
fn alone_in_group(pid: i32) -> bool {
    let mut pids = [0 as libc::pid_t; 64];
    let size = std::mem::size_of_val(&pids) as i32;
    // SAFETY: `pids` is `size` bytes, and proc_listpgrppids writes no more.
    let read = unsafe { libc::proc_listpgrppids(pid, pids.as_mut_ptr().cast(), size) };
    // Read from what's filled in rather than the count, so a group too big
    // for the list still has someone else in it.
    read >= 0 && pids.contains(&pid) && pids.iter().all(|&p| p == 0 || p == pid)
}

#[cfg(target_os = "linux")]
fn alone_in_group(pid: i32) -> bool {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return false;
    };
    !dir.flatten().any(|entry| {
        let Some(other) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<i32>().ok())
            .filter(|&o| o != pid)
        else {
            return false;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{other}/stat")) else {
            return false;
        };
        // The group is the 5th field: the 3rd after the name in brackets.
        stat.rfind(')')
            .and_then(|at| stat[at + 1..].split_whitespace().nth(2))
            .and_then(|g| g.parse::<i32>().ok())
            == Some(pid)
    })
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn alone_in_group(_pid: i32) -> bool {
    false
}

/// The program a process is running now.
#[cfg(target_os = "macos")]
fn program_of(pid: i32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStringExt as _;
    let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `path` is `path.len()` bytes, and proc_pidpath writes no more.
    let read = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if read <= 0 {
        return None;
    }
    path.truncate(read as usize);
    Some(PathBuf::from(std::ffi::OsString::from_vec(path)))
}

#[cfg(target_os = "linux")]
fn program_of(pid: i32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn program_of(_pid: i32) -> Option<PathBuf> {
    None
}

/// `signal` to the shell, if `pid` is still it.
#[cfg(unix)]
fn signal(pid: i32, when: Born, signal: i32) -> bool {
    // SAFETY: kill takes plain numbers and touches no memory; the start-time
    // check above is what keeps it to the same process.
    born(pid) == Some(when) && unsafe { libc::kill(pid, signal) } == 0
}

/// Ends a shell as closing a Terminal window does: SIGHUP, which an
/// interactive shell passes on to its jobs. One that ignores it (`trap ''
/// HUP`) would stay for good, still in a folder the next thread may be given:
/// the library waits for it to end before closing the pty, so it never reads
/// the end of its terminal either (Codex's review, 11 Nov). So it's asked
/// again with SIGTERM, which an interactive zsh ignores too, and then made
/// to go with SIGKILL, two seconds apart, on a thread of its own.
#[cfg(unix)]
fn end_shell(pid: i32, when: Born) {
    if !signal(pid, when, libc::SIGHUP) {
        return;
    }
    ENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((pid, when));
    std::thread::spawn(move || {
        for next in [libc::SIGTERM, libc::SIGKILL] {
            std::thread::sleep(Duration::from_secs(2));
            if !signal(pid, when, next) {
                break;
            }
        }
        // Gone, or told to with SIGKILL, which it can't refuse.
        ENDING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|&shell| shell != (pid, when));
    });
}

/// Shells `end_shell` is still ending, so quitting in the meantime ends them
/// itself (Codex's review, 11 Nov: archive, then quit within four seconds).
#[cfg(unix)]
static ENDING: Mutex<Vec<(i32, Born)>> = Mutex::new(Vec::new());

/// Ends every shell as the app quits: as `end_shell`, but within about half
/// a second and over before this returns, as nothing the app starts outlives
/// it. One that ignores SIGHUP and SIGTERM and never reads its terminal
/// (`trap '' HUP TERM; while :; do :; done`) would otherwise go on after the
/// app (Codex's review, 11 Nov). A shell that does as asked is gone within
/// the first wait.
#[cfg(unix)]
fn end_shells_now(shells: &[(i32, Born)]) {
    let alive = || shells.iter().any(|&(pid, when)| born(pid) == Some(when));
    for (next, wait) in [
        (libc::SIGHUP, 400),
        (libc::SIGTERM, 200),
        (libc::SIGKILL, 100),
    ] {
        for &(pid, when) in shells {
            signal(pid, when, next);
        }
        let until = Instant::now() + Duration::from_millis(wait);
        while alive() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !alive() {
            return;
        }
    }
}

/// The Swift app's `terminal` command: `{"toggle": true}` is ⌘J, `{"show":
/// true}` brings the panel up with nothing started, `{"type": "ls\r"}` types
/// into the showing thread's shell (starting one), `{"put": "ls"}` does what a
/// shell block's play icon does, `{"scroll": -5}` turns the wheel over the
/// terminal (back is up, so negative), `{"select": "all"}`, `{"copy": true}`
/// and `{"paste": "text"}` are ⌘A, ⌘C and ⌘V through its keys, `{"commit":
/// "text"}` is an input method's text all at once, `{"tab": "Terminal 2"}`
/// clicks a tab (`"clicks": 2` to rename it, then `{"name": "Dev server"}`
/// types its name and Return, or `"key": "escape"`), `{"new": true}` is the
/// tabs' + and `{"rename": "server"}` names the showing tab at once (the
/// Swift driver's two), `{"hover": "words"}`
/// points at words on the screen, and `{"wait": ms}` waits after. Each
/// answers with what the dump's `terminal` says.
#[cfg(feature = "automation")]
pub(crate) fn automation(
    app: &Entity<Threadbear>,
    cmd: &Value,
    window: &mut Window,
    cx: &mut App,
) -> Result<Value, String> {
    use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
    let terminals = terminals(cx).ok_or("no terminals")?;
    if cmd["toggle"].as_bool() == Some(true) {
        app.update(cx, |a, cx| toggle(a, window, cx));
    }
    if cmd["show"].as_bool() == Some(true) {
        app.update(cx, |a, cx| show_panel(a, cx));
    }
    let target = target_of(app.read(cx));
    terminals.update(cx, |t, cx| t.set_target(target.clone(), cx));
    // `{"new": true}` is the tabs' +, as the Swift driver's: another shell
    // in the same folder, showing.
    if cmd["new"].as_bool() == Some(true) {
        let session = terminals.update(cx, |t, cx| t.add(&target, cx));
        terminals.update(cx, |t, cx| t.focus(&session, window, cx));
    }
    if let Some(text) = cmd["type"].as_str() {
        let session = terminals.update(cx, |t, cx| t.open(&target, cx));
        let text = text.to_owned();
        session.update(cx, |s, cx| s.typed(text.into_bytes(), cx));
    }
    // `{"commit": "text"}` is an input method putting the whole text in at
    // once (a text expander's snippet, dictation), not a key at a time.
    if let Some(text) = cmd["commit"].as_str() {
        let session = terminals.update(cx, |t, cx| t.open(&target, cx));
        session.update(cx, |s, cx| s.insert_text(text, cx));
    }
    // `keys` types through the keyboard and the input method as a person
    // would, and `press` is one key ("enter", "ctrl-c", "up"), each with the
    // terminal given the keyboard first.
    if cmd["keys"].is_string() || cmd["press"].is_string() {
        let session = terminals.update(cx, |t, cx| t.open(&target, cx));
        let handle = session.read(cx).focus.clone();
        window.focus(&handle, cx);
        crate::web_panels::keyboard_to_app(window);
        window.render_frame(cx);
        if let Some(text) = cmd["keys"].as_str() {
            window.input(text, cx);
        }
        if let Some(key) = cmd["press"].as_str() {
            window.press(key, cx);
        }
    }
    // `{"find": "text"}` is ⌘F with the text typed in its field, and
    // `{"findKey": "enter"}` a key pressed there (Return for the match
    // above, "shift-enter" below, "escape" to close it).
    if let Some(text) = cmd["find"].as_str() {
        let session = terminals.update(cx, |t, cx| t.open(&target, cx));
        session.update(cx, |s, cx| s.open_find(window, cx));
        window.render_frame(cx);
        window.input(text, cx);
        window.render_frame(cx);
    }
    if let Some(key) = cmd["findKey"].as_str() {
        window.render_frame(cx);
        window.press(key, cx);
        window.render_frame(cx);
    }
    // What a shell block's play icon does, the copy when the shell's busy
    // included (shell_blocks.rs).
    if let Some(command) = cmd["put"].as_str() {
        let id = app.read(cx).selected.clone().unwrap_or_default();
        crate::shell_blocks::put(command, &id, window, cx);
    }
    // A tab by its title, through a real click (two for `"clicks": 2`,
    // which renames it), and `{"name": "..."}` typed into the rename
    // field with Return.
    if let Some(title) = cmd["tab"].as_str() {
        window.render_frame(cx);
        let tip = format!("Switch to {title}.");
        let found = window
            .elements()
            .into_iter()
            .find(|e| e.visible() && e.label().is_some_and(|l| l.starts_with(&tip)));
        let at = found
            .ok_or_else(|| format!("no tab called {title:?}"))?
            .visible_bounds()
            .center();
        window.pointer_move(at, None, cx);
        for click_count in 1..=cmd["clicks"].as_u64().unwrap_or(1).clamp(1, 2) as usize {
            let modifiers = window.modifiers();
            window.dispatch_event(
                MouseDownEvent {
                    button: MouseButton::Left,
                    position: at,
                    modifiers,
                    click_count,
                    first_mouse: false,
                }
                .to_platform_input(),
                cx,
            );
            window.render_frame(cx);
            window.dispatch_event(
                MouseUpEvent {
                    button: MouseButton::Left,
                    position: at,
                    modifiers,
                    click_count,
                }
                .to_platform_input(),
                cx,
            );
            window.render_frame(cx);
        }
    }
    if let Some(name) = cmd["name"].as_str() {
        window.render_frame(cx);
        if terminals.read(cx).renaming.is_none() {
            return Err("no tab is being renamed".into());
        }
        if !name.is_empty() {
            window.input(name, cx);
        } else {
            window.press("backspace", cx);
        }
        window.press(cmd["key"].as_str().unwrap_or("enter"), cx);
    }
    // `{"rename": "server"}` names the showing tab straight off, as the
    // Swift driver's ("" for the shell's own).
    if let Some(name) = cmd["rename"].as_str() {
        let id = terminals
            .read(cx)
            .current(&target.key)
            .map(|s| s.entity_id())
            .ok_or("no shell")?;
        terminals.update(cx, |t, cx| t.set_name(id, rules::tab_name(name), cx));
    }
    let session = terminals.read(cx).current(&target.key).cloned();
    if let Some(session) = &session {
        window.render_frame(cx);
        let handle = session.read(cx).focus.clone();
        if cmd["select"].as_str() == Some("all")
            || cmd["copy"].as_bool() == Some(true)
            || cmd["paste"].is_string()
        {
            window.focus(&handle, cx);
            crate::web_panels::keyboard_to_app(window);
            window.render_frame(cx);
        }
        // The terminal's own keys for them (`key_down`): ⌘ on the Mac, and
        // Control-Shift elsewhere, as Control-C there is the shell's
        // interrupt. `secondary-` is Control alone off the Mac, so on Linux
        // the copy went to the shell as ^A and ^C and nothing was copied.
        let key = |letter: &str| {
            if cfg!(target_os = "macos") {
                format!("cmd-{letter}")
            } else {
                format!("ctrl-shift-{letter}")
            }
        };
        if cmd["select"].as_str() == Some("all") {
            window.press(&key("a"), cx);
        }
        if cmd["copy"].as_bool() == Some(true) {
            window.press(&key("c"), cx);
        }
        if let Some(text) = cmd["paste"].as_str() {
            cx.write_to_clipboard(ClipboardItem::new_string(text.to_owned()));
            window.press(&key("v"), cx);
        }
        if let Some(lines) = cmd["scroll"].as_f64() {
            // A real wheel turn over the middle of the grid, through hit testing.
            let drawn = session
                .read(cx)
                .drawn_at
                .ok_or("the terminal hasn't been drawn")?;
            let size = session.read(cx).size;
            let at = point(
                drawn.origin.x + drawn.cell_width * (size.cols as f32 / 2.),
                drawn.origin.y + drawn.cell_height * (size.rows as f32 / 2.),
            );
            let event = ScrollEvent {
                position: at,
                delta: ScrollDelta::Lines(point(0., -(lines as f32))),
                modifiers: Modifiers::default(),
                touch_phase: TouchPhase::Moved,
                source: ScrollSource::Pointer,
            };
            window.dispatch_event(event.to_platform_input(), cx);
        }
    }
    // The pointer moved over words on the screen, as a person points at a link.
    if let Some(words) = cmd["hover"].as_str() {
        window.render_frame(cx);
        let session = session.as_ref().ok_or("no shell")?;
        let s = session.read(cx);
        let at = s.drawn_at.ok_or("the terminal hasn't been drawn")?;
        let (row, col) = s
            .screen_lines()
            .iter()
            .enumerate()
            .rev()
            .find_map(|(r, line)| line.find(words).map(|i| (r, line[..i].chars().count())))
            .ok_or("those words aren't visible")?;
        let position = point(
            at.origin.x + at.cell_width * (col as f32 + 0.5),
            at.origin.y + at.cell_height * (row as f32 + 0.5),
        );
        window.pointer_move(position, None, cx);
    }
    if let Some(words) = cmd["follow"].as_str() {
        window.render_frame(cx);
        let session = session.as_ref().ok_or("no shell")?;
        let s = session.read(cx);
        let at = s.drawn_at.ok_or("the terminal hasn't been drawn")?;
        let (row, col) = s
            .screen_lines()
            .iter()
            .enumerate()
            .rev()
            .find_map(|(r, line)| line.find(words).map(|i| (r, line[..i].chars().count())))
            .ok_or("that link isn't visible")?;
        let position = point(
            at.origin.x + at.cell_width * (col as f32 + 0.5),
            at.origin.y + at.cell_height * (row as f32 + 0.5),
        );
        let modifiers = Modifiers {
            platform: cfg!(target_os = "macos"),
            control: !cfg!(target_os = "macos"),
            ..Default::default()
        };
        window.dispatch_event(
            MouseDownEvent {
                button: MouseButton::Left,
                position,
                modifiers,
                click_count: 1,
                first_mouse: false,
            }
            .to_platform_input(),
            cx,
        );
        window.dispatch_event(
            MouseUpEvent {
                button: MouseButton::Left,
                position,
                modifiers,
                click_count: 1,
            }
            .to_platform_input(),
            cx,
        );
    }
    window.render_frame(cx);
    Ok(dump(app.read(cx), cx))
}

/// The automation's `terminal-menu`: a right-click on a tab (`tab`, its
/// title) through real events, then, once the kit has built the menu, its
/// items read back, or one pressed with `click`.
#[cfg(feature = "automation")]
pub(crate) async fn menu_command(
    window: AnyWindowHandle,
    cmd: &Value,
    cx: &mut AsyncApp,
) -> Result<Value, String> {
    use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
    let title = cmd["tab"]
        .as_str()
        .ok_or("terminal-menu needs tab")?
        .to_owned();
    cx.update_window(window, |_, window, cx| {
        crate::thread::scripted_input(|| {
            window.render_frame(cx);
            let tip = format!("Switch to {title}.");
            let found = window
                .elements()
                .into_iter()
                .find(|e| e.visible() && e.label().is_some_and(|l| l.starts_with(&tip)));
            let Some(tab) = found else {
                return Err(format!("no tab called {title:?}"));
            };
            let at = tab.visible_bounds().center();
            window.pointer_move(at, None, cx);
            window.pointer_down(at, MouseButton::Right, cx);
            window.pointer_up(at, MouseButton::Right, cx);
            Ok(())
        })
    })
    .map_err(|e| e.to_string())??;
    cx.background_executor()
        .timer(Duration::from_millis(150))
        .await;
    let items = cx
        .update_window(window, |_, window, cx| {
            window.render_frame(cx);
            crate::reply_links::open_menu_items(window, 0)
        })
        .map_err(|e| e.to_string())?;
    if let Some(click) = cmd["click"].as_str() {
        let Some((_, item)) = items.iter().find(|(t, _)| t == click) else {
            return Err(format!("no item {click} in {items:?}"));
        };
        let at = item.center();
        cx.update_window(window, |_, window, cx| {
            crate::thread::scripted_input(|| {
                window.pointer_move(at, None, cx);
                window.pointer_down(at, MouseButton::Left, cx);
                window.pointer_up(at, MouseButton::Left, cx);
            })
        })
        .map_err(|e| e.to_string())?;
        cx.background_executor()
            .timer(Duration::from_millis(100))
            .await;
        return Ok(json!("ok"));
    }
    let titles: Vec<&str> = items.iter().map(|(t, _)| t.as_str()).collect();
    if !titles.is_empty() && cmd["keep"].as_bool() != Some(true) {
        cx.update_window(window, |_, window, cx| window.press("escape", cx))
            .map_err(|e| e.to_string())?;
    }
    Ok(json!(format!(
        "ok {}",
        serde_json::to_string(&titles).unwrap_or_default()
    )))
}
