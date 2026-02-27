import { describe, it, expect } from 'vitest';
import { tokenize } from '../parsers/block-tokenizer.js';

describe('block-tokenizer', () => {
  it('should tokenize a simple hint block', () => {
    const input = '{% hint style="info" %}This is a hint{% endhint %}';
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('hint');
    expect(tokens[0].attributes.style).toBe('info');
    expect(tokens[0].content).toBe('This is a hint');
  });

  it('should tokenize nested blocks', () => {
    const input = `{% tabs %}
{% tab title="JS" %}
Some JS content
{% endtab %}
{% tab title="Python" %}
Some Python content
{% endtab %}
{% endtabs %}`;
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('tabs');
    expect(tokens[0].children).toHaveLength(2);
    expect(tokens[0].children[0].type).toBe('tab');
    expect(tokens[0].children[0].attributes.title).toBe('JS');
    expect(tokens[0].children[1].attributes.title).toBe('Python');
  });

  it('should handle all hint styles', () => {
    const styles = ['info', 'warning', 'danger', 'success'];
    for (const style of styles) {
      const input = `{% hint style="${style}" %}text{% endhint %}`;
      const { tokens } = tokenize(input);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('hint');
      expect(tokens[0].attributes.style).toBe(style);
    }
  });

  it('should tokenize stepper/step blocks', () => {
    const input = `{% stepper %}
{% step %}
Step 1 content
{% endstep %}
{% step %}
Step 2 content
{% endstep %}
{% endstepper %}`;
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('stepper');
    expect(tokens[0].children).toHaveLength(2);
  });

  it('should tokenize details block', () => {
    const input = '{% details title="FAQ" %}Answer here{% enddetails %}';
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('details');
    expect(tokens[0].attributes.title).toBe('FAQ');
  });

  it('should tokenize embed block', () => {
    const input = '{% embed url="https://youtube.com/watch?v=abc" %}Caption{% endembed %}';
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('embed');
    expect(tokens[0].attributes.url).toBe('https://youtube.com/watch?v=abc');
  });

  it('should tokenize content-ref block', () => {
    const input = '{% content-ref url="getting-started.md" %}Getting Started{% endcontent-ref %}';
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('content-ref');
    expect(tokens[0].attributes.url).toBe('getting-started.md');
  });

  it('should tokenize code block with title', () => {
    const input = '{% code title="example.js" lineNumbers="true" %}```\nconsole.log("hi");\n```{% endcode %}';
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('code');
    expect(tokens[0].attributes.title).toBe('example.js');
  });

  it('should tokenize file block', () => {
    const input = '{% file src=".gitbook/assets/report.pdf" %}Download Report{% endfile %}';
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('file');
    expect(tokens[0].attributes.src).toBe('.gitbook/assets/report.pdf');
  });

  it('should handle legacy code-tabs blocks', () => {
    const input = `{% code-tabs %}
{% code-tabs-item title="app.js" %}
const x = 1;
{% endcode-tabs-item %}
{% endcode-tabs %}`;
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('code-tabs');
    expect(tokens[0].children).toHaveLength(1);
    expect(tokens[0].children[0].type).toBe('code-tabs-item');
  });

  it('should throw in strict mode for unknown blocks', () => {
    const input = '{% unknown %}content{% endunknown %}';
    expect(() => tokenize(input, true)).toThrow('Unrecognized GitBook block type');
  });

  it('should pass unknown blocks through in non-strict mode', () => {
    const input = '{% unknown %}content{% endunknown %}';
    const { tokens } = tokenize(input, false);
    expect(tokens).toHaveLength(0); // Unknown blocks are treated as plain text
  });

  it('should handle deeply nested blocks', () => {
    const input = `{% tabs %}
{% tab title="Example" %}
{% hint style="warning" %}
This is nested
{% endhint %}
{% endtab %}
{% endtabs %}`;
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('tabs');
    expect(tokens[0].children[0].type).toBe('tab');
    expect(tokens[0].children[0].children[0].type).toBe('hint');
  });

  it('should preserve text between blocks', () => {
    const input = 'before {% hint style="info" %}inside{% endhint %} after';
    const { tokens } = tokenize(input);
    expect(tokens).toHaveLength(1);
    // output should be the original text
    expect(tokens[0].content).toBe('inside');
  });
});
