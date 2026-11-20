// The Connectors panel's Create Slack app and paste form: what the runner's
// `clientSetup` decodes to, and what the form lets through.
use serde_json::json;
use threadbear_core::connectors::{self as rules, paste_check, ConnectorsStatus};

fn status() -> ConnectorsStatus {
    ConnectorsStatus::decode(&json!({
        "state": "ok",
        "url": "http://127.0.0.1:8795",
        "services": [
            { "id": "slack", "title": "Slack", "state": "signed_out", "connectUrl": "http://127.0.0.1:8795/admin/connect/slack",
              "clientSetup": { "createUrl": "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D", "redirectUrl": "http://127.0.0.1:8795/oauth/callback", "help": "Pick your workspace." } },
            { "id": "notion", "title": "Notion", "state": "signed_out", "connectUrl": "http://127.0.0.1:8795/admin/connect/notion" },
            { "id": "odd", "title": "Odd", "state": "signed_out", "connectUrl": "http://127.0.0.1:8795/admin/connect/odd", "clientSetup": { "createUrl": "javascript:alert(1)" } }
        ]
    }))
}

#[test]
fn a_service_without_its_app_gets_create_not_connect() {
    let s = status();
    let slack = &s.services[0];
    let setup = slack.client_setup.as_ref().unwrap();
    assert!(setup
        .create_url
        .starts_with("https://api.slack.com/apps?new_app=1"));
    assert_eq!(setup.redirect_url, "http://127.0.0.1:8795/oauth/callback");
    assert_eq!(rules::button_title(slack), None);
    assert_eq!(rules::create_app_title(&slack.title), "Create Slack app");
    assert_eq!(rules::button_title(&s.services[1]), Some("Connect"));
    // Only an https link becomes a button.
    assert_eq!(s.services[2].client_setup, None);
    assert_eq!(rules::button_title(&s.services[2]), Some("Connect"));
}

#[test]
fn the_paste_form_saves_odd_looking_keys_with_a_warning() {
    let good = paste_check(
        "slack",
        " 3769284211.12664135813042 ",
        "0123456789abcdef0123456789abcdef",
    );
    assert!(good.can_save);
    assert_eq!(good.warning, None);
    assert!(!paste_check("slack", "", "x").can_save);
    assert!(!paste_check("slack", "1.2", "").can_save);
    let spaced = paste_check("slack", "1.2", "abc def");
    assert!(!spaced.can_save);
    assert!(spaced.warning.unwrap().contains("space"));
    let id = paste_check("slack", "A0123", "0123456789abcdef0123456789abcdef");
    assert!(id.can_save);
    assert!(id.warning.unwrap().contains("Client ID"));
    let secret = paste_check("slack", "1.2", "short");
    assert!(secret.can_save);
    assert!(secret.warning.unwrap().contains("Signing Secret"));
    assert_eq!(paste_check("other", "abc", "whatever").warning, None);
}
