// The open card at the top of the composer (ComposerCard.swift, with the
// card's text and buttons from RowRenderer.asksText): Needs you with its asks,
// or Done with its follow-ups, drawn as ordinary elements. The Swift app's card
// is one attributed string with buttons drawn in it; here each ask is a block,
// which is how the transcript's rows are built too.
use crate::composer::Composer;
use crate::style;
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Enter, InputEvent, Textarea, TextareaState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;
use threadbear_core::composer::{self, OWN_ANSWER};
use threadbear_core::reducer::{Ask, AskNote, AsksCard, RowContent};

/// What Mike has picked on the open card, kept with the composer so it
/// survives moving to another thread and back (AppModel's askPicks, nextPicks
/// and collapsedCards).
#[derive(Default)]
pub(crate) struct CardState {
    /// The card these are for.
    pub(crate) seq: Option<i64>,
    pub(crate) picks: BTreeMap<i64, i64>,
    pub(crate) notes: BTreeMap<i64, AskNote>,
    pub(crate) next_picks: BTreeSet<i64>,
    pub(crate) explain: BTreeSet<i64>,
    /// Folded to its heading (ComposerCard's chevron).
    pub(crate) collapsed: bool,
    /// The ask a paged card is showing.
    pub(crate) page: usize,
    /// The boxes under "Something else", by ask.
    inputs: HashMap<usize, Entity<TextareaState>>,
    subs: Vec<Subscription>,
}

impl Composer {
    /// The open card the thread's transcript has (TranscriptModel.openCard),
    /// as long as it's open.
    pub(crate) fn open_card(&self, cx: &App) -> Option<AsksCard> {
        let pane = self.pane.upgrade()?;
        let row = pane.read(cx).feed.model().open_card()?;
        let RowContent::Asks(card) = &row.content else { return None };
        card.is_open.then(|| card.clone())
    }

    /// The card's state, reset when a new card turns up: it opens on its
    /// first unanswered ask.
    fn sync_card(&mut self, card: &AsksCard) {
        if self.card.seq != Some(card.seq) {
            self.card = CardState { seq: Some(card.seq), ..Default::default() };
        }
    }

    /// Hands the picks to the reducer, so the rest of the app reads them off
    /// the row as the Swift app's does (setAskPicks and friends), and puts the
    /// picks back after the pane has been remade.
    pub(crate) fn push_card_state(&self, cx: &mut App) {
        let (Some(pane), Some(seq)) = (self.pane.upgrade(), self.card.seq) else { return };
        let (picks, notes, next, explain) = (self.card.picks.clone(), self.card.notes.clone(), self.card.next_picks.clone(), self.card.explain.clone());
        pane.update(cx, |p, cx| p.set_card_picks(seq, picks, notes, next, explain, cx));
    }

