# Security policy

## Supported versions

This is a reference architecture. Security fixes go to the `main` branch and
appear in the next tagged release. Older tags are not patched.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting: open the repository's **Security** tab and
choose **Report a vulnerability** (GitHub Security Advisories). Include:

- the affected component (service, package, Dockerfile, workflow) and commit
- steps to reproduce, or a proof of concept
- the impact you observed or expect

Do not include real personal data or production credentials in a report. The
project ships only synthetic local-development values.

We aim to acknowledge reports within 5 working days and to agree on a fix and
disclosure timeline with you. Coordinated disclosure is appreciated; reporters
are credited in the advisory unless they prefer otherwise.

## Scope and expectations

- **The local defaults are not secrets.** Passwords, tokens and keys in
  `docker-compose.yml`, `.env.example` and `scripts/dev.mjs` are synthetic,
  local-only defaults. They are documented as such and are not vulnerabilities.
  Never use them outside a workstation.
- **The payment service is a simulator.** It accepts only simulated tokens and
  makes no PCI DSS claims. See [docs/security/payments.md](docs/security/payments.md).
- **The auth service is a reference implementation.** Read its stated
  limitations in [docs/security/authentication.md](docs/security/authentication.md)
  before relying on it.
- Automated checks (CodeQL, npm audit, gitleaks, Trivy) run in CI. Passing them
  does **not** mean the software is free of vulnerabilities. See
  [docs/security/README.md](docs/security/README.md) for the security model and
  [docs/security/threat-model.md](docs/security/threat-model.md) for known risks.
