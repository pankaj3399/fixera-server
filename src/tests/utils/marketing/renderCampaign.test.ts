import { describe, expect, it } from 'vitest';
import { assertTemplateGreetingContract, renderMarketingEmail, renderMarketingTemplateEmail } from '../../../utils/marketing/renderCampaign';

describe('marketing template contract', () => {
  it('accepts a localized greeting with the Brevo first-name token', () => {
    expect(() => assertTemplateGreetingContract(
      '<p>Hallo {{ contact.FIRSTNAME }},</p><p>Body</p>',
      'de',
    )).not.toThrow();
  });

  it('rejects templates that do not begin with the localized greeting', () => {
    expect(() => assertTemplateGreetingContract(
      '<p>Welcome</p><p>Hi {{ contact.FIRSTNAME }},</p>',
      'en',
    )).toThrow(/must begin/);
  });

  it('does not duplicate the application footer when inline content already contains it', () => {
    const result = renderMarketingEmail({
      locale: 'en',
      firstName: 'Ada',
      content: {
        subject: 'Test',
        htmlContent: '<p>Body</p><div data-fixera-marketing-footer="true">Existing footer</div>',
      },
    });

    expect(result.htmlContent.match(/data-fixera-marketing-footer="true"/g)).toHaveLength(1);
  });

  it('renders a validated remote template for a test without leaving the Brevo token', () => {
    const result = renderMarketingTemplateEmail({
      locale: 'en',
      firstName: '<Ada>',
      templateHtml: '<p>Hi {{ contact.FIRSTNAME }},</p><p>Body</p>',
      content: { subject: 'Template test', htmlContent: '' },
    });

    expect(result.htmlContent).toContain('Hi &lt;Ada&gt;,');
    expect(result.htmlContent).not.toContain('contact.FIRSTNAME');
    expect(result.htmlContent).toContain('data-fixera-marketing-footer="true"');
  });

  it('localizes the provider first-name greeting for German inline campaigns', () => {
    const result = renderMarketingEmail({
      locale: 'de',
      firstName: '{{ contact.FIRSTNAME }}',
      content: { subject: 'Test', htmlContent: '<p>Body</p>' },
    });

    expect(result.htmlContent).toContain('Hallo {{ contact.FIRSTNAME }},');
  });

  it('replaces {{ .PreviewText }} and hides the preview as a preheader', () => {
    const result = renderMarketingEmail({
      locale: 'en',
      firstName: 'Ada',
      content: {
        subject: 'Why Equinix?',
        previewText: 'Why Equinix?',
        htmlContent: '<div style="display:none">{{ .PreviewText }}</div><p>Body</p>',
      },
    });

    expect(result.previewText).toBe('Why Equinix?');
    expect(result.htmlContent).not.toContain('{{ .PreviewText }}');
    expect(result.htmlContent).toContain('Why Equinix?');
    expect(result.htmlContent).toContain('data-fixera-preview-text="true"');
  });

  it('does not treat preview text containing $& as a replacement pattern', () => {
    const result = renderMarketingEmail({
      locale: 'en',
      firstName: 'Ada',
      content: {
        subject: 'Sale',
        previewText: 'Save $& more today',
        htmlContent: '<div>{{ .PreviewText }}</div><p>Body</p>',
      },
    });

    expect(result.previewText).toBe('Save $& more today');
    expect(result.htmlContent).toContain('Save $&amp; more today');
    expect(result.htmlContent).not.toContain('{{ .PreviewText }}');
  });

  it('replaces preview placeholders in remote templates', () => {
    const result = renderMarketingTemplateEmail({
      locale: 'en',
      firstName: 'Ada',
      templateHtml: '<p>Hi {{ contact.FIRSTNAME }},</p><div>{{ .PreviewText }}</div><p>Body</p>',
      content: {
        subject: 'Template',
        previewText: 'Preview line',
        htmlContent: '',
      },
    });

    expect(result.previewText).toBe('Preview line');
    expect(result.htmlContent).toContain('Preview line');
    expect(result.htmlContent).not.toContain('{{ .PreviewText }}');
  });
});