    /// Picks an answer, or unpicks it when it's already the pick
    /// (AppModel.pickAnswer). A picked answer on a paged card moves on to the
    /// next one still waiting, a beat later so the tick shows first.
    pub(crate) fn pick_answer(&mut self, ask: usize, option: i64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(card) = self.open_card(cx) else { return };
        self.sync_card(&card);
        let key = ask as i64;
        let picked = self.card.picks.get(&key) == Some(&option);
        if picked {
            self.card.picks.remove(&key);
        } else {
            self.card.picks.insert(key, option);
        }
        self.push_card_state(cx);
        cx.notify();
        if !picked && option == OWN_ANSWER {
            // A box on another page of a paged card can't take the cursor
            // (only a script reaches this), so it stays in the composer.
            if !is_paged(&card) || self.card.page == ask {
                self.focus_answer_box(ask, window, cx);
            }
            return;
        }
        if !picked && option != OWN_ANSWER && is_paged(&card) {
            let page = self.card.page;
            cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(300)).await;
                this.update_in(cx, |this, _window, cx| {
                    if this.card.page != page {
                        return;
                    }
                    if let Some(card) = this.open_card(cx) {
                        if let Some(next) = composer::next_unanswered(page, card.asks.len(), &this.card.picks, false) {
                            this.card.page = next;
                            cx.notify();
                        }
                    }
                })
                .ok();
            })
            .detach();
        } else if !picked {
            self.focus(window, cx);
        }
    }

    fn set_note(&mut self, ask: usize, text: String, cx: &mut Context<Self>) {
        let note = self.card.notes.entry(ask as i64).or_default();
        note.text = text;
        self.push_card_state(cx);
        cx.notify();
    }

    fn toggle_follow_up(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let key = index as i64;
        if !self.card.next_picks.remove(&key) {
            self.card.next_picks.insert(key);
        }
        self.push_card_state(cx);
        cx.notify();
        self.focus(window, cx);
    }

    fn toggle_explain(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let key = index as i64;
        if !self.card.explain.remove(&key) {
            self.card.explain.insert(key);
        }
        self.push_card_state(cx);
        cx.notify();
        self.focus(window, cx);
    }

    fn set_page(&mut self, page: usize, cx: &mut Context<Self>) {
        self.card.page = page;
        cx.notify();
    }

    fn toggle_collapsed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.card.collapsed = !self.card.collapsed;
        cx.notify();
        self.focus(window, cx);
    }

    fn archive_thread(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(app) = self.app.upgrade() {
            app.update(cx, |app, cx| app.toggle_archive(window, cx));
        }
    }

    /// The box under an ask's "Something else" (AskAnswerBox): its own text
    /// field, kept for as long as the card is open.
    fn answer_box(&mut self, ask: usize, window: &mut Window, cx: &mut Context<Self>) -> Entity<TextareaState> {
        if let Some(input) = self.card.inputs.get(&ask) {
            return input.clone();
        }
        let existing = self.card.notes.get(&(ask as i64)).map(|n| n.text.clone()).unwrap_or_default();
        let input = cx.new(|cx| TextareaState::new(window, cx).placeholder("Say something else…").auto_grow(1, 8).submit_on_enter(true).default_value(existing));
        let sub = cx.subscribe_in(&input, window, move |this, input, ev: &InputEvent, window, cx| match ev {
            InputEvent::Change => {
                let text = input.read(cx).value().to_string();
                this.set_note(ask, text, cx);
            }
            InputEvent::PressEnter { secondary, shift: false } => this.answer_box_return(ask, *secondary, window, cx),
            _ => {}
        });
        self.card.subs.push(sub);
        self.card.inputs.insert(ask, input.clone());
        input
    }

    fn focus_answer_box(&mut self, ask: usize, window: &mut Window, cx: &mut Context<Self>) {
        let input = self.answer_box(ask, window, cx);
        input.update(cx, |s, cx| s.focus(window, cx));
    }

    /// Return in a Something else box goes on to the next ask still
    /// unanswered, and sends only once there's none; ⌘Return sends whatever's
    /// answered (TranscriptController.answerBoxReturn).
    fn answer_box_return(&mut self, ask: usize, command: bool, window: &mut Window, cx: &mut Context<Self>) {
        if command || !self.show_unanswered(ask, true, window, cx) {
            self.send(window, cx);
        }
    }

    /// Puts the next ask with nothing picked in front: its page on a paged
    /// card, or the Swift app's beep when they're all in sight already. False
    /// when none is left (TranscriptController.showUnanswered).
    pub(crate) fn show_unanswered(&mut self, ask: usize, or_this: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(card) = self.open_card(cx) else { return false };
        let filled = composer::filled_picks(&self.card.picks, &self.card.notes);
        let Some(next) = composer::next_unanswered(ask, card.asks.len(), &filled, or_this) else { return false };
        if is_paged(&card) && self.card.page != next {
            self.card.page = next;
            cx.notify();
            self.focus(window, cx);
        } else {
            // On a card showing every ask it's in sight already; the box says
            // so by staying put (the Swift app beeps here).
        }
        true
    }

    /// Return with nothing typed and picks on the card
    /// (ComposerView.returnWhenEmpty): the next unanswered ask, or send them.
    pub(crate) fn return_with_picks(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.card.picks.is_empty() && self.card.next_picks.is_empty() && self.card.explain.is_empty() {
            return false;
        }
        if !self.card.picks.is_empty() && self.show_unanswered(self.card.page, true, window, cx) {
            return true;
        }
        self.send(window, cx);
        true
    }

    /// What the card puts in the message (AppModel.send): the answers go
    /// first, each ask then its answer, and the box's own words after them,
    /// or the ticked follow-ups. None when the card adds nothing.
    pub(crate) fn card_message(&self, words: &str, cx: &App) -> Option<(String, Vec<threadbear_core::reducer::ImageRef>, Value)> {
        let card = self.open_card(cx)?;
        if card.is_done() {
            let ticked: Vec<String> = card.next.iter().enumerate().filter(|(i, _)| self.card.next_picks.contains(&(*i as i64))).map(|(_, t)| t.clone()).collect();
            let explain: Vec<String> = card.next.iter().enumerate().filter(|(i, _)| self.card.explain.contains(&(*i as i64))).map(|(_, t)| t.clone()).collect();
            if ticked.is_empty() && explain.is_empty() {
                return None;
            }
            return Some((composer::follow_up_message(&ticked, &explain, words), Vec::new(), Value::Null));
        }
        let answers = composer::answers(&card.asks, &self.card.picks, &self.card.notes);
        if answers.is_empty() {
            return None;
        }
        let answers_json: Vec<Value> = answers.iter().map(|(_, a)| json!({ "action": a.action, "answer": a.answer })).collect();
        let images = composer::note_images(&card.asks, &self.card.picks, &self.card.notes);
        Some((composer::answers_message(&card.asks, &self.card.picks, &self.card.notes, words), images, Value::Array(answers_json)))
    }

    /// What the box's card asks for next: its placeholder, by what's picked
    /// (ComposerView.placeholder).
    pub(crate) fn card_placeholder(&self, cx: &App) -> &'static str {
        let needs_you = self.open_card(cx).is_some_and(|c| !c.is_done());
        if !self.card.picks.is_empty() || !self.card.next_picks.is_empty() || !self.card.explain.is_empty() {
            "Add anything else…"
        } else if needs_you {
            "Or say something else…"
        } else {
            "Message"
        }
    }

    /// Everything goes as one message, so the picks go too when it's sent.
    pub(crate) fn clear_picks(&mut self, cx: &mut App) {
        self.card.picks.clear();
        self.card.notes.clear();
        self.card.next_picks.clear();
        self.card.explain.clear();
        self.card.inputs.clear();
        self.card.subs.clear();
        self.push_card_state(cx);
    }

    // ---- Drawing ----

    /// The card, over a line, at the top of the box.
    pub(crate) fn render_card(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let card = self.open_card(cx)?;
        self.sync_card(&card);
        let body = if card.is_done() { self.render_done_card(&card, cx) } else { self.render_asks_card(&card, window, cx) };
        // Under half the window (ComposerCardHost.maxHeight), for the card
        // itself: its padding comes on top, as the Swift box adds it outside.
        let max_height = gpui_kit::px((f32::from(window.viewport_size().height) * 0.45).max(style::zoomed(200.))) + px(18.);
        let column = div().id("composer-card").w_full().px(px(style::COMPOSER_PADDING)).pt(px(8.)).pb(px(10.)).max_h(max_height).overflow_y_scroll().child(body);
        // The separator under it, half a point as the Swift box's is.
        Some(v_flex().w_full().child(column).child(div().w_full().h(px(0.5)).bg(style::hairline(cx))).into_any_element())
    }

    /// RowRenderer.doneText: Done, with Archive at the right, and the agent's
    /// follow-ups under "Or carry on", each a row with a tick and a "?".
    fn render_done_card(&mut self, card: &AsksCard, cx: &mut Context<Self>) -> AnyElement {
        let mut column = v_flex().w_full();
        let this = cx.entity().downgrade();
        column = column.child(
            h_flex()
                .w_full()
                .h(px(metrics::PAGED_HEADING))
                .justify_between()
                .child(card_title(crate::icons::tall_checkmark().with_size(px(16.)).text_color(style::tick_green(cx)).into_any_element(), 2.5, "Done", cx))
                .child(card_button(("done-archive", 0usize), "Archive", ButtonLook::Plain, "Archive this thread", cx).on_click({
                    let this = this.clone();
                    move |_, window, cx| {
                        if let Some(this) = this.upgrade() {
                            this.update(cx, |this, cx| this.archive_thread(window, cx));
                        }
                    }
                })),
        );
        if let Some(ends) = &card.loose_ends {
            if !ends.is_empty() {
                let open = ends.iter().any(|e| e.kind != "booked");
                column = column.child(small_label(if open { "Still open" } else { "Coming back" }, cx));
                // Open ones first, then the check-ins (looseEndsText), each a
                // body line 4 under the last, its mark where a row's circle goes.
                for end in ends.iter().filter(|e| e.kind != "booked").chain(ends.iter().filter(|e| e.kind == "booked")) {
                    let booked = end.kind == "booked";
                    let mark = if booked { crate::icons::symbol("clock").text_color(style::secondary_text(cx)) } else { crate::icons::symbol("exclamationmark.circle").text_color(style::needs_you_text(cx)) };
                    column = column.child(
                        h_flex()
                            .w_full()
                            .items_start()
                            .mt(px(8.))
                            .pl(px(metrics::ROW_INSET))
                            .child(div().flex_none().w(px(metrics::ROW_WORDS - metrics::ROW_INSET)).h(px(style::size::BODY_LINE)).flex().items_center().child(mark.with_size(px(15.))))
                            .child(div().flex_1().min_w_0().text_size(px(style::size::BODY)).line_height(px(style::size::BODY_LINE)).text_color(style::label_text(cx)).child(end.text.clone())),
                    );
                }
            }
        }
        if !card.next.is_empty() {
            column = column.child(small_label("Or carry on", cx));
            for (index, follow_up) in card.next.iter().enumerate() {
                let (ticked, explained) = (self.card.next_picks.contains(&(index as i64)), self.card.explain.contains(&(index as i64)));
                let this2 = this.clone();
                let this3 = this.clone();
                // A row is a body line, 8 over and 8 under; its hover fill
                // reaches 5 past the line each way (drawHoveredRow), so the
                // fills sit 6 apart.
                column = column.child(
                    h_flex()
                        .id(("follow-up", index))
                        .w_full()
                        .items_start()
                        .mt(px(if index == 0 { 3. } else { 6. }))
                        .pl(px(metrics::ROW_INSET))
                        .py(px(5.))
                        .rounded(px(6.))
                        .cursor_pointer()
                        .hover(|s| s.bg(style::hover_fill(cx)))
                        .tooltip(|window, cx| Tooltip::new("Send this with your next message").build(window, cx))
                        .on_click(move |_, window, cx| {
                            if let Some(this) = this2.upgrade() {
                                this.update(cx, |this, cx| this.toggle_follow_up(index, window, cx));
                            }
                        })
                        .child(div().flex_none().w(px(metrics::ROW_WORDS - metrics::ROW_INSET)).h(px(style::size::BODY_LINE)).flex().items_center().child(tick_circle(ticked, cx)))
                        .child(div().flex_1().min_w_0().text_size(px(style::size::BODY)).line_height(px(style::size::BODY_LINE)).text_color(style::label_text(cx)).child(follow_up.clone()))
                        .child(
                            div()
                                .id(("follow-up-explain", index))
                                .flex_none()
                                .mx(px(8.))
                                .size(px(22.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_full()
                                .cursor_pointer()
                                .hover(|s| s.bg(style::hover_fill(cx)))
                                .child(Icon::from(IconName::CircleQuestionMark).with_size(px(14.)).text_color(if explained { style::accent(cx) } else { style::quiet_text(cx) }))
                                .tooltip(|window, cx| Tooltip::new("Ask what this means").build(window, cx))
                                .on_click(move |_, window, cx| {
                                    cx.stop_propagation();
                                    if let Some(this) = this3.upgrade() {
                                        this.update(cx, |this, cx| this.toggle_explain(index, window, cx));
                                    }
                                }),
                        ),
                );
            }
        }
        column.into_any_element()
    }

    /// RowRenderer.asksText: the heading, then each ask with its answers. Over
    /// the height a card can take, one ask at a time with ‹ 1 of 3 ›, the card
    /// as tall as its tallest page so the box doesn't jump as he pages
    /// (ComposerCardHost.render).
    fn render_asks_card(&mut self, card: &AsksCard, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let collapsed = self.card.collapsed;
        let paged = !collapsed && is_paged(card);
        let page = self.card.page.min(card.asks.len().saturating_sub(1));
        let decisions = card.asks.iter().all(|a| !a.options.is_empty());
        let words = if !decisions {
            "Needed from you"
        } else if card.asks.len() == 1 {
            "Decision needed"
        } else {
            "Decisions needed"
        };
        let this = cx.entity().downgrade();
        let collapse_this = this.clone();
        // The heading line (asksHeading): a work line, or on a paged card a
        // button tall for the arrows, with the chevron at its right.
        let mut heading = h_flex()
            .w_full()
            .h(px(if paged { metrics::PAGED_HEADING } else { metrics::HEADING }))
            .items_center()
            .justify_between()
            .child(card_title(crate::icons::symbol("hand.raised.fill").with_size(px(16.5)).text_color(style::needs_you(cx)).into_any_element(), 3.5, words, cx));
        let mut right = h_flex().flex_none().items_center();
        if paged {
            let (this_back, this_next) = (this.clone(), this.clone());
            right = right
                .child(pager_arrow("‹", page > 0, "Previous ask", ("page-back", 0usize), cx, move |_, _, cx| {
                    if let Some(this) = this_back.upgrade() {
                        this.update(cx, |this, cx| this.set_page(page.saturating_sub(1), cx));
                    }
                }))
                .child(div().px(px(metrics::PAGER_PAD)).text_size(px(style::size::LABEL)).line_height(px(16.)).text_color(style::secondary_label(cx)).child(format!("{} of {}", page + 1, card.asks.len())))
                .child(pager_arrow("›", page + 1 < card.asks.len(), "Next ask", ("page-next", 0usize), cx, move |_, _, cx| {
                    if let Some(this) = this_next.upgrade() {
                        this.update(cx, |this, cx| this.set_page(page + 1, cx));
                    }
                }))
                // The arrows end 7 short of the chevron (the heading's tab stop).
                .child(div().w(px(7.)));
        }
        right = right.child(
            div()
                .id("card-collapse")
                .flex_none()
                .size(px(metrics::TOGGLE))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.))
                .cursor_pointer()
                .text_color(style::secondary_text(cx))
                .hover(|s| s.bg(style::primary_opacity(cx, 0.08)).text_color(style::label_text(cx)))
                .active(|s| s.bg(style::primary_opacity(cx, 0.14)))
                // SF's chevron at 11 pt semibold is about 10 by 6; Lucide's,
                // a 12 by 6 stroke in 24, comes to that at 17.
                .child(Icon::from(if collapsed { IconName::ChevronUp } else { IconName::ChevronDown }).with_size(px(17.)))
                .tooltip(move |window, cx| Tooltip::new(if collapsed { "Expand" } else { "Collapse" }).build(window, cx))
                .on_click(move |_, window, cx| {
                    if let Some(this) = collapse_this.upgrade() {
                        this.update(cx, |this, cx| this.toggle_collapsed(window, cx));
                    }
                }),
        );
        // On a work line the chevron, a little taller than the line, hangs
        // from its top (placeToggle).
        heading = heading.child(right.when(!paged, |r| r.self_start()));
        if collapsed {
            // Never shorter than the chevron beside it.
            return v_flex().w_full().min_h(px(metrics::TOGGLE)).child(heading).into_any_element();
        }
        let mut column = v_flex().w_full().child(heading.when(!paged, |h| h.mb(px(metrics::HEADING_SPACING))));
        let numbered = card.asks.len() > 1;
        if paged {
            // Every page in the same cell, so the cell is the tallest one's
            // height; only the page showing is drawn, and it goes last so
            // it's the one on top for the pointer.
            let mut pages = div().w_full().grid().grid_cols(1);
            for (index, ask) in card.asks.iter().enumerate().filter(|(i, _)| *i != page).chain(card.asks.iter().enumerate().filter(|(i, _)| *i == page)) {
                pages = pages.child(div().w_full().min_w_0().col_start(1).row_start(1).when(index != page, |d| d.invisible()).child(self.render_ask(index, ask, numbered, window, cx)));
            }
            column = column.child(pages);
        } else {
            for (index, ask) in card.asks.iter().enumerate() {
                column = column.child(self.render_ask(index, ask, numbered, window, cx));
            }
        }
        column.into_any_element()
    }

    fn render_ask(&mut self, index: usize, ask: &Ask, numbered: bool, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let picked = self.card.picks.get(&(index as i64)).copied();
        let choices = composer::choices(ask);
        // A numbered ask's text starts past its number, as in a list in a
        // message; its buttons line up with the text, not the number.
        let indent = if numbered { px(metrics::INDENT) } else { px(0.) };
        // Its links through the open gate, from the thread's folder; with no
        // thread to say, or another runner's, no file of it opens here.
        let thread = self.chip_data(cx).summary;
        let origin = if thread.as_ref().is_some_and(|t| !t.is_remote()) { crate::open_gate::Origin::ThisMac } else { crate::open_gate::Origin::OtherMac };
        let cwd = thread.map(|t| t.cwd).unwrap_or_default();
        // The paragraph, 12 under what's above, in a message's markdown, so a
        // list in the why looks the way it would in the message.
        let text = crate::open_gate::reading_markdown_view(("ask-text", index), ask_paragraph(ask), origin, &cwd).style(self.card_reading_style(cx));
        let paragraph = if numbered {
            // The number where a list's goes (MarkdownRenderer.markerStart).
            h_flex()
                .w_full()
                .items_start()
                .child(div().flex_none().w(indent).pl(px(metrics::NUMBER_AT)).text_color(style::label_text(cx)).child(format!("{}.", index + 1)))
                .child(div().flex_1().min_w_0().child(text))
                .into_any_element()
        } else {
            div().w_full().child(text).into_any_element()
        };
        let mut block = v_flex().w_full().pt(px(metrics::ASK_BEFORE)).child(div().w_full().text_size(px(style::size::BODY)).line_height(px(style::size::BODY_LINE)).child(paragraph));
        // A quiet line of its own, 2 under the paragraph.
        if let Some(place) = ask.where_.as_deref().filter(|w| !w.is_empty()) {
            block = block.child(div().pl(indent).mt(px(metrics::ASK_AFTER)).text_size(px(style::size::SMALL)).line_height(px(metrics::WHERE_LINE)).text_color(style::faint_text(cx)).child(place.to_owned()));
        }
        let this = cx.entity().downgrade();
        let half = (metrics::BUTTON_LINE - metrics::BUTTON_HEIGHT) / 2.;
        // Its links on a line of their own, over the answers: going to look
        // comes before answering. The first is the thing to go and do.
        let home = std::env::var("HOME").unwrap_or_default();
        let links: Vec<(usize, String, String)> = ask.links.iter().enumerate().filter_map(|(n, link)| link.target(&home).map(|target| (n, link.title.clone(), target))).collect();
        let has_links = !links.is_empty();
        if has_links {
            let mut row = h_flex().w_full().pl(indent).mt(px(metrics::ASK_AFTER + metrics::BUTTONS_BEFORE)).py(px(half)).flex_wrap().gap_x(px(metrics::BUTTON_GAP)).gap_y(px(half * 2.));
            for (n, title, target) in links {
                let this = this.clone();
                let look = if n == 0 { ButtonLook::Picked } else { ButtonLook::Plain };
                let tip: &'static str = if target.starts_with("review:") { "Open the design options" } else { "Open this" };
                row = row.child(card_button(("ask-link", index * 100 + n), &format!("{title} ↗"), look, tip, cx).on_click(move |_, window, cx| {
                    if let Some(this) = this.upgrade() {
                        let target = target.clone();
                        this.update(cx, |this, cx| this.open_ask_link(&target, window, cx));
                    }
                }));
            }
            block = block.child(row);
        }
        if ask.option_notes.is_empty() {
            // Buttons on 38 pt lines that wrap, 2 and then 6 under what's
            // above, four spaces apart, with Something else… after them.
            let mut buttons = h_flex()
                .w_full()
                .pl(indent)
                // 6 under the links' line, or 2 and 6 under the words.
                .mt(px(if has_links { metrics::BUTTONS_BEFORE } else { metrics::ASK_AFTER + metrics::BUTTONS_BEFORE }))
                .py(px(half))
                .flex_wrap()
                .gap_x(px(metrics::BUTTON_GAP))
                .gap_y(px(half * 2.));
            for (n, choice) in choices.iter().enumerate() {
                let is_picked = picked == Some(n as i64);
                let look = if is_picked {
                    ButtonLook::Picked
                } else if ask.suggested == Some(n) {
                    ButtonLook::Suggested
                } else {
                    ButtonLook::Plain
                };
                let title = if is_picked { format!("✓ {choice}") } else { choice.clone() };
                let this = this.clone();
                buttons = buttons.child(card_button(("answer", index * 100 + n), &title, look, "Pick this answer", cx).on_click(move |_, window, cx| {
                    if let Some(this) = this.upgrade() {
                        this.update(cx, |this, cx| this.pick_answer(index, n as i64, window, cx));
                    }
                }));
            }
            let own = picked == Some(OWN_ANSWER);
            let this2 = this.clone();
            buttons = buttons.child(card_button(("answer-own", index), if own { "✓ Something else" } else { "Something else…" }, if own { ButtonLook::Picked } else { ButtonLook::Plain }, "Answer in your own words", cx).on_click(move |_, window, cx| {
                if let Some(this) = this2.upgrade() {
                    this.update(cx, |this, cx| this.pick_answer(index, OWN_ANSWER, window, cx));
                }
            }));
            block = block.child(buttons);
        } else {
            block = block.child(self.render_answer_rows(index, ask, picked, indent, cx));
        }
        if picked == Some(OWN_ANSWER) {
            let input = self.answer_box(index, window, cx);
            let this3 = this.clone();
            // AskAnswerBox: 8 under the buttons, 10 and 6 in from its edge.
            block = block.child(
                div()
                    .pl(indent)
                    .pt(px(8.))
                    .capture_action(move |action: &Enter, window, cx| {
                        if action.secondary {
                            if let Some(this) = this3.upgrade() {
                                this.update(cx, |this, cx| this.answer_box_return(index, true, window, cx));
                                cx.stop_propagation();
                            }
                        }
                    })
                    .child(
                        div()
                            .w_full()
                            .px(px(10.))
                            .py(px(6.))
                            .rounded(px(10.))
                            .border_1()
                            .border_color(style::hairline(cx))
                            .bg(style::answer_box_fill(cx))
                            .child(crate::composer::bare_textarea(Textarea::new(&input)).text_size(px(style::size::COMPOSER)).line_height(px(style::size::BODY_LINE))),
                    ),
            );
        }
        block.into_any_element()
    }

    /// One of an ask's links: through the thread's own link handling, as a
    /// link in its transcript goes (a file into the pane, a page through the
    /// open gate, a review to its window).
    fn open_ask_link(&mut self, target: &str, window: &mut Window, cx: &mut Context<Self>) {
        let url = ask_link_url(target);
        if let Some(pane) = self.pane.upgrade() {
            pane.update(cx, |p, cx| p.link_clicked(&url, "", window, cx));
        }
    }

    /// The reading column's text style for the card's paragraphs, one per
    /// appearance and text size, as its sizes are zoomed when it's built
    /// (see `rows::reading_style`).
    fn card_reading_style(&mut self, cx: &App) -> gpui_kit::base::TextViewStyle {
        let key = (cx.theme().is_dark(), style::zoom_percent());
        match &self.card_style {
            Some((k, style)) if *k == key => style.clone(),
            _ => {
                let built = crate::rows::reading_style(cx);
                self.card_style = Some((key, built.clone()));
                built
            }
        }
    }

    /// An ask's answers as rows (RowRenderer.answerRows): a circle, the label,
    /// a star and "Recommended" on the agent's, what it does under it, then "Something else…".
    fn render_answer_rows(&mut self, index: usize, ask: &Ask, picked: Option<i64>, indent: Pixels, cx: &mut Context<Self>) -> AnyElement {
        let choices = composer::choices(ask);
        let this = cx.entity().downgrade();
        let mut rows = v_flex().mt(px(10.)).ml(indent).rounded(px(10.)).overflow_hidden().bg(style::answer_rows_fill(cx));
        for n in 0..=choices.len() {
            let own = n == choices.len();
            let value = if own { OWN_ANSWER } else { n as i64 };
            let is_picked = picked == Some(value);
            let suggested = !own && ask.suggested == Some(n);
            let this = this.clone();
            let label = if own { "Something else…".to_owned() } else { choices[n].clone() };
            let note = (!own).then(|| ask.option_notes.get(n).cloned()).flatten().filter(|s| !s.is_empty());
            rows = rows.child(
                h_flex()
                    .id(("answer-row", index * 100 + n))
                    .w_full()
                    .items_start()
                    .gap(px(8.))
                    .px(px(10.))
                    .py(px(7.))
                    .when(n > 0, |s| s.border_t_1().border_color(style::hairline(cx)))
                    .cursor_pointer()
                    .hover(|s| s.bg(style::hover_fill(cx)))
                    .tooltip(move |window, cx| Tooltip::new(if own { "Answer in your own words" } else { "Pick this answer" }).build(window, cx))
                    .on_click(move |_, window, cx| {
                        if let Some(this) = this.upgrade() {
                            this.update(cx, |this, cx| this.pick_answer(index, value, window, cx));
                        }
                    })
                    .child(div().pt(px(3.)).child(tick_circle(is_picked, cx)))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(
                                h_flex().gap(px(8.)).child(div().text_size(px(style::size::COMPOSER)).text_color(if own { style::quiet_text(cx) } else { cx.theme().foreground }).child(label)).when(suggested, |s| {
                                    s.child(
                                        h_flex()
                                            .gap(px(3.))
                                            .child(div().text_size(px(10.)).text_color(style::recommended_star(cx)).child("★"))
                                            .child(div().text_size(px(12.)).text_color(style::quiet_text(cx)).child("Recommended")),
                                    )
                                }),
                            )
                            .when_some(note, |s, note| s.child(div().text_size(px(12.)).text_color(style::quiet_text(cx)).child(note))),
                    ),
            );
        }
        rows.into_any_element()
    }

    // ---- For the automation ----

    /// The picks as the Swift dump's `decisions` says them.
    #[cfg(feature = "automation")]
    pub(crate) fn decision_lines(&self, cx: &App) -> Option<Vec<String>> {
        let card = self.open_card(cx)?;
        if card.is_done() {
            return None;
        }
        let mut lines = vec![format!("{} picked", self.card.picks.len())];
        for (i, ask) in card.asks.iter().enumerate() {
            let options = composer::choices(ask);
            let choices: Vec<String> = options.iter().enumerate().map(|(n, o)| if ask.suggested == Some(n) { format!("*{o}") } else { o.clone() }).collect();
            let picked = self.card.picks.get(&(i as i64));
            let answer = match picked {
                Some(&OWN_ANSWER) => format!("something else: \"{}\"", self.card.notes.get(&(i as i64)).map(|n| n.text.clone()).unwrap_or_default()),
                Some(n) => options.get(*n as usize).cloned().unwrap_or_else(|| "no answer".to_owned()),
                None => "no answer".to_owned(),
            };
            lines.push(format!("  {}. {} [{}] -> {}", i + 1, ask.action, choices.join(" | "), answer));
        }
        Some(lines)
    }

    /// The Swift automation's `decide`: picks as its buttons pick, waiting in
    /// the composer. `pick` is "ask:choice", 1-based, choice 0 for Something else.
    #[cfg(feature = "automation")]
    pub(crate) fn decide(&mut self, cmd: &Value, window: &mut Window, cx: &mut Context<Self>) -> Result<String, String> {
        let Some(card) = self.open_card(cx).filter(|c| !c.is_done()) else { return Err("the open thread has no card of asks to answer".to_owned()) };
        self.sync_card(&card);
        if cmd["clear"].as_bool().unwrap_or(false) {
            self.card.picks.clear();
            self.push_card_state(cx);
        }
        if let Some(pick) = cmd["pick"].as_str() {
            let parts: Vec<usize> = pick.split(':').filter_map(|p| p.parse().ok()).collect();
            let [ask, choice] = parts.as_slice() else { return Err(format!("no choice {pick}")) };
            let Some(the_ask) = card.asks.get(ask.wrapping_sub(1)) else { return Err(format!("no choice {pick}")) };
            if *choice > composer::choices(the_ask).len() {
                return Err(format!("no choice {pick}"));
            }
            let option = if *choice == 0 { OWN_ANSWER } else { *choice as i64 - 1 };
            self.pick_answer(ask - 1, option, window, cx);
        }
        if let Some(value) = cmd["write"].as_str() {
            let Some((n, rest)) = value.split_once(':') else { return Err(format!("no ask in {value}")) };
            let Ok(n) = n.parse::<usize>() else { return Err(format!("no ask in {value}")) };
            if !(1..=card.asks.len()).contains(&n) {
                return Err(format!("no ask in {value}"));
            }
            let ask = n - 1;
            if self.card.picks.get(&(ask as i64)) != Some(&OWN_ANSWER) {
                self.pick_answer(ask, OWN_ANSWER, window, cx);
            }
            self.set_note(ask, rest.to_owned(), cx);
            let input = self.answer_box(ask, window, cx);
            input.update(cx, |s, cx| s.set_value(rest.to_owned(), window, cx));
        }
        if cmd["send"].as_bool().unwrap_or(false) {
            self.send(window, cx);
            return Ok("ok sent".to_owned());
        }
        Ok(format!("ok {}", self.decision_lines(cx).unwrap_or_default().join("\n")))
    }

    /// The Swift automation's `ask`: a card's button by its action
    /// ("pick:0:1", "next:0", "explain:0", "page:1", "collapse", "archive").
    #[cfg(feature = "automation")]
    pub(crate) fn card_action(&mut self, action: &str, window: &mut Window, cx: &mut Context<Self>) -> Result<(), String> {
        let Some(card) = self.open_card(cx) else { return Err("that card is closed".to_owned()) };
        self.sync_card(&card);
        let parts: Vec<&str> = action.split(':').collect();
        match parts.as_slice() {
            ["archive"] => self.archive_thread(window, cx),
            ["collapse"] => self.toggle_collapsed(window, cx),
            ["page", n] => self.set_page(n.parse().map_err(|_| "bad page")?, cx),
            ["next", n] => self.toggle_follow_up(n.parse().map_err(|_| "bad index")?, window, cx),
            ["explain", n] => self.toggle_explain(n.parse().map_err(|_| "bad index")?, window, cx),
            ["link", a, n] => {
                let (a, n): (usize, usize) = (a.parse().map_err(|_| "bad ask")?, n.parse().map_err(|_| "bad link")?);
                let home = std::env::var("HOME").unwrap_or_default();
                let target = card.asks.get(a).and_then(|ask| ask.links.get(n)).and_then(|l| l.target(&home)).ok_or("no link like that")?;
                self.open_ask_link(&target, window, cx);
            }
            ["pick", a, n] => {
                let (a, n): (usize, i64) = (a.parse().map_err(|_| "bad ask")?, n.parse().map_err(|_| "bad choice")?);
                self.pick_answer(a, n, window, cx);
            }
            _ => return Err(format!("unknown card action {action}")),
        }
        Ok(())
    }

    /// The card as text lines, for the dump (composer.card): its heading and
    /// each follow-up or ask with what's picked.
    #[cfg(feature = "automation")]
    pub(crate) fn card_lines(&self, cx: &App) -> Option<Vec<String>> {
        let card = self.open_card(cx)?;
        let mut lines = Vec::new();
        if card.is_done() {
            lines.push("Done".to_owned());
            for (i, next) in card.next.iter().enumerate() {
                let tick = if self.card.next_picks.contains(&(i as i64)) { "[x]" } else { "[ ]" };
                lines.push(format!("{tick} {next}{}", if self.card.explain.contains(&(i as i64)) { " (?)" } else { "" }));
            }
        } else {
            lines.push(if self.card.collapsed { "Needs you (collapsed)".to_owned() } else { "Needs you".to_owned() });
            if is_paged(&card) && !self.card.collapsed {
                lines.push(format!("page {} of {}", self.card.page + 1, card.asks.len()));
            }
            for (i, ask) in card.asks.iter().enumerate() {
                let picked = self.card.picks.get(&(i as i64));
                let mark = if picked.is_some() { "[x]" } else { "[ ]" };
                lines.push(format!("{mark} {}. {}", i + 1, ask.action));
            }
        }
        Some(lines)
    }
}

