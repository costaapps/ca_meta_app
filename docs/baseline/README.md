# Offline source-route trace

This harness checks the current route and function inventory against versioned source using synthetic inputs. It is not an integration test.

## Requirements

- Python 3.10 or later with the standard library only. No `requirements.txt`, Docker, database, PHP runtime, credentials, or network access are required for this harness.
- Run from the repository root (host used for M1.01: Windows 10 x64; Python 3.13.7).

## Run

```powershell
python -m py_compile tools/baseline/trace_versioned_routes.py
python tools/baseline/trace_versioned_routes.py
```

Expected output ends with `PASS: source inventory and synthetic route trace are consistent.` The summary includes every declared PHP function in the four versioned PHP source files, all 8 GET/POST WhatsApp router selectors, the 1 OPTIONS preflight branch (9 router branches total), every Angular route declaration, and each synthetic case. The fixture also verifies that OPTIONS reaches the source preflight branch and receives status 200. The expected direct `connect_whatsapp.php` URL is deliberately recorded as no matching selector in the current PHP router; the code's unmatched branch returns 404 if that unchanged path reaches it.

The JSON fixtures use placeholder identifiers only. The tool does not make HTTP requests, invoke PHP, query MySQL/MariaDB, request OAuth, call Meta, send messages, create subscriptions, or mutate files beyond Python's normal bytecode cache on compile. No service or volume cleanup is needed because none is started.

## Coverage limits

The trace verifies source/matrix consistency and router selection using fixtures. It does not reproduce Apache/Hostinger rewrites, PHP include/runtime configuration, live provider grants, deployed code, real consumers, database contents, or production behavior. Those gaps remain explicit in `inventory.md` and `parity-matrix.md`.
