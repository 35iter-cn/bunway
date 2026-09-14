# Security Policy

## Reporting

Report vulnerabilities privately to **rxh12352@gmail.com**. Please include a
description, reproduction steps, and impact. You will get a response within a
few days.

Please do not open a public issue for anything you believe is exploitable.

## Scope and known design decisions

- The admin API (`/admin/*`) and the `/console` dashboard are designed for a
  trusted network. The console serves its HTML without authentication on
  purpose (the admin token is entered in-page and used for data calls).
  **Do not expose the admin port directly to the public internet** — put it
  behind an SSH tunnel or an authenticating reverse proxy.
- Client-facing endpoints (`/v1/*`) require a client key; the admin token is
  separate.

## Supported versions

Only the latest release (`v0.1.0` and later) is supported.