/// Over this, a card of several asks shows one at a time (ComposerCardHost.
/// pagedOver is 240 pt). The Swift app measures the laid-out text; this
/// estimates it from the same line heights, and the first frame can't be
/// measured any other way.
pub(crate) fn is_paged(card: &AsksCard) -> bool {
    if !card.is_open || card.asks.len() < 2 {
        return false;
    }
    // Characters on a line of the reading column at the body size.
    let width_chars = 95_f32;
    let height: f32 = card
        .asks
        .iter()
        .map(|ask| {
            let lines: f32 = ask_paragraph(ask).split('\n').map(|line| (line.chars().count() as f32 / width_chars).ceil().max(1.)).sum();
            let place = if ask.where_.as_deref().is_some_and(|w| !w.is_empty()) { metrics::ASK_AFTER + metrics::WHERE_LINE } else { 0. };
            let answers = if ask.option_notes.is_empty() { metrics::ASK_AFTER + metrics::BUTTONS_BEFORE + metrics::BUTTON_LINE } else { 38. * (ask.options.len() as f32 + 1.) };
            metrics::ASK_BEFORE + lines * style::size::BODY_LINE + place + answers
        })
        .sum();
    metrics::HEADING + metrics::HEADING_SPACING + height > 240.
}

/// The link an ask's target is handed to the thread's link handling as. A path
/// goes as a `file:` URL made by `file_url`, which escapes what a URL would
/// read (`#`, `%`, `?`, spaces); pasting it after `file://` cut a name at its
/// first `#` (open_gate_source.rs holds that nothing does). Anything else is
/// already a link.
fn ask_link_url(target: &str) -> String {
    if target.starts_with('/') { threadbear_core::open_policy::file_url(target) } else { target.to_owned() }
}

