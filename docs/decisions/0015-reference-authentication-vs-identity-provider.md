# ADR-0015: Reference authentication implementation vs external identity provider

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

The blueprint needs authenticated and role-based APIs to demonstrate authorization, audit and session handling. Most production systems should not build their own identity provider: MFA, social login, federation (SAML/OIDC), account recovery, breach detection and compliance are large problems. Yet a blueprint that only says "plug in an IdP" cannot show how services verify tokens, rotate keys or react to account status changes, and it cannot run offline.

## Decision

Ship **auth-service as a reference implementation** that follows current good practice, and document it explicitly as a reference, not a recommendation to run your own IdP.

Implemented (details in [authentication](../security/authentication.md)):

- Argon2id password hashing (19 MiB, t=2, p=1) with transparent rehash on login; timing equalisation for unknown emails.
- ES256 JWT access tokens (15 min, `typ: at+jwt`, issuer `emb-auth-service`, audience `emb-api`), JWKS at `/.well-known/jwks.json`, previous public key retained during rotation (`JWT_PREVIOUS_PUBLIC_KEY`).
- Opaque 256-bit refresh tokens stored as SHA-256 hashes, rotated on every use, reuse detection revoking the whole session family.
- Account lockout, single-use password-reset tokens, session revocation on password reset and on account suspension/closure.

**Services depend only on standard token verification** (`packages/security`): signature via JWKS, issuer, audience, expiry, `typ`, and `sub`/`roles`/`sid`/`jti` claims. Replacing auth-service with an external provider therefore changes configuration and a claim mapping, not domain code.

**Recommendation (not implemented):** for production, use an established identity provider — for example Keycloak (self-hosted), Auth0/Okta, Amazon Cognito, Microsoft Entra ID or Google Identity Platform — and configure services with its JWKS URL, issuer and audience. Map the provider's role/group claim to the `roles` claim (`customer`, `admin`), and replace the `UserRegistered` event with a provisioning hook or a first-login handler.

## Consequences

### Positive

- The full authentication flow runs offline and is readable end to end.
- Token verification, key rotation and session revocation are demonstrated concretely.
- The switch to an external IdP is a bounded change.

### Negative and trade-offs

- Missing features compared with a real IdP: MFA, WebAuthn/passkeys, social and enterprise login, email verification, consent, admin console, breached-password checks.
- **Access tokens remain valid until they expire** (up to 15 minutes) after logout, password reset or account suspension; there is no token denylist. Refresh tokens are revoked immediately.
- Bootstrap admin credentials come from environment variables; acceptable locally, but production admin provisioning should go through the IdP.
- Owning authentication code means owning its vulnerabilities and security reviews.

## Alternatives considered

| Option                                    | Why not chosen for the blueprint                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Keycloak container in Compose             | Realistic, but heavy for a laptop stack and moves the interesting mechanics into configuration. A good production choice. |
| Hosted IdP only                           | Cannot run offline; requires accounts and secrets to try the project.                                                     |
| Session cookies with server-side sessions | Every service would need to call auth-service (or a shared store) per request; JWT + JWKS lets services verify locally.   |

## Operational cost

- If the reference implementation is kept: key management and rotation, monitoring of `auth_operations_total` (lockouts, reuse detection), security reviews and dependency patching.
- If an IdP is adopted: licence or hosting cost, integration and claim mapping, and availability of the IdP's JWKS endpoint (services fail closed with `503` when they cannot fetch keys).
