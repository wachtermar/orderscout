# Changelog

This project follows Semantic Versioning. It is currently pre-1.0; command and normalized response changes may occur between minor releases and will be listed here.

## 0.3.4 - 2026-07-19

- Added official group-basket handoff so API-created baskets can be restored in the user's normal browser.
- Added `justeat order open` and the `justeat_open_basket` ChatGPT Work tool.
- Replaced the misleading merchant-page-only browser checkout behavior with a validated restorable basket URL.

## 0.3.3 - 2026-07-19

- Replaced Playwright login with one-call native system-browser OAuth and automatic callback detection.
- Avoids identity-provider “unsafe browser” failures while keeping ChatGPT Work authentication terminal-free.

## 0.3.2 - 2026-07-19

- Ordercli-style visible managed-browser authentication for ChatGPT Work.
- Persistent dedicated Chrome profile for user-completed Turnstile and login.
- Automatic OAuth callback observation and PKCE exchange in one MCP tool call.
- No Terminal, “done” message, browser-history access, or callback copying.

## 0.3.1 - 2026-07-19

- ChatGPT Work authentication now runs through MCP tools without Terminal.
- Native-browser OAuth handles Just Eat Turnstile and automatically captures the official callback on macOS.
- Split email-code OAuth remains available to CLI integrations when Just Eat permits that flow.

## 0.3.0 - 2026-07-19

- ChatGPT Work and Codex plugin with a bundled ordering skill.
- Dependency-free MCP stdio server with typed discovery, recommendation, basket, checkout, and placement tools.
- Accurate MCP safety annotations and an explicit destructive final-purchase tool.
- Repository-local plugin marketplace for desktop installation and sharing.

## 0.2.0 - 2026-07-19

- Natural-language water and meal recommendations with transparent scoring.
- Metric pack normalization, dietary filters, budgets, availability, and modifier validation.
- Private local order plans and preview-first basket creation.
- Validated delivery/service/bag fees, minimum-order constraints, and multi-store comparisons.
- Account-backed checkout detail patches and scheduled/as-soon-as-possible fulfilment.
- Final payment request protected by current-quote fingerprint and environment gate.
- Normal checkout output excludes raw personal checkout data unless `--raw` is explicit.

## 0.1.0 - 2026-07-19

- Address autocomplete and restaurant discovery for Just Eat Spain.
- Normalized static menu retrieval and item search.
- Official OAuth authorization-code login with PKCE through the system browser.
- Saved-address lookup and authenticated account reads.
- Browser-only checkout handoff; no basket, payment, or order mutation.
- Agent context, doctor diagnostics, compact JSON, field selection, stable errors, and documented exit codes.