/// An ask's paragraph, as the agent would have written it (Decisions.paragraph):
/// its action, then its why. The number a card of several puts by it is drawn
/// beside it, where a list's number goes, so words that would start a heading,
/// quote or list of their own ("- ", "2. ") are kept as words (askParagraph).
fn ask_paragraph(ask: &Ask) -> String {
    let action: String = ask.action.split('\n').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    let why = ask.why.as_deref().unwrap_or("").trim();
    let body = if why.is_empty() {
        action
    } else {
        let ends = action.chars().rev().find(|c| !"\"'”’)]*_`".contains(*c)).is_some_and(|c| ".?!…:".contains(c));
        format!("{action}{} {why}", if ends { "" } else { "." })
    };
    escape_block_start(&body)
}

/// `text` with what would start a block of its own escaped: a backslash
/// before the marker's punctuation, which for a number is after its digits,
/// as markdown can't escape a digit ("2\. Deploy", not "\2. Deploy").
fn escape_block_start(text: &str) -> String {
    if !starts_a_block(text) {
        return text.to_owned();
    }
    let digits = text.chars().take_while(char::is_ascii_digit).count();
    format!("{}\\{}", &text[..digits], &text[digits..])
}

/// Whether markdown would read `text`'s start as a block of its own: a
/// heading, quote, list item, fence or HTML (askParagraph's pattern).
fn starts_a_block(text: &str) -> bool {
    let hashes = text.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && text[hashes..].starts_with(char::is_whitespace) {
        return true;
    }
    if text.starts_with('>') || text.starts_with("```") || text.starts_with("~~~") || text.starts_with('<') {
        return true;
    }
    let mut chars = text.chars();
    if matches!(chars.next(), Some('-' | '+' | '*')) && chars.next().is_some_and(char::is_whitespace) {
        return true;
    }
    let digits = text.chars().take_while(char::is_ascii_digit).count();
    (1..=9).contains(&digits) && text[digits..].starts_with(['.', ')']) && text[digits + 1..].starts_with(char::is_whitespace)
}

