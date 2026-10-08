// The moss title line (A§12 moss interchange; T7.4): a leading `# Title` line is the note's name, never a body H1.
import { describe, expect, it } from 'vitest';
import { liftTitleLine } from './title-line.ts';

describe('liftTitleLine', () => {
  it('with no title given, the leading # line becomes the title and leaves the body', () => {
    expect(liftTitleLine('# Tomato log\n\nPlant out in May.\n')).toEqual({ title: 'Tomato log', markdown: 'Plant out in May.\n' });
  });

  it('with the same title given, the line is dropped once', () => {
    expect(liftTitleLine('# Tomato log\n\nPlant out in May.\n', 'Tomato log')).toEqual({ title: 'Tomato log', markdown: 'Plant out in May.\n' });
  });

  it('with a different title given, the H1 stays content', () => {
    const markdown = '# Introduction\n\nPlant out in May.\n';
    expect(liftTitleLine(markdown, 'Tomato log')).toEqual({ title: 'Tomato log', markdown });
  });

  it('keeps frontmatter and reads the line after it', () => {
    expect(liftTitleLine('---\ntags: [garden]\n---\n# Tomato log\n\nBody.')).toEqual({ title: 'Tomato log', markdown: '---\ntags: [garden]\n---\nBody.' });
  });

  it('only a leading line counts: an H1 further down, an H2 or a fenced line is content', () => {
    for (const markdown of ['Intro.\n\n# Tomato log\n', '## Tomato log\n\nBody.', '```\n# Tomato log\n```\n']) {
      expect(liftTitleLine(markdown)).toEqual({ title: undefined, markdown });
    }
  });

  it('a closing # sequence is not part of the title', () => {
    expect(liftTitleLine('# Tomato log ##\nBody.').title).toBe('Tomato log');
  });
});
