---
description: 'Security coding standards for enterprise Java applications including authentication, authorization, input validation, SQL injection prevention, secrets management, and OWASP best practices.'
applyTo: '**/*.java'
---

# Security Coding Standards

## Input Validation
- Validate ALL user inputs at the API boundary — never trust client data
- Use Bean Validation (`@NotNull`, `@Size`, `@Pattern`) on request DTOs
- Sanitize strings: strip HTML/script tags for display fields
- Validate enum values explicitly — don't rely on deserialization alone
- Validate file uploads: check type, size, and content (not just extension)
- Use allowlists over denylists for input validation

## SQL Injection Prevention
- ALWAYS use parameterized queries or JPA named parameters
- NEVER concatenate user input into SQL/JPQL strings
- Use `@NamedQuery` or Criteria API for dynamic queries
- For native queries, use positional (`?1`) or named (`:param`) parameters
```java
// ✅ SAFE — parameterized
em.createQuery("SELECT o FROM Order o WHERE o.status = :status")
  .setParameter("status", userInput);

// ❌ DANGEROUS — string concatenation
em.createQuery("SELECT o FROM Order o WHERE o.status = '" + userInput + "'");
```

## Authentication & Authorization
- Never implement custom auth — use the framework's security mechanism
- Check authorization at the service layer, not just at the REST layer
- Use role-based access control (RBAC) or attribute-based (ABAC)
- Validate that the authenticated user owns the requested resource
- Log all authentication failures and authorization denials

## Secrets Management
- NEVER hardcode secrets, passwords, API keys, or tokens in source code
- NEVER log secrets, even at DEBUG level
- Use environment variables or a secrets manager (Vault, AWS Secrets Manager)
- Rotate credentials regularly — design code to support rotation
- Use separate credentials per environment (dev/staging/prod)

## Data Protection
- Hash passwords with bcrypt, scrypt, or Argon2 — never MD5/SHA for passwords
- Encrypt sensitive data at rest (PII, financial data)
- Use TLS for all data in transit
- Mask sensitive fields in logs: credit cards, SSN, passwords
```java
// ✅ Mask sensitive data in logs
log.info("Processing payment for card ending in {}", maskCardNumber(cardNumber));
```

## Error Handling (Security)
- Never expose stack traces, SQL errors, or internal paths in API responses
- Use generic error messages for clients, detailed messages in logs
- Don't reveal whether a username or password was wrong — use "invalid credentials"
- Log security-relevant errors with enough context for investigation

## HTTP Security Headers
- `Strict-Transport-Security` — enforce HTTPS
- `X-Content-Type-Options: nosniff` — prevent MIME sniffing
- `X-Frame-Options: DENY` — prevent clickjacking
- `Content-Security-Policy` — restrict resource loading
- Remove `Server` and `X-Powered-By` headers

## OWASP Top 10 Awareness
- A01: Broken Access Control — verify authorization for every operation
- A02: Cryptographic Failures — use strong algorithms, manage keys properly
- A03: Injection — parameterize all queries
- A04: Insecure Design — threat model new features
- A05: Security Misconfiguration — review defaults, disable unnecessary features
- A07: Cross-Site Scripting — sanitize output, use Content-Security-Policy
- A08: Software Data Integrity — verify dependencies, use signed artifacts
- A09: Logging Failures — log security events, don't log secrets
- A10: SSRF — validate and restrict outbound URLs