/// The card's measures (RowRenderer.asksText and doneText, which build it as
/// TextKit lines, each a line height with spacing round it).
mod metrics {
    /// A paged card's heading, and the done card's: a button tall.
    pub const PAGED_HEADING: f32 = 38.;
    /// Otherwise the heading is a work line, 6 over the first ask.
    pub const HEADING: f32 = 20.;
    pub const HEADING_SPACING: f32 = 6.;
    /// The chevron (ComposerCardHost.toggleSize).
    pub const TOGGLE: f32 = 22.;
    /// Over an ask's paragraph, and under it and under its where line.
    pub const ASK_BEFORE: f32 = 12.;
    pub const ASK_AFTER: f32 = 2.;
    pub const WHERE_LINE: f32 = 19.;
    /// A line of buttons, 6 under what's over it: rows that wrap keep this apart.
    pub const BUTTON_LINE: f32 = 38.;
    pub const BUTTONS_BEFORE: f32 = 6.;
    /// A button's box (drawButton): the label font's ascender to descender
    /// and 7 over and under it.
    pub const BUTTON_HEIGHT: f32 = 29.3;
    /// Three no-break spaces at 13 pt each side of a button's title, two for
    /// the pager's, and four between buttons.
    pub const BUTTON_PAD: f32 = 10.75;
    pub const PAGER_PAD: f32 = 7.15;
    pub const BUTTON_GAP: f32 = 14.3;
    /// A list's indent, and where its number starts (MarkdownRenderer.listIndent, markerStart).
    pub const INDENT: f32 = 30.;
    pub const NUMBER_AT: f32 = 8.;
    /// A done card's row: its circle in by the hover fill's padding
    /// (rowInset), its words past the circle.
    pub const ROW_INSET: f32 = 8.;
    pub const ROW_WORDS: f32 = 34.;
}

