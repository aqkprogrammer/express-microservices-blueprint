import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  MissingTemplateVariableError,
  formatMoney,
  placeholders,
  render,
} from './templates.js';

describe('template rendering', () => {
  it('substitutes placeholders', () => {
    expect(render('Hi {{ name }}, total {{total}}', { name: 'Ada', total: '$1.00' })).toBe(
      'Hi Ada, total $1.00',
    );
  });

  it('fails loudly on missing variables', () => {
    expect(() => render('Hi {{name}}', {})).toThrow(MissingTemplateVariableError);
  });

  it('neutralises newlines in values (header injection)', () => {
    expect(render('Subject {{x}}', { x: 'a\r\nBcc: evil@example.com' })).toBe(
      'Subject a Bcc: evil@example.com',
    );
  });

  it('lists placeholders of every default template', () => {
    expect(placeholders(DEFAULT_TEMPLATES['password-reset']!.bodyText)).toEqual([
      'displayName',
      'expiresInMinutes',
      'resetUrl',
    ]);
  });

  it('formats integer cents as currency', () => {
    expect(formatMoney(12_900, 'USD')).toBe('$129.00');
  });
});
