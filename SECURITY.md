# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Machine Violet, please report it privately using [GitHub's security advisory feature](https://github.com/octopollux/machine-violet/security/advisories/new).

**Do not open a public issue for security vulnerabilities.**

You should receive an initial response within 72 hours. We'll work with you to understand the issue and coordinate a fix before any public disclosure.

## Scope

Machine Violet runs locally and connects to the Anthropic API. Security concerns we care about include:

- **API key exposure** — leaking the user's Anthropic API key through logs, error messages, or network requests to unintended destinations.
- **Arbitrary code execution** — ways that game content, campaign files, or crafted input could execute unintended code on the user's machine.
- **File system access** — reads or writes outside the expected campaign directory or application data paths.
- **Dependency vulnerabilities** — known CVEs in dependencies that are reachable in our usage.

## Out of Scope

- AI model behavior (prompt injection, jailbreaks) — these are Anthropic API concerns, not application vulnerabilities.
- Denial of service against the local process.