/// A card's title: its mark, then the words in the title font (14 pt medium),
/// three quarters of a point lower than centring puts them, where TextKit's
/// rounded-down baseline offset leaves the Swift card's.
/// `gap` puts the words where the Swift title's space after its symbol does.
fn card_title(mark: AnyElement, gap: f32, words: &'static str, cx: &App) -> impl IntoElement {
    h_flex()
        .flex_none()
        .items_center()
        .gap(px(gap))
        .child(mark)
        .child(div().relative().top(px(0.75)).text_size(px(style::size::CARD_TITLE)).line_height(px(17.)).font_weight(FontWeight::MEDIUM).text_color(style::label_text(cx)).child(words))
}

#[derive(Clone, Copy, PartialEq)]
enum ButtonLook {
    Plain,
    Suggested,
    Picked,
}

/// The soft shadow a card's button sits up on (drawButton).
fn button_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow::new(px(0.), px(1.), hsla(0., 0., 0., 0.25)).blur_radius(px(1.5))]
}

/// The card's button (AskButtonStyle): a rounded box with a soft shadow, the
/// picked one in the accent with white words, the agent's pick with an
/// accent edge, the rest a raised grey.
fn card_button(id: impl Into<ElementId>, title: &str, look: ButtonLook, tip: &'static str, cx: &App) -> Stateful<Div> {
    let (fill, text, edge) = match look {
        ButtonLook::Picked => (style::control_accent(cx), gpui_kit::white(), gpui_kit::transparent_black()),
        ButtonLook::Suggested => (style::button_fill(cx), style::label_text(cx), style::control_accent(cx).opacity(0.8)),
        ButtonLook::Plain => (style::button_fill(cx), style::label_text(cx), style::button_edge(cx)),
    };
    div()
        .id(id.into())
        .flex_none()
        .h(px(metrics::BUTTON_HEIGHT))
        // The edge is inside the box here, where the Swift one is on it.
        .px(px(metrics::BUTTON_PAD - 1.))
        .flex()
        .items_center()
        .rounded(px(7.5))
        .border_1()
        .border_color(edge)
        .bg(fill)
        .shadow(button_shadow())
        .text_color(text)
        .text_size(px(style::size::LABEL))
        .line_height(px(16.))
        .cursor_pointer()
        .hover(|s| s.opacity(0.85))
        .tooltip(move |window, cx| Tooltip::new(tip).build(window, cx))
        .child(title.to_owned())
}

