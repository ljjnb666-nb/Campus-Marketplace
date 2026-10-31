# Production audit remediation — 2026-10-25

最终收尾日期：2026-10-26（Asia/Shanghai）。

**当前结论：代码层面已修复本次审计的 F01–F14，并补齐账号会话撤销、邮箱验证、密码恢复和特权 MFA；仍不能宣布正式上线或成熟交易网站。** 现阶段定位为待生产验收的校园线下撮合产品。没有微信/支付宝不妨碍设计为线下撮合，但页面和数据必须如实表达“未核实线下结算”；支付、托管、自动退款和对账尚未实现。

服务器尚未准备好，因此公网部署、真实邮件和告警送达、异地恢复、容量与值班验收仍是外部阻塞项。本地通过的测试与镜像演练不会替代这些验收。以下逐项列出修复和可复核证据。

## Scope and release decision

The user requested remote synchronization followed by fixes to the findings in
`2026-10-20-production-readiness-deep-audit.md`. The primary checkout was fast-forwarded
to `origin/master` at `0f7e51aa54fd57441f59d90db632cb96a47b44f4`, then switched to
`codex/production-audit-remediation`. Existing untracked audit evidence and unrelated
worktrees were preserved. This document describes the remediation working tree;
the older master CI run is not evidence for these changes.

**Production launch remains unapproved.** The user confirmed that no deployment
server is ready. Local test results cannot establish public TLS, delivered alerts,
offsite recovery, production capacity, operational ownership or required business
approvals. ADR 0002's non-payment launch target and the existing roadmap gates remain
in force. No payment gateway, automatic refund, escrow or settlement is implemented.

## Findings addressed in code

| Finding | Change | Verification boundary |
| --- | --- | --- |
| F01 stale rental approval/rejection | Lock the rental order before checking its current state; cancellation/dispute races converge on current authority | Actual PostgreSQL blockers and competing transactions |
| F02 shared rental evidence | Participant-owned evidence; legacy evidence is labelled as unattributed rather than assigned retrospectively | Domain/UI tests and upgrade fixtures; legacy follow-up preservation is included in the final migration |
| F03 incomplete return form | Explicit damage, cleanliness and accessory inputs; participant-specific submission permissions | Rendered form submission and domain validation |
| F04 upload admission | Shared batch validation and service-level upload limits apply to API and Server Actions before side effects | Over-count/byte-limit tests and admission tests |
| F05 migrator SHA | Export the selected immutable release identity to migration commands | Deploy script regression |
| F06 rollback worker identity | Missing cleanup-worker images fail closed instead of being treated as an older deployment topology | Rollback script regression |
| F07 chat pagination | Real load-more request, validated conversation-bound keyset cursor, correct next cursor and deduplication | UI/API tests and 105 equal-timestamp messages in PostgreSQL |
| F08 multiple pending claims | Locked state transitions and a partial unique index; preserve unresolved historical intent without inventing responses | Concurrent domain tests and migration fixtures |
| F09 upload after erasure | USER lock, fresh pre-upload and post-upload lifecycle checks, deletion queue and filename redaction | Three real PostgreSQL upload/erasure interleavings |
| F10 login abuse | Source budget plus account/source budget; successful login cannot reset the source budget | Limiter regressions |
| F11 mixed worker versions | Quiesce and verify old workers before rollout | Deploy failure and rollback scenarios |
| F12 message history hydration | Database latest-message lookup via indexed lateral joins; aggregate unread conversation count | Repository and actual PostgreSQL tests |
| F13 mobile message navigation | Preserve explicit list state instead of automatically selecting the first conversation | Page/layout regressions and browser acceptance |
| F14 mutable release identity | Root-owned image metadata read by entrypoints; reject missing metadata and ignore spoofed environment identity | Actual container probes and release-health verification |

General order cancellation, rental extensions/claims and service booking now describe
offline settlement honestly. Service orders preserve the pricing unit at creation;
their displayed amount is a reference quotation, not a verified amount paid or a
duration/quantity-adjusted final total. Older service orders have no fabricated unit
snapshot.

## Account lifecycle authority

