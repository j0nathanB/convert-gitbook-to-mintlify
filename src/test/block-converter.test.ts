import { describe, it, expect } from 'vitest';
import { tokenize } from '../parsers/block-tokenizer.js';
import { convertBlock } from '../transformer/block-converter.js';

function convert(input: string): string {
  const { tokens } = tokenize(input);
  expect(tokens.length).toBeGreaterThan(0);
  return convertBlock(tokens[0]);
}

describe('block-converter', () => {
  it('should convert hint info to <Info>', () => {
    const result = convert('{% hint style="info" %}\nThis is a hint\n{% endhint %}');
    expect(result).toContain('<Info>');
    expect(result).toContain('</Info>');
    expect(result).toContain('This is a hint');
  });

  it('should convert hint warning to <Warning>', () => {
    const result = convert('{% hint style="warning" %}\nWarning text\n{% endhint %}');
    expect(result).toContain('<Warning>');
    expect(result).toContain('</Warning>');
  });

  it('should convert hint danger to <Danger>', () => {
    const result = convert('{% hint style="danger" %}\nDanger text\n{% endhint %}');
    expect(result).toContain('<Danger>');
    expect(result).toContain('</Danger>');
  });

  it('should convert hint success to <Check>', () => {
    const result = convert('{% hint style="success" %}\nSuccess text\n{% endhint %}');
    expect(result).toContain('<Check>');
    expect(result).toContain('</Check>');
  });

  it('should convert tabs to <Tabs>/<Tab>', () => {
    const input = `{% tabs %}
{% tab title="JS" %}
JS content
{% endtab %}
{% tab title="Python" %}
Python content
{% endtab %}
{% endtabs %}`;
    const result = convert(input);
    expect(result).toContain('<Tabs>');
    expect(result).toContain('<Tab title="JS">');
    expect(result).toContain('<Tab title="Python">');
    expect(result).toContain('</Tabs>');
  });

  it('should convert stepper/step to <Steps>/<Step>', () => {
    const input = `{% stepper %}
{% step %}
Do this first
{% endstep %}
{% step %}
Then this
{% endstep %}
{% endstepper %}`;
    const result = convert(input);
    expect(result).toContain('<Steps>');
    expect(result).toContain('<Step');
    expect(result).toContain('</Steps>');
  });

  it('should convert details to <Accordion>', () => {
    const result = convert('{% details title="Click me" %}\nHidden content\n{% enddetails %}');
    expect(result).toContain('<Accordion title="Click me">');
    expect(result).toContain('</Accordion>');
  });

  it('should convert embed to <Frame>', () => {
    const result = convert('{% embed url="https://youtube.com/watch?v=abc" %}My caption{% endembed %}');
    expect(result).toContain('<Frame');
    expect(result).toContain('https://youtube.com/watch?v=abc');
  });

  it('should convert content-ref to <Card>', () => {
    const result = convert('{% content-ref url="getting-started.md" %}Start Here{% endcontent-ref %}');
    expect(result).toContain('<Card');
    expect(result).toContain('href=');
  });

  it('should convert file to <Card> with download icon', () => {
    const result = convert('{% file src="report.pdf" %}Download Report{% endfile %}');
    expect(result).toContain('<Card');
    expect(result).toContain('download');
  });
});
