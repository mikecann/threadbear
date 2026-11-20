// The Send arrow and right-click menu offer quick one-off schedule times.
// Schedule… opens the full editor, as "+" > Schedule… does.
// Not on another Mac's thread, or a new one for another Mac: their schedules
// are made from there.
use crate::composer::Composer;
use crate::a11y::A11yRole as _;
use crate::tips::Tip as _;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{ContextMenuExt as _, DropdownMenu as _, PopupMenu, PopupMenuItem};
use gpui_kit::component::{h_flex, Sizable as _};
use gpui_kit::assets::IconName;
use gpui_kit::prelude::*;
use gpui_kit::*;
use threadbear_core::chrono::Local;
use threadbear_core::{send_later, schedules};

pub(crate) const SCHEDULE_TITLE: &str = "Schedule…";

#[cfg(feature = "automation")]
const SEND_BUTTON_NAMES: [&str; 4] = ["Send", "Stop", "Stopping", "Starting the thread"];

#[derive(Clone, Copy)]
enum Preset { Tonight, Tomorrow, Tokens }

fn preset_time(composer: &Composer, preset: Preset, cx: &App) -> Option<i64> {
    let now = Local::now();
    match preset {
        Preset::Tonight => send_later::tonight(&now),
        Preset::Tomorrow => send_later::tomorrow(&now),
        Preset::Tokens => {
            let data = composer.chip_data(cx);
            let summary = data.summary.as_ref()?;
            send_later::token_reset(&data.logins, &summary.account_id, summary.pool_id.as_deref(), &summary.provider, now.timestamp_millis())
        }
    }
}

fn send_menu(mut menu: PopupMenu, composer: WeakEntity<Composer>, cx: &mut App) -> PopupMenu {
    let Some(c) = composer.upgrade() else { return menu };
    for (preset, title) in [(Preset::Tonight, "Send tonight at 9 pm…"), (Preset::Tomorrow, "Send tomorrow at 9 am…"), (Preset::Tokens, "Send when tokens reset…")] {
        let at = preset_time(c.read(cx), preset, cx);
        // After 9 pm, don't call tomorrow night "tonight".
        if matches!(preset, Preset::Tonight) && at.is_none() { continue; }
        let title = if matches!(preset, Preset::Tokens) {
            match at {
                Some(at) => format!("Send when tokens reset ({})…", schedules::full_time(at, &Local)),
                None => "Send when tokens reset (time unavailable)".into(),
            }
        } else { title.to_owned() };
        let composer = composer.clone();
        menu = menu.item(PopupMenuItem::new(title).disabled(at.is_none()).icon(crate::icons::symbol("clock")).on_click(move |_, window, cx| {
            let Some(c) = composer.upgrade() else { return };
            // Re-read the time and selected login when chosen: a menu can
            // stay open past a reset or midnight.
            let Some(at) = preset_time(c.read(cx), preset, cx) else { return };
            let Some(app) = c.read(cx).app.upgrade() else { return };
            app.update(cx, |app, cx| app.new_schedule_from_composer_at(&c, Some(at), window, cx));
        }));
    }
    menu.separator().item(PopupMenuItem::new(SCHEDULE_TITLE).icon(crate::icons::symbol("clock")).on_click(move |_, window, cx| {
        let Some(c) = composer.upgrade() else { return };
        let Some(app) = c.read(cx).app.upgrade() else { return };
        app.update(cx, |app, cx| app.new_schedule_from_composer(&c, window, cx));
    }))
}

impl Composer {
    pub(crate) fn schedules_from_send(&self, cx: &App) -> bool {
        self.chip_data(cx).away.is_none() && self.app.upgrade().is_some_and(|a| a.read(cx).schedules_supported)
    }

    /// The visible arrow and Send's right-click share one menu. Presets
    /// open the existing editor, preserving its attachment warning, errors,
    /// draft handling and the chance to check the exact time before saving.
    pub(crate) fn with_send_menu(&self, button: AnyElement, cx: &mut Context<Self>) -> AnyElement {
        if !self.schedules_from_send(cx) { return button; }
        let composer = cx.entity().downgrade();
        let dropdown_composer = composer.clone();
        let dropdown = Button::new("composer-send-later")
            .icon(IconName::ChevronDown).small().ghost()
            .dropdown_menu(move |menu, _, cx| send_menu(menu, dropdown_composer.clone(), cx));
        h_flex().flex_none()
            .child(div().id("composer-send-menu").flex_none().child(button)
                .context_menu(move |menu, _, cx| send_menu(menu, composer.clone(), cx)))
            .child(div().id("composer-send-later-control").test_support()
                .a11y_role(Role::GenericContainer).aria_label("Send later")
                .child(dropdown).tip("Send later: tonight, tomorrow or when tokens reset"))
            .into_any_element()
    }
}

/// The automation's `composer-menu` for `send` (both apps): a right-click on
/// the send button through real events and hit testing, then, once the kit
/// has built the menu, its items read back, or one of them pressed with
/// `click`. A command's turn each, as each waits on the one before to be drawn.
#[cfg(feature = "automation")]
pub(crate) async fn menu_command(window: AnyWindowHandle, cmd: &serde_json::Value, cx: &mut AsyncApp) -> Result<serde_json::Value, String> {
    use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
    use serde_json::json;
    let pressed = cx
        .update_window(window, |_, window, cx| {
            crate::thread::scripted_input(|| {
                window.render_frame(cx);
                // The send button, Stop or the spinner: whichever is showing,
                // by the name each has for VoiceOver.
                let found = window.elements().into_iter().find(|e| e.visible() && e.label().is_some_and(|l| SEND_BUTTON_NAMES.contains(&l)));
                let Some(button) = found else { return Err("no send button on screen".to_owned()) };
                let at = button.visible_bounds().center();
                window.pointer_move(at, None, cx);
                window.pointer_down(at, MouseButton::Right, cx);
                window.pointer_up(at, MouseButton::Right, cx);
                Ok(())
            })
        })
        .map_err(|e| e.to_string())??;
    let () = pressed;
    cx.background_executor().timer(std::time::Duration::from_millis(150)).await;
    let items = cx
        .update_window(window, |_, window, cx| {
            window.render_frame(cx);
            crate::reply_links::open_menu_items(window, 0)
        })
        .map_err(|e| e.to_string())?;
    if let Some(title) = cmd["click"].as_str() {
        let Some((_, item)) = items.iter().find(|(t, _)| t == title) else { return Err(format!("no item {title} in {items:?}")) };
        let at = item.center();
        cx.update_window(window, |_, window, cx| {
            crate::thread::scripted_input(|| {
                window.pointer_move(at, None, cx);
                window.pointer_down(at, MouseButton::Left, cx);
                window.pointer_up(at, MouseButton::Left, cx);
            })
        })
        .map_err(|e| e.to_string())?;
        return Ok(json!("ok"));
    }
    let titles: Vec<&str> = items.iter().map(|(t, _)| t.as_str()).collect();
    // Left up for a picture with `keep: true`; put away otherwise.
    if !titles.is_empty() && cmd["keep"].as_bool() != Some(true) {
        cx.update_window(window, |_, window, cx| window.press("escape", cx)).map_err(|e| e.to_string())?;
    }
    Ok(json!(format!("ok {}", serde_json::to_string(&titles).unwrap_or_default())))
}