`AccountSession` is the revocation authority for JWT-backed sessions. Login creates it
under the same USER lock that validates current password hash, email and lifecycle.
Old JWTs without a session id fail closed. Password change/reset revokes all prior
sessions; logout and selective/other/all-device revocation use owner-bound records.
The existing governance audit and Phase 9 notification service remain the only audit
and notification writers.

Email verification and password recovery use a random challenge id plus a
purpose-separated HMAC bearer token. The database stores only the token digest and
a binding to the current email and password hash. A USER-locked fresh check enforces
expiry and single consumption. Repeated requests do not invalidate a still-live link.
Notification payloads contain only challenge identity/purpose; the delivery renderer
derives the token. Tokens travel in the email link fragment and are removed from
browser history when the confirmation page loads. GET alone cannot consume a link.
Source and address budgets constrain recovery requests; responses do not state
whether an account exists.

TOTP secrets are encrypted with AES-GCM and bound to the user identity. Pending
enrollment is bound to the password-proved session and expires. The USER lock and a
monotonic accepted counter prevent replay, including concurrent login attempts.
Effective RBAC permissions determine which accounts require a recent second factor;
the legacy display role does not. Privacy, legal re-consent and the dedicated identity
recovery surfaces retain explicit access paths. New credential fields and challenge
rows are excluded from self-export and cleared/deleted during erasure.

