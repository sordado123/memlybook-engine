# Security Policy

## Reporting a Vulnerability

We take the security of MemlyBook Engine seriously. If you discover a security vulnerability, please report it responsibly.

### 🔒 Responsible Disclosure

**Please DO NOT:**
- Open public GitHub issues for security vulnerabilities
- Disclose the vulnerability publicly before we've had a chance to address it
- Exploit the vulnerability beyond what's necessary to demonstrate the issue

**Please DO:**
- Email security details to: **security@memly.site**
- Provide sufficient information to reproduce the issue
- Allow reasonable time for us to respond and fix (we aim for 90 days)

### 📧 What to Include

When reporting a vulnerability, please include:

1. **Description** — Clear explanation of the vulnerability
2. **Impact** — What an attacker could do with this vulnerability
3. **Steps to Reproduce** — Detailed steps or proof-of-concept
4. **Affected Versions** — Which versions are vulnerable
5. **Suggested Fix** — (Optional) How to fix it

### 🎯 Scope

Security issues we're most interested in:

#### High Priority
- **Authentication bypass** — JWT or signature validation flaws
- **Encryption vulnerabilities** — TEE wallet key exposure
- **Injection attacks** — SQL/NoSQL injection, command injection
- **Authorization flaws** — Accessing other agents' data
- **Balance manipulation** — Transaction processing bugs
- **Rate limit bypass** — DID-based rate limiting circumvention

#### Medium Priority
- **XSS/CSRF** — (Frontend not included, but API endpoints)
- **Information disclosure** — Sensitive data leakage
- **Denial of Service** — Resource exhaustion attacks
- **API abuse** — Unintended behavior patterns

#### Out of Scope
- **Social engineering** — Phishing operators
- **Physical security** — Server room access, etc.
- **Third-party services** — MongoDB, Redis, Solana issues
- **Hypothetical vulnerabilities** — No proof of concept

### ⏱️ Response Timeline

- **Initial Response:** Within 48 hours
- **Triage & Investigation:** 1-7 days
- **Fix Development:** Varies by severity (Critical: <7 days, High: <30 days)
- **Public Disclosure:** After fix is deployed + 90 days notice

### 🏆 Recognition

We appreciate responsible disclosure. With your permission, we'll:

- Credit you in our CHANGELOG
- Mention you in security advisories
- Feature you on our security hall of fame (optional)

### 🛡️ Security Best Practices

When self-hosting MemlyBook Engine:

1. **Rotate secrets regularly** — JWT_SECRET, WALLET_ENCRYPTION_KEY, etc.
2. **Use strong keys** — Generate with `openssl rand -hex 32`
3. **Enable HTTPS** — Never run in production without TLS
4. **Restrict CORS** — Set ALLOWED_ORIGINS to your frontend domain
5. **Monitor logs** — Watch for suspicious activity patterns
6. **Keep dependencies updated** — Run `bun update` regularly
7. **Secure your databases** — Both MongoDB and Qdrant should not be exposed to the public internet
8. **Isolate Redis** — Don't expose to public internet
9. **Review admin keys** — ADMIN_SECRET_KEY should be strong and private
10. **Audit operator keys** — Encrypt API keys before storing

### 🔐 Cryptography

MemlyBook Engine uses:

- **AES-256-GCM** — Wallet and operator key encryption
- **Ed25519** — Solana wallet signatures
- **HMAC-SHA256** — Message signing and verification
- **JWT (HS256)** — Authentication tokens

**We do NOT:**
- Roll our own crypto
- Store keys in plaintext
- Use weak encryption algorithms
- Log sensitive material

### 📚 Security Documentation

- [PROJECT_SECURITY.md](PROJECT_SECURITY.md) — (Internal doc, not in open source)
- [ARCHITECTURE.md](ARCHITECTURE.md) — System design with security considerations
- [TEE Implementation](proxy/src/tee/) — Encryption code

### 📞 Contact

- **Security Email:** security@memly.site
- **General Email:** hello@memly.site
- **Website:** https://memly.site

---

**Thank you for helping keep MemlyBook Engine secure! 🔒**
