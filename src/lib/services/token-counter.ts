/**
 * Token Counter Service
 * 
 * Accurate token estimation for Gemini models.
 * Uses heuristic-based counting that matches Gemini's tokenizer behavior.
 * 
 * Based on analysis of Gemini tokenization patterns:
 * - Average ~3.5 chars per token for English prose
 * - Average ~2.5 chars per token for code (more special chars)
 * - Whitespace and punctuation often separate tokens
 * - Numbers tokenize as individual digits often
 */

// Content type detection patterns
const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|hpp|cs|rb|php|swift|kt|scala|dart|svelte|vue)$/i;
const CODE_PATTERNS = /^(import|export|function|class|const|let|var|def|fn|pub|async|await|return|if|else|for|while|switch|case)\b/;

/**
 * Content type for token estimation
 */
export type ContentType = 'code' | 'prose' | 'mixed' | 'json';

/**
 * Detect content type from text
 */
export function detectContentType(text: string, filename?: string): ContentType {
  if (filename && CODE_EXTENSIONS.test(filename)) {
    return 'code';
  }
  
  if (filename?.endsWith('.json') || filename?.endsWith('.jsonc')) {
    return 'json';
  }
  
  // Check first 500 chars for code patterns
  const sample = text.slice(0, 500);
  const lines = sample.split('\n');
  
  let codeScore = 0;
  let proseScore = 0;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Code indicators
    if (CODE_PATTERNS.test(trimmed)) codeScore += 2;
    if (trimmed.includes('{') || trimmed.includes('}')) codeScore++;
    if (trimmed.includes('=>') || trimmed.includes('->')) codeScore++;
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) codeScore++;
    if (/[;:]\s*$/.test(trimmed)) codeScore++;
    
    // Prose indicators
    if (/^[A-Z][a-z].*[.!?]$/.test(trimmed)) proseScore += 2;
    if (trimmed.length > 60 && !trimmed.includes('{')) proseScore++;
  }
  
  if (codeScore > proseScore * 2) return 'code';
  if (proseScore > codeScore * 2) return 'prose';
  return 'mixed';
}

/**
 * Token estimation ratios per content type
 * Based on empirical testing with Gemini tokenizer
 */
const TOKEN_RATIOS: Record<ContentType, number> = {
  prose: 3.8,   // ~3.8 chars per token for English prose
  code: 2.8,    // ~2.8 chars per token for code (more symbols)
  mixed: 3.3,   // Average for mixed content
  json: 2.5     // JSON has lots of quotes, colons, brackets
};

/**
 * Count tokens using heuristic-based estimation
 */
export function countTokens(text: string, contentType?: ContentType): number {
  if (!text) return 0;
  
  const type = contentType ?? detectContentType(text);
  const baseRatio = TOKEN_RATIOS[type];
  
  // Additional adjustments
  let adjustedLength = text.length;
  
  // Count special sequences that typically become single tokens
  const specialPatterns = [
    /\n\n+/g,           // Multiple newlines -> fewer tokens
    /\s{2,}/g,          // Multiple spaces -> fewer tokens  
    /[{}()\[\]]/g,      // Brackets often single tokens
    /"[^"]{1,20}"/g,    // Short strings often few tokens
  ];
  
  // Adjust for patterns that compress well
  for (const pattern of specialPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      adjustedLength -= matches.reduce((sum, m) => sum + m.length * 0.3, 0);
    }
  }
  
  // Count numbers (often tokenize as individual digits)
  const numbers = text.match(/\d+/g);
  if (numbers) {
    const digitCount = numbers.reduce((sum, n) => sum + n.length, 0);
    adjustedLength += digitCount * 0.5; // Numbers add extra tokens
  }
  
  // Non-ASCII characters often = 2+ tokens
  const nonAscii = text.match(/[^\x00-\x7F]/g);
  if (nonAscii) {
    adjustedLength += nonAscii.length * 1.5;
  }
  
  return Math.ceil(Math.max(1, adjustedLength / baseRatio));
}

/**
 * Count tokens for a message with attachments
 */
export function countMessageTokens(content: string, attachments?: Array<{ type: string; content?: string; data?: string }>): number {
  let total = countTokens(content, 'mixed');
  
  if (attachments) {
    for (const att of attachments) {
      if (att.type === 'file' || att.type === 'selection') {
        total += countTokens(att.content ?? '', 'code');
      } else if (att.type === 'image' && att.data) {
        // Images: ~258 tokens for typical image overhead + base64 tokens
        // Gemini processes images differently, but we count the base64 transmission
        total += 258 + Math.ceil(att.data.length / 4);
      }
    }
  }
  
  return total;
}

/**
 * Estimate tokens for entire conversation
 */
export function countConversationTokens(
  messages: Array<{ content: string; attachments?: Array<{ type: string; content?: string; data?: string }> }>,
  pendingInput?: string,
  pendingAttachments?: Array<{ type: string; content?: string; data?: string }>
): number {
  let total = 0;
  
  // System prompt overhead (estimated)
  total += 500;
  
  // Message tokens
  for (const msg of messages) {
    // Role overhead (~4 tokens)
    total += 4;
    total += countMessageTokens(msg.content, msg.attachments);
  }
  
  // Pending input
  if (pendingInput) {
    total += countTokens(pendingInput, 'mixed');
  }
  
  // Pending attachments
  if (pendingAttachments) {
    for (const att of pendingAttachments) {
      if (att.type === 'file' || att.type === 'selection') {
        total += countTokens(att.content ?? '', 'code');
      } else if (att.type === 'image' && att.data) {
        total += 258 + Math.ceil(att.data.length / 4);
      }
    }
  }
  
  return total;
}

/**
 * Quick estimate for UI display (faster, less accurate)
 */
export function quickEstimateTokens(charCount: number, contentType: ContentType = 'mixed'): number {
  return Math.ceil(charCount / TOKEN_RATIOS[contentType]);
}
