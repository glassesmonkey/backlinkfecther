# Contracts And Examples

用这份文档快速建立最小数据契约。字段可以扩展，但不要破坏语义边界。

## Run Manifest

```json
{
  "run_id": "20260330T165926-example-run",
  "promoted_url": "https://example.com",
  "status": "READY",
  "intake": {
    "required_missing": []
  },
  "reporting": {
    "enabled": true,
    "interval_minutes": 30
  },
  "watchdog": {
    "enabled": true
  },
  "preflight": {
    "browser_executor": "playwright",
    "browser_fallback_tool": "browser-use-cli",
    "ready_for_real_submit": true,
    "gog_available": true
  },
  "takeover_policy": {
    "enabled": true,
    "max_minutes_per_takeover": 8,
    "max_actions_per_takeover": 40,
    "max_takeovers_per_task": 2
  },
  "paths": {
    "task_store_path": "data/tasks/store.json",
    "profile_path": "data/profiles/example.json",
    "artifacts_dir": "data/artifacts"
  }
}
```

## Task Record

```json
{
  "task_id": "task-0042",
  "normalized_url": "https://target-site.com/submit",
  "domain": "target-site.com",
  "status": "READY",
  "phase": "imported",
  "attempts": 0,
  "auth_type": "unknown",
  "anti_bot": "unknown",
  "route": "",
  "execution_mode": "",
  "automation_disposition": "",
  "escalation_level": "scout_only",
  "takeover_attempts": 0,
  "last_takeover_at": "",
  "last_takeover_outcome": "",
  "playbook_id": "",
  "trajectory_playbook_ref": "",
  "account_ref": "",
  "locked_by": "",
  "lock_expires_at": "",
  "terminal_class": "",
  "skip_reason_code": "",
  "wait_reason_code": "",
  "resume_trigger": "",
  "resolution_owner": "",
  "resolution_mode": "",
  "evidence_ref": "",
  "notes": []
}
```

## Promoted-Site Profile

```json
{
  "canonical_url": "https://example.com",
  "product_name": "Example",
  "one_liner": "AI helper for backlink operations",
  "short_description": "Help teams manage backlink submissions with long-term memory.",
  "medium_description": "A task-first backlink submission system with memory, recovery, and observability.",
  "category": "Marketing",
  "tags": ["seo", "automation", "backlinks"],
  "use_cases": ["directory submission", "tracking listing status"],
  "pricing_url": "https://example.com/pricing",
  "privacy_url": "https://example.com/privacy",
  "contact_email": "team@example.com",
  "disclosure_boundaries": {
    "allow_founder_name": false,
    "allow_phone": false,
    "allow_address": false
  }
}
```

## Site Playbook

```json
{
  "site_key": "target-site.com",
  "capture_source": "agent_live_takeover",
  "entry_url": "https://target-site.com/submit",
  "auth_route": "email_signup",
  "surface_signature": {
    "entry_path": "/submit",
    "has_iframe": true,
    "visible_cta": "Submit your product"
  },
  "preconditions": [
    "login not required",
    "submission form reachable from entry CTA"
  ],
  "steps": [
    {
      "action": "click",
      "anchor": {
        "text": "Submit your product"
      }
    },
    {
      "action": "switch_frame",
      "anchor": {
        "frame_hint": "Tally form iframe"
      }
    },
    {
      "action": "fill",
      "anchor": {
        "label": "Website URL"
      },
      "value_source": "promoted_site_profile.canonical_url"
    }
  ],
  "anchors": {
    "primary_cta_text": "Submit your product",
    "form_provider": "Tally"
  },
  "postconditions": [
    "success banner visible"
  ],
  "success_signals": ["Thanks for submitting"],
  "failure_signals": ["Managed challenge"],
  "anti_bot_observation": "none",
  "replay_confidence": "medium"
}
```

## Account Registry Record

```json
{
  "domain": "target-site.com",
  "account_ref": "acct-target-site-01",
  "signup_email": "submissions@example.com",
  "auth_type": "email_signup",
  "browser_profile_ref": "chrome-profile-target-site",
  "mailbox_ref": "mailbox-submissions",
  "status": "active"
}
```

## Submission Ledger Record

```json
{
  "promoted_url": "https://example.com",
  "target_domain": "target-site.com",
  "target_normalized_url": "https://target-site.com/submit",
  "state": "submitted",
  "run_id": "20260330T165926-example-run",
  "task_id": "task-0042",
  "listing_url": "https://target-site.com/listings/example"
}
```

## Page-Understanding Decision

```json
{
  "page_kind": "submit-entry-with-iframe",
  "recommended_path": "open_iframe_and_fill_submit_form",
  "candidate_actions": [
    {
      "action": "click",
      "target_text": "Submit your product"
    },
    {
      "action": "switch_frame",
      "frame_hint": "Tally form iframe"
    }
  ],
  "terminal_reason": "",
  "evidence": {
    "main_surface": "landing page with multiple CTA buttons",
    "iframe_detected": true,
    "expected_next_state": "visible submission form"
  }
}
```

## Live Takeover Trajectory Summary

```json
{
  "task_id": "task-0042",
  "outcome": "waiting_external_event",
  "terminal_class": "email_verification",
  "budget_used": {
    "minutes": 3,
    "actions": 18
  },
  "observed_obstacles": ["confirmation email required"],
  "playbook_candidate": "playbooks/sites/target-site.com.json",
  "next_status_recommendation": "WAITING_EXTERNAL_EVENT",
  "wait_reason_code": "EMAIL_VERIFICATION_PENDING",
  "resume_trigger": "gog.email_link_received",
  "resolution_owner": "gog",
  "resolution_mode": "auto_resume",
  "evidence_ref": "artifacts/task-0042-live-takeover.json"
}
```

## Usage Rule

- 扩展字段时，保持现有语义稳定。
- 不要把不同层级的数据混进同一个记录。
- 不要让自然语言 `notes` 成为唯一真相源。
