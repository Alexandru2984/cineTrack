# Community moderation runbook

This queue contains private report details and server-captured evidence. Access
is limited to explicitly assigned accounts with a verified email address and
two-factor authentication. Do not copy evidence into tickets, chat, or personal
notes unless a legal or safety escalation requires it.

## Access

Enable 2FA and verify the moderator account first, then grant the database-backed
role from the repository root:

```bash
scripts/manage_moderator.sh grant <username> .env.prod
```

The role is checked in PostgreSQL on every moderation request, so revocation is
immediate even while an access token remains valid:

```bash
scripts/manage_moderator.sh revoke <username> .env.prod
```

Re-run `scripts/provision_db_role.sh .env.prod` after production migrations.
The backend refuses to start if its runtime role can assign moderators or
rewrite the moderation audit log.

## Triage order and response targets

1. `child_safety`: open immediately. Preserve the report; do not download or
   redistribute suspected illegal material. If the snapshot indicates imminent
   danger, contact the appropriate emergency or child-protection authority.
2. `threatening`: open immediately and assess specificity, target, means, and
   timing. Escalate credible imminent danger to emergency services.
3. privacy, sexual exploitation, hate, harassment, impersonation, and scams:
   review the same day.
4. copyright and other reports: review within two business days.

The application deliberately does not offer one-click account deletion or
suspension from the queue. A compromised or mistaken moderator session can
classify a report, but cannot irreversibly punish an account.

## Workflow

- `Open` means nobody has claimed the report.
- Move it to `Reviewing` with a short note describing the first check.
- Compare the server snapshot, report context, relevant Community Guideline,
  and any related reports. Do not rely on the reporter's wording alone.
- Use `Actioned` only after the separately authorized action is complete.
  Record exactly what was done and why.
- Use `Dismissed` when the evidence does not establish a violation. Record the
  reason so an appeal can be reviewed consistently.
- Final states cannot be reopened through the API. If a final decision was
  wrong, preserve it and create a documented corrective case instead of
  rewriting history.

Every transition requires a 3–2000 character note and is written to an
append-only audit table. Never put passwords, tokens, unrelated personal data,
or speculative diagnoses in a moderator note.

## Alerts and incident handling

- `CineTrackChildSafetyReportReceived` and
  `CineTrackThreatReportReceived` require prompt human review.
- `CineTrackSafetyReportSpike` may mean a real coordinated incident or report
  abuse. Check unique reporters and targets in PostgreSQL without exporting the
  free-form details.
- `CineTrackModerationQueueGrowing` and
  `CineTrackModerationReportStale` indicate that the response target was missed.
- Correlate actions using report UUID, moderator UUID, request ID, and the
  `audit: moderation report status changed` log line. Prometheus labels never
  contain those identifiers.

For a compromised moderator account, revoke the moderator role first, then
revoke all account sessions and follow `docs/incident-response.md`. Do not
delete the audit trail.

## Retention and access requests

Open reports remain until resolved. Resolved reports, evidence snapshots, and
moderation decisions are retained for up to 730 days for safety,
accountability, appeals, and legal claims. Account deletion detaches reporter,
subject, or moderator identifiers where possible but does not erase active
safety evidence. The scheduled retention worker removes eligible closed cases
through a restricted database-owner function.
