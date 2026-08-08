import { describe, expect, it } from 'vitest';
import { sanitizeTerminal } from './ui.js';

describe('terminal sanitization', () => {
  it('removes ANSI control sequences and non-printing controls from peer-provided text', () => {
    expect(sanitizeTerminal('\u001b[31mred\u001b[0m\u0000safe')).toBe('redsafe');
    expect(sanitizeTerminal('\u001b]0;changed title\u0007description')).toBe('description');
  });
});
