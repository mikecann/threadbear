// Fast lane icon button beside Send (Option D): icon-only lightning bolt,
// visible when the `fastLane` experiment is on. Off sits quiet beside Send;
// Armed lights up in the accent fill with an outer halo ring and pairs with
// composer border, dimmed coding chips, placeholder, and accent Send cues.
use crate::style;
use crate::style::px;
use crate::tips::Tip as _;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::{h_flex, Icon, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::time::Duration;

/// Experiment id checked against `Threadbear::experiment_on`.
pub(crate) const EXPERIMENT: &str = "fastLane";

/// Composer placeholder while Fast lane is armed for the next turn.
pub(crate) const PLACEHOLDER: &str = "Fast web search...";

/// Filled lightning bolt (256x256 viewBox, tinted via `text_color`).
const BOLT_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="black" d="M215.79,118.17a8,8,0,0,0-5-5.66L153.18,90.9l14.66-73.33a8,8,0,0,0-13.69-7l-112,120a8,8,0,0,0,3,13l57.63,21.61L88.16,238.43a8,8,0,0,0,13.69,7l112-120A8,8,0,0,0,215.79,118.17Z"/></svg>"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ButtonState {
    Off,
    Armed,
    Sending,
}

/// The send button with the icon-only Fast lane bolt directly to its left.
pub(crate) fn beside_send(
    send: AnyElement,
    state: ButtonState,
    on_toggle: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &mut App,
) -> AnyElement {
    let side = px(style::size::SEND_BUTTON);
    let accent = style::accent(cx);
    let bolt_color = match state {
        ButtonState::Off => style::secondary_text(cx),
        ButtonState::Armed | ButtonState::Sending => gpui_kit::white(),
    };
    let bolt = Icon::default()
        .data(BOLT_SVG.as_bytes())
        .with_size(side * 0.54)
        .text_color(bolt_color);

    let (aria, tip) = match state {
        ButtonState::Off => (
            "Fast web search",
            if cfg!(target_os = "macos") {
                "Fast web search (click or Option + Enter)"
            } else {
                "Fast web search (click or Alt + Enter)"
            },
        ),
        ButtonState::Armed => ("Fast web search on", "Fast web search on (click to cancel)"),
        ButtonState::Sending => ("Fast web search running", "Fast web search running"),
    };

    let bg = match state {
        ButtonState::Off => style::primary_opacity(cx, 0.1),
        ButtonState::Armed | ButtonState::Sending => accent,
    };
    let hover_bg = match state {
        ButtonState::Off => style::primary_opacity(cx, 0.16),
        ButtonState::Armed | ButtonState::Sending => accent,
    };

    let circle = div()
        .id("composer-fast-lane")
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(side)
        .rounded_full()
        .bg(bg)
        .when(state != ButtonState::Sending, |d| {
            d.cursor_pointer().hover(move |s| s.bg(hover_bg))
        })
        .child(bolt)
        .test_support()
        .role(Role::Button)
        .aria_label(aria)
        .tip(tip)
        .when(state != ButtonState::Sending, |d| d.on_click(on_toggle));

    // Outer halo ring drawn outside the circle so button spacing never shifts.
    let halo: Option<AnyElement> = match state {
        ButtonState::Off => None,
        ButtonState::Armed => Some(halo_ring(accent.opacity(0.32)).into_any_element()),
        ButtonState::Sending if cx.reduce_motion() => {
            Some(halo_ring(accent.opacity(0.36)).into_any_element())
        }
        ButtonState::Sending => Some(
            halo_ring(accent.opacity(0.24))
                .with_animation(
                    "fast-lane-pulse",
                    Animation::new(Duration::from_millis(1200)).repeat(),
                    move |_, t| {
                        let wave = 0.5 - 0.5 * (t * std::f32::consts::TAU).cos();
                        halo_ring(accent.opacity(0.18 + 0.34 * wave))
                    },
                )
                .into_any_element(),
        ),
    };

    let wrapped = div().relative().flex_none().children(halo).child(circle);
    h_flex()
        .gap(px(6.))
        .items_center()
        .child(wrapped)
        .child(send)
        .into_any_element()
}

fn halo_ring(color: Hsla) -> Div {
    div()
        .absolute()
        .top(px(-3.))
        .right(px(-3.))
        .bottom(px(-3.))
        .left(px(-3.))
        .rounded_full()
        .border(px(2.5))
        .border_color(color)
}
