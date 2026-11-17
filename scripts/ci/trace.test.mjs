import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkTrace, collectTags, listLegFiles, parseTrace } from './trace.mjs';

// Tags are assembled at runtime so this file never counts as a leg itself.
const P = '@' + 'p:';
const SCRIPT = fileURLToPath(new URL('./trace.mjs', import.meta.url));
const FIXTURE_PLAN = fileURLToPath(new URL('./fixtures/trace/BUILDPLAN.md', import.meta.url));
const FIXTURE_LEGS = fileURLToPath(new URL('./fixtures/trace/legs', import.meta.url));
const REAL_PLAN = fileURLToPath(new URL('../../BUILDPLAN.md', import.meta.url));

const fixtureRows = () => parseTrace(readFileSync(FIXTURE_PLAN, 'utf8')).rows;
const tagsFor = (...ids) => collectTags(ids.map((id, i) => ({ path: `leg${i}.spec.ts`, text: `test('leg ${P}${id}')` })));

describe('parseTrace', () => {
  it('reads ids and the milestone each row is due by', () => {
    const { rows, problems } = parseTrace(readFileSync(FIXTURE_PLAN, 'utf8'));
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { id: 'col-1', milestones: [1], due: 1 },
      { id: 'col-6', milestones: [0, 1], due: 0 },
      { id: 'note-4', milestones: [1, 2, 3], due: 1 },
      { id: 'R1', milestones: [0], due: 0 },
    ]);
  });

  it('reads the real BUILDPLAN trace table', () => {
    const { rows, problems } = parseTrace(readFileSync(REAL_PLAN, 'utf8'));
    expect(problems).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.find((row) => row.id === 'tech-1')).toMatchObject({ due: 0 });
    expect(rows.find((row) => row.id === 'R15')).toMatchObject({ milestones: [1, 8], due: 1 });
  });

  it('refuses a plan with no trace rows or an unreadable milestone', () => {
    expect(parseTrace('# plan\n\nno table here\n').problems).toContain('no trace rows found under "## Trace"');
    const bad = '## Trace\n\n| Id | Line | Legs | M |\n|---|---|---|---|\n| col-1 | x | y | soon |\n';
    expect(parseTrace(bad).problems).toContain('col-1: unreadable milestone "soon"');
  });
});

describe('collectTags', () => {
  it('maps each tag to the files that carry it', () => {
    const tags = collectTags([
      { path: 'a.spec.ts', text: `test('x ${P}col-1 ${P}R1', () => {}, { tag: ['${P}col-6'] })` },
      { path: 'b.test.mjs', text: `it('y ${P}col-1')` },
    ]);
    expect(tags.get('col-1')).toEqual(['a.spec.ts', 'b.test.mjs']);
    expect(tags.get('R1')).toEqual(['a.spec.ts']);
    expect(tags.get('col-6')).toEqual(['a.spec.ts']);
  });

  it('reads a milestone tag apart from the plain one', () => {
    const tags = collectTags([{ path: 'a.spec.ts', text: `test('x ${P}col-6@1 ${P}col-1')` }]);
    expect([...tags.keys()]).toEqual(['col-6@1', 'col-1']);
  });

  it('ignores tags that appear only in comments', () => {
    const text = [
      `// ${P}col-1 in a line comment`,
      `/* ${P}col-6 in a block`,
      ` * comment ${P}R1 */`,
      `const url = 'http://example.invalid/x'; // ${P}note-4`,
      `test('leg ${P}col-6@1 // not a comment', () => {});`,
      'const s = "/* not a comment either";',
      `test(\`templated ${P}R1\`);`,
    ].join('\n');
    expect([...collectTags([{ path: 'a.spec.ts', text }]).keys()]).toEqual(['col-6@1', 'R1']);
    const commentOnly = collectTags([{ path: 'b.spec.ts', text: `// ${P}col-6@1\ntest('leg', () => {});` }]);
    const rows = fixtureRows().filter((row) => row.id === 'col-6');
    expect(checkTrace({ rows, tags: new Map([...tagsFor('col-6'), ...commentOnly]), milestone: 1 }).problems).toEqual([`col-6 (due M1) has no leg tagged ${P}col-6@1`]);
  });
});

describe('checkTrace', () => {
  it('is red on a row with no tagged leg by its milestone', () => {
    const { problems } = checkTrace({ rows: fixtureRows(), tags: tagsFor('col-6'), milestone: 0 });
    expect(problems).toEqual(['R1 (due M0) has no tagged leg']);
  });

  it('passes once every row due by the gate is tagged', () => {
    expect(checkTrace({ rows: fixtureRows(), tags: tagsFor('col-6', 'R1'), milestone: 0 }).problems).toEqual([]);
  });

  it('gates later rows only when their milestone is reached', () => {
    const { problems } = checkTrace({ rows: fixtureRows(), tags: tagsFor('col-6', 'col-6@1', 'R1'), milestone: 1 });
    expect(problems).toEqual(['col-1 (due M1) has no tagged leg', 'note-4 (due M1) has no tagged leg']);
  });

  it('gates every milestone a row lists, each by its own tag', () => {
    const rows = fixtureRows().filter((row) => row.id === 'col-6');
    expect(checkTrace({ rows, tags: tagsFor('col-6'), milestone: 0 }).problems).toEqual([]);
    expect(checkTrace({ rows, tags: tagsFor('col-6'), milestone: 1 }).problems).toEqual([`col-6 (due M1) has no leg tagged ${P}col-6@1`]);
    expect(checkTrace({ rows, tags: tagsFor('col-6', 'col-6@1'), milestone: 1 }).problems).toEqual([]);
    expect(checkTrace({ rows, tags: tagsFor('col-6@0', 'col-6@1'), milestone: 1 }).problems).toEqual([]);
  });

  it('fails a milestone tag the row does not list', () => {
    const { problems } = checkTrace({ rows: fixtureRows(), tags: tagsFor('col-6@2'), milestone: null });
    expect(problems).toEqual([`col-6@2 is tagged in leg0.spec.ts but col-6 is not due at M2`]);
  });

  it('reports without failing when no gate is set', () => {
    expect(checkTrace({ rows: fixtureRows(), tags: tagsFor(), milestone: null }).problems).toEqual([]);
  });

  it('always fails a tag that names no trace row', () => {
    const { problems } = checkTrace({ rows: fixtureRows(), tags: tagsFor('col-99'), milestone: null });
    expect(problems).toEqual(['col-99 is tagged in leg0.spec.ts but is not a trace row']);
  });
});

describe('listLegFiles', () => {
  it('finds spec and test files and skips fixtures', () => {
    const scriptsDir = fileURLToPath(new URL('..', import.meta.url));
    const files = listLegFiles([scriptsDir]);
    expect(files.some((file) => file.endsWith('trace.test.mjs'))).toBe(true);
    expect(files.some((file) => file.includes('fixtures'))).toBe(false);
  });
});

describe('CLI', () => {
  it('exits 1 and names the untagged row at an M0 gate', () => {
    let failure;
    try {
      execFileSync(process.execPath, [SCRIPT, '--plan', FIXTURE_PLAN, '--root', FIXTURE_LEGS, '--milestone', '0'], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(`${failure?.stdout}${failure?.stderr}`).toMatch(/R1 \(due M0\) has no tagged leg/);
  });

  it('exits 0 with no gate', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--plan', FIXTURE_PLAN, '--root', FIXTURE_LEGS], {
      encoding: 'utf8',
      env: { ...process.env, TRACE_MILESTONE: '' },
    });
    expect(out).toMatch(/4 rows/);
  });
});
