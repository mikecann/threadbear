//! Quick schedule times and the next known token reset for the composer.
use chrono::{DateTime, TimeZone};
use crate::logins::{Account, RunnerLogins};
use crate::new_thread::{main_windows, pool_logins, tightest, usage_of, PICK_FLOOR};

/// Local calendar dates, rather than adding 24 hours across daylight saving.
pub fn tonight<Tz: TimeZone>(now: &DateTime<Tz>) -> Option<i64> {
    let date = now.date_naive().and_hms_opt(21, 0, 0)?;
    let at = now.timezone().from_local_datetime(&date).earliest()?.timestamp_millis();
    (at > now.timestamp_millis()).then_some(at)
}

pub fn tomorrow<Tz: TimeZone>(now: &DateTime<Tz>) -> Option<i64> {
    let date = now.date_naive().succ_opt()?.and_hms_opt(9, 0, 0)?;
    now.timezone().from_local_datetime(&date).earliest().map(|d| d.timestamp_millis())
}

/// A known reset, not a guess: mirror pools.ts's blocking-window rule and
/// one-minute grace period. With room left, wait for the next used window
/// to refill. Stale readings and elapsed/missing blocking resets cannot
/// promise availability; the regular time picker remains available.
fn account_reset(account: &Account, now_ms: i64) -> Option<i64> {
    if account.usage.as_ref()?["stale"].as_bool() == Some(true) { return None; }
    let usage = usage_of(account)?;
    let main = main_windows(&usage);
    let mut holding: Vec<_> = main.iter().copied().filter(|w| w.remaining_percent < PICK_FLOOR).collect();
    if holding.is_empty() && usage.blocked {
        holding.push(tightest(&usage)?);
    }
    let at = if holding.is_empty() {
        main.iter().filter(|w| w.remaining_percent < 100.)
            .filter_map(|w| w.resets_at.filter(|at| *at > now_ms)).min()?
    } else {
        holding.iter().map(|w| w.resets_at.filter(|at| *at > now_ms))
            .collect::<Option<Vec<_>>>()?.into_iter().max()?
    };
    at.checked_add(60_000)
}

/// Pinned account, or the earliest known replenishment among this pool's
/// logins on the selected provider. Preserve the pool on the schedule so
/// the runner still chooses its login when it runs.
pub fn token_reset(logins: &RunnerLogins, account_id: &str, pool_id: Option<&str>, provider: &str, now_ms: i64) -> Option<i64> {
    if let Some(pool_id) = pool_id {
        let pool = logins.pools.iter().find(|p| p.id == pool_id)?;
        pool_logins(pool, &logins.accounts, Some(provider)).into_iter()
            .filter_map(|a| account_reset(a, now_ms)).min()
    } else {
        account_reset(logins.accounts.iter().find(|a| a.id == account_id)?, now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, TimeZone};
    use serde_json::json;
    use crate::logins::{Account, Pool, RunnerLogins};

    fn account(id: &str, five: f64, week: f64, five_at: Option<i64>, week_at: Option<i64>) -> Account {
        let iso = |at: Option<i64>| at.map(crate::inbox::iso_time);
        Account { id: id.into(), provider: "codex".into(), usage: Some(json!({"windows": [
            {"kind": "five_hour", "remainingPercent": five, "resetsAt": iso(five_at)},
            {"kind": "weekly", "remainingPercent": week, "resetsAt": iso(week_at)}
        ]})), ..Default::default() }
    }
    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn calendar_presets_stay_in_the_future_and_use_local_time() {
        let tz = FixedOffset::west_opt(8 * 3600).unwrap();
        let now = tz.with_ymd_and_hms(2026, 11, 19, 17, 0, 0).unwrap();
        assert_eq!(tonight(&now), Some(tz.with_ymd_and_hms(2026, 11, 19, 21, 0, 0).unwrap().timestamp_millis()));
        assert_eq!(tomorrow(&now), Some(tz.with_ymd_and_hms(2026, 11, 20, 9, 0, 0).unwrap().timestamp_millis()));
        assert_eq!(tonight(&tz.with_ymd_and_hms(2026, 11, 19, 21, 0, 0).unwrap()), None);
    }
    #[test]
    fn reset_waits_for_every_exhausted_window_and_adds_a_minute() {
        let a = account("a", 0., 0., Some(NOW + 3_600_000), Some(NOW + 86_400_000));
        assert_eq!(account_reset(&a, NOW), Some(NOW + 86_460_000));
        let a = account("a", 0., 50., Some(NOW + 3_600_000), Some(NOW + 86_400_000));
        assert_eq!(account_reset(&a, NOW), Some(NOW + 3_660_000));
    }
    #[test]
    fn can_wait_for_more_tokens_before_hitting_the_limit() {
        let a = account("a", 30., 60., Some(NOW + 3_600_000), Some(NOW + 86_400_000));
        assert_eq!(account_reset(&a, NOW), Some(NOW + 3_660_000));
    }
    #[test]
    fn unknown_stale_or_expired_blocking_resets_are_not_guessed() {
        let mut a = account("a", 0., 0., Some(NOW + 3_600_000), None);
        assert_eq!(account_reset(&a, NOW), None);
        a = account("a", 0., 50., Some(NOW - 1), Some(NOW + 86_400_000));
        assert_eq!(account_reset(&a, NOW), None);
        a = account("a", 20., 50., Some(NOW + 3_600_000), Some(NOW + 86_400_000));
        a.usage.as_mut().unwrap()["stale"] = json!(true);
        assert_eq!(account_reset(&a, NOW), None);
        assert_eq!(account_reset(&Account::default(), NOW), None);
    }
    #[test]
    fn provider_block_with_room_uses_the_tightest_window() {
        let mut a = account("a", 30., 2., Some(NOW + 3_600_000), Some(NOW + 86_400_000));
        a.usage.as_mut().unwrap()["blocked"] = json!(true);
        assert_eq!(account_reset(&a, NOW), Some(NOW + 86_460_000));
    }
    #[test]
    fn pool_uses_earliest_member_with_room_after_reset_on_the_same_provider() {
        let a = account("a", 0., 0., Some(NOW + 1_000_000), Some(NOW + 8_000_000));
        let b = account("b", 0., 50., Some(NOW + 4_000_000), None);
        let mut c = account("c", 0., 50., Some(NOW + 2_000_000), None);
        c.provider = "claude".into();
        let logins = RunnerLogins { accounts: vec![a,b,c], pools: vec![Pool {id:"p".into(), account_ids: vec!["a".into(),"b".into(),"c".into()], ..Default::default()}], ..Default::default() };
        assert_eq!(token_reset(&logins, "a", Some("p"), "codex", NOW), Some(NOW + 4_060_000));
        assert_eq!(token_reset(&logins, "a", None, "codex", NOW), Some(NOW + 8_060_000));
        assert_eq!(token_reset(&logins, "a", Some("missing"), "codex", NOW), None);
    }
}
