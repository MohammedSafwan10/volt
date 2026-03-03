import type { ContentType } from '$core/services/token-counter';

// Secret patterns to redact
const SECRET_PATTERNS = [
  /^\.env$/i,
  /\.env\./i,
  /secret/i,
  /password/i,
  /api[_-]?key/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i
];

/**
 * Generate a short checksum for content (for stale detection)
 */
export function generateChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

/**
 * Check if a path looks like it contains secrets
 */
export function isLikelySecretPath(path: string): boolean {
  const filename = path.split('/').pop() ?? path;
  return SECRET_PATTERNS.some(pattern => pattern.test(filename));
}

/**
 * Redact potential secrets from content
 */
export function redactSecrets(content: string): string {
  // Redact common secret patterns - key=value assignments with secret-like names
  return content
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*["']?([^"'\s\n]+)["']?/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9_-]{20,}/gi, 'Bearer [REDACTED]');
}

/**
 * Sanitize user input to remove excessive repetition
 * This prevents the model from echoing back massive repetitive text
 */
export function sanitizeUserInput(content: string): string {
  // Max input length (chars) - roughly 50k tokens
  const MAX_INPUT_LENGTH = 200_000;

  // If input is short, no need to process
  if (content.length < 500) {
    return content;
  }

  // Truncate if excessively long
  if (content.length > MAX_INPUT_LENGTH) {
    content = content.slice(0, MAX_INPUT_LENGTH) + '\n\n[Input truncated due to length]';
  }

  // Detect repetitive patterns (phrases repeated 3+ times consecutively)
  const words = content.split(/\s+/);

  // Look for repeated phrase patterns (5-30 words)
  for (let phraseLen = 5; phraseLen <= 30; phraseLen++) {
    if (words.length < phraseLen * 3) continue;

    for (let start = 0; start < words.length - phraseLen * 2; start++) {
      const phrase = words.slice(start, start + phraseLen).join(' ');
      let repeatCount = 1;
      let checkPos = start + phraseLen;

      while (checkPos + phraseLen <= words.length) {
        const nextPhrase = words.slice(checkPos, checkPos + phraseLen).join(' ');
        if (nextPhrase === phrase) {
          repeatCount++;
          checkPos += phraseLen;
        } else {
          break;
        }
      }

      // If phrase repeats 3+ times, collapse it
      if (repeatCount >= 3) {
        const beforeRepeat = words.slice(0, start).join(' ');
        const afterRepeat = words.slice(start + phraseLen * repeatCount).join(' ');
        const collapsed = `${beforeRepeat} ${phrase} [repeated ${repeatCount}x, collapsed] ${afterRepeat}`.trim();
        return sanitizeUserInput(collapsed); // Recurse to catch nested patterns
      }
    }
  }

  return content;
}

export function estimateTokensFromChars(charCount: number, contentType: ContentType = 'mixed'): number {
  const ratio = contentType === 'code' ? 3.2 : contentType === 'prose' ? 4.2 : contentType === 'json' ? 2.6 : 3.8;
  return Math.ceil(charCount / ratio);
}