Implementation references: [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238) and
[OWASP password recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
Cryptographic behavior is checked against published RFC vectors, not only the
implementation's own output.

### Operational implications

- All previously issued sessions must log in again after this release. Existing
  email addresses remain unverified until ownership is actually confirmed.
- Configure and verify the existing transactional email provider before opening
  registration/marketplace access. Development `disabled` delivery is not evidence
  of a working mailbox flow.
- Preserve the production `NEXTAUTH_SECRET` securely with recovery material: it
  currently derives both challenge and MFA encryption keys. Blind rotation would
  invalidate recovery links and make existing encrypted TOTP keys unreadable.
  Rotation and lost-authenticator recovery require a reviewed operator procedure;
  never publish keys, put them in audit logs, or use a universal recovery code.
- Database backup restoration can resurrect session/recovery state from the backup
  timestamp. Before reopening traffic, revoke restored sessions and outstanding
  challenges as part of the incident recovery procedure.

## Dependency and runtime changes

Compatible transitive patches and Vitest 4.1.12 replace the affected test runner
chain. Scoped overrides update `deepmerge-ts` under Prisma configuration and
`hyperid` under autocannon without replacing Prisma 6.19.3. Prisma generation and
migration deployment have been exercised; a real local HTTP autocannon smoke
completed three requests with zero errors. The cross-platform lockfile was generated
with Linux Node 24/npm 11.17.0. Use npm 11.17 or later in the 11.x line when installing
this lockfile; older local npm 11.6 produced a false missing-optional-package error.

Build tooling remains outside the persistent worker runtime. Worker bundles use a
generated dependency manifest based on esbuild's external imports, with versions
resolved from the committed lock. Container evidence must distinguish the installed
runtime tree from unused records retained in a lockfile.

The October 25 refresh found advisories affecting Zod and fast-uri. The lock now
uses Zod 4.6.7 and fast-uri 3.1.9; the manifest raises Zod's minimum to 4.6.7.
Both `npm audit --omit=dev --json` and `npm audit --json` then reported zero
advisories. This supersedes earlier snapshots, including the earlier `braces`
report; advisory databases change and this is not a permanent safety guarantee.
Upstream references: [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
and [fast-uri advisory](https://github.com/advisories/GHSA-w74x-v6f9-j3xg).

Historical migration regressions now include the repository's 12-digit migration
directories, retain per-migration commit boundaries for PostgreSQL enum additions,
and write only historical columns when constructing pre-upgrade fixtures. The
shared Prisma CLI test helper explicitly supplies the schema for `db execute`.
These changes restore the intended migration proof rather than skipping old data.

## Verification status

Raw local evidence is under `.tmp-scratch/` and is not part of the production image.
Interrupted runs without a final result do not count as passed.

| Gate | Result | Evidence |
| --- | --- | --- |
| Complete Vitest suite with real isolated PostgreSQL/Redis/MinIO | 4,854 passed, 0 failed, 9 platform skips | `remediation-coverage.json`, `remediation-coverage.log` |
| Coverage | Statements 87.76%, branches 80.31%, functions 86.91%, lines 88.54%; all configured 80% gates passed | `remediation-coverage.log` |
| Type checking | Passed | `remediation-typecheck.log` |
| Complete production-build browser suite, 2026-10-26 | 109 passed, 0 failed (5 authentication setup + 103 main + 1 final policy-upgrade test) | `remediation-e2e-full-pass.log` |
| ESLint | 0 errors, 64 warnings; warnings remain | `remediation-lint.log` |
| Production build / Docker app build | Passed | `remediation-build.log`, `ops-docker-app-final-build.log` |
| Dependency advisory scan, production and complete tree | 0 advisories at this check | `remediation-audit-prod.json`, `remediation-audit-all.json` |
| Deployment failure-path regression | 109 passed, 0 failed | `remediation-deploy-gate-final.log` |
| Rollback regression | 135 passed, 0 failed | `remediation-rollback-gate.log` |
| Backup status artifacts and failure propagation | 24 passed, 0 failed | `remediation-backup-status-gate.log` |
| Restore / offsite-drill script regression | 6 / 4 passed, 0 failed | `remediation-restore-gate.log`, `remediation-offsite-gate.log` |
| Actual isolated Docker images | 12 passed, 0 failed, including internal-network migration and real worker cycles | `remediation-image-runtime-final.log` |
| Linux POSIX shutdown / lease recovery | 2 passed, 0 failed, using a separate PostgreSQL database | `remediation-posix-shutdown.log` |
| Final evidence gate / alert transport focused regression | 12 passed, 0 failed, including two added real-email requirements | `remediation-tests-focused.log` |

The full Vitest/coverage snapshot precedes the final two added evidence-gate tests;
the 12-test focused rerun covers that final script change. These counts are separate,
not additive. Final type checking and focused lint also passed after those edits.

Browser acceptance used installed Google Chrome with Playwright because the bundled
Chromium download repeatedly failed. The final complete run enabled traces and used
one worker against a fresh isolated `campus_e2e` database. It includes the real
390x844 chat list/back navigation and all five history-page requests across 105
equal-timestamp fixture messages. Screenshots were visually inspected. Earlier
incomplete runs and browser `newPage` timeouts are not counted as passes; the final
109-test run supersedes them. The test database serves as a synthetic mailbox for
account proofs; this does not establish production email delivery.

The nine Windows skips include two POSIX shutdown tests, which were separately
executed successfully in Linux. Shell deployment, rollback and restore checks above
are separate executions; the Windows suite itself still reports nine skips.
Image probes use synthetic credentials and the base SHA as proof metadata. They
validate the current working-tree image behavior, not an immutable committed
remediation release or exact-head CI. There is no public production verification.

### Defects found by acceptance testing

- Optional MFA input must serialize as an empty string for ordinary login;
  NextAuth otherwise serializes `undefined` into an invalid credential string.
- Opening another recovery fragment on the same confirmation page must clear the
  previous submission state. Hash changes now remount the proof form and remove
  the token from history; single-use replay remains rejected.
- The migrator must generate its Prisma engine on its own OpenSSL platform during
  image build. Otherwise an isolated production network attempts a runtime engine
  download. The final image migrates without external network access.

### Outstanding production acceptance

The project is a locally exercised, non-payment marketplace candidate. It is not
yet a proven mature production trading service. Before public launch, provide and
verify the real server/domain/TLS, production email delivery, alert delivery and
response ownership, offsite database plus object-storage restoration, capacity
targets under realistic load, operator recovery procedures and required business
approvals. Payment collection, reconciliation, escrow, refunds and settlement need
a separately designed and accepted provider integration if offered to users.
The release evidence template now explicitly requires real transactional email
delivery, since verification and recovery depend on it. Synthetic browser mailbox
fixtures cannot satisfy that field.
