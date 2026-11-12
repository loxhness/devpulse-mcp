/**
 * Strips secrets from a log line before it is shown to an AI assistant.
 *
 * Patterns are format-specific on purpose: generic shapes like `a.b.c` or long
 * hex strings also match file paths, hostnames, versions and git SHAs, which
 * are exactly the details a debugging assistant needs.
 */
const R = "[REDACTED]";

const TOKEN_PATTERNS: RegExp[] = [
  // JWTs: the header always starts with base64url("{") => "eyJ"
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  // GitHub
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS access key IDs
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Stripe
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  // Anthropic / OpenAI style
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  // Slack
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  // npm tokens
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // Private key blocks logged on one line
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

export function redact(input: string): string {
  try {
    let output = String(input ?? "");

    output = output.replace(/\bBearer\s+[^\s"',]+/gi, `Bearer ${R}`);
    output = output.replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${R}`);

    // Credentials embedded in URLs: scheme://user:pass@host
    output = output.replace(/:\/\/([^:\s/@]+):([^@\s]+)@/g, `://$1:${R}@`);

    for (const pattern of TOKEN_PATTERNS) {
      output = output.replace(pattern, R);
    }

    // NAME=value env-style assignments where the name looks secret
    output = output.replace(
      /\b([A-Z0-9_]*(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)(\s*=\s*)(["']?)[^\s"']+\3/g,
      `$1$2$3${R}$3`
    );

    // key=value with no space (logfmt, query strings, CLI flags): this shape is an
    // assignment, not prose, so redact values of any length (password=hunter2).
    output = output.replace(
      /\b(secret|token|password|passwd|api_?key|access_?key|client_?secret)=(?!\[REDACTED\])[^\s"'&,;]+/gi,
      `$1=${R}`
    );

    // key: value / "key": "value" pairs (JSON, YAML). Values must look like
    // credentials (8+ chars) so phrases like "token: expired" survive.
    output = output.replace(
      /(["']?\b(?:secret|token|password|passwd|api_?key|access_?key|client_?secret)\b["']?\s*[:=]\s*["']?)(?!\[REDACTED\])([A-Za-z0-9_\-./+=]{8,})/gi,
      `$1${R}`
    );

    return output;
  } catch {
    return "";
  }
}