/// ‹ and › on a paged card (asksHeading's arrows): boxed as a plain button
/// while there's a page that way, faint words otherwise, the same width either way.
fn pager_arrow(glyph: &'static str, enabled: bool, tip: &'static str, id: impl Into<ElementId>, cx: &App, on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> impl IntoElement {
    div()
        .id(id.into())
        .flex_none()
        .h(px(metrics::BUTTON_HEIGHT))
        .flex()
        .items_center()
        .rounded(px(7.5))
        .text_size(px(style::size::LABEL))
        .line_height(px(16.))
        .tooltip(move |window, cx| Tooltip::new(tip).build(window, cx))
        .map(|s| {
            if enabled {
                s.px(px(metrics::PAGER_PAD - 1.))
                    .border_1()
                    .border_color(style::button_edge(cx))
                    .bg(style::button_fill(cx))
                    .shadow(button_shadow())
                    .text_color(style::label_text(cx))
                    .cursor_pointer()
                    .hover(|s| s.opacity(0.85))
                    .on_click(on_click)
            } else {
                s.px(px(metrics::PAGER_PAD)).text_color(style::faint_text(cx))
            }
        })
        .child(glyph)
}

fn tick_circle(ticked: bool, cx: &App) -> impl IntoElement {
    let side = px(16.);
    if ticked {
        Icon::from(IconName::CircleCheck).with_size(side).text_color(style::accent(cx)).into_any_element()
    } else {
        div().size(side).rounded_full().border_1().border_color(style::quiet_text(cx)).into_any_element()
    }
}

/// "Or carry on" and the like: small, secondary, on a 19 pt line 10 under
/// what's above, in by the rows' inset.
fn small_label(text: &'static str, cx: &App) -> impl IntoElement {
    div().mt(px(10.)).pl(px(metrics::ROW_INSET)).text_size(px(style::size::SMALL)).line_height(px(metrics::WHERE_LINE)).text_color(style::secondary_label(cx)).child(text)
}

#[cfg(test)]
mod tests {
    // By name: the kit's prelude has a `test` of its own.
    use super::{ask_link_url, ask_paragraph, starts_a_block};
    use threadbear_core::open_policy::{link_kind, LinkKind};
    use threadbear_core::reducer::Ask;

    #[test]
    fn an_asks_file_link_names_the_file_whatever_is_in_its_name() {
        for path in ["/Users/me/notes.md", "/Users/me/Plans #2/a b.md", "/Users/me/100%/a?b.md", "/Users/me/Inspect.app#help/SKILL.md"] {
            let url = ask_link_url(path);
            assert!(url.starts_with("file:///"), "{url}");
            assert!(!url.contains('#') && !url.contains('?') && !url.contains(' '), "{url}");
            assert_eq!(link_kind(&url), LinkKind::File(path.to_owned()), "{path}");
        }
        // A page, or a link of the app's own, is already a link.
        for link in ["https://example.com/a#b", "work:abc", "review:1"] {
            assert_eq!(ask_link_url(link), link);
        }
    }

    #[test]
    fn an_ask_that_reads_as_markdown_structure_stays_words() {
        for (text, escaped) in [("- remove the old key", "\\- remove the old key"), ("2. then this", "2\\. then this"), ("10) or this", "10\\) or this"), ("# not a heading", "\\# not a heading"), ("> quoted", "\\> quoted"), ("<b>", "\\<b>")] {
            assert!(starts_a_block(text), "{text}");
            assert_eq!(ask_paragraph(&Ask::new(text)), escaped);
        }
        for text in ["Accept the new agreement", "2026 was busy", "-1 is fine", "#hashtag", "10.5 points"] {
            assert!(!starts_a_block(text), "{text}");
        }
    }
}
