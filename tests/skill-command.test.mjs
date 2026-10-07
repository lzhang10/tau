/**
 * Frontend pure-function tests (issue 183).
 *
 * The chip's <skill name="..."> prefix parser and the menu's skill filter
 * are the only frontend units under test; DOM and menu interaction are
 * covered by the manual e2e procedure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillInvocation, filterSkills, skillChipLabel } from '../public/skill-command.js';

// The exact shape pi's _expandSkillCommand produces:
//   `<skill name="<n>" location="<f>">\nReferences are relative to <d>.\n\n<body>\n</skill>`
// with `\n\n<args>` appended when args were given.
function piExpansion(name, body, args = '') {
  const block = `<skill name="${name}" location="/root/.agents/skills/${name}/SKILL.md">\n` +
    `References are relative to /root/.agents/skills/${name}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

test('parseSkillInvocation parses an expanded skill with args', () => {
  const text = piExpansion('alpha', 'Do the alpha thing.', 'do the thing');
  assert.deepEqual(parseSkillInvocation(text), { name: 'alpha', args: 'do the thing' });
});

test('parseSkillInvocation parses an expanded skill without args', () => {
  const text = piExpansion('beta', 'Do the beta thing.');
  assert.deepEqual(parseSkillInvocation(text), { name: 'beta', args: '' });
});

test('parseSkillInvocation returns null for a plain message', () => {
  assert.equal(parseSkillInvocation('hello world'), null);
});

test('parseSkillInvocation returns null when the prefix is not at the start', () => {
  const text = `Please read <skill name="alpha" location="/x">body</skill> for me`;
  assert.equal(parseSkillInvocation(text), null);
});

test('parseSkillInvocation returns null for non-string input', () => {
  assert.equal(parseSkillInvocation(undefined), null);
  assert.equal(parseSkillInvocation(null), null);
  assert.equal(parseSkillInvocation(42), null);
});

const COMMANDS = [
  { name: 'taustop', description: 'Stop the Tau mirror server', source: 'extension' },
  { name: 'greet', description: 'Greeting template', source: 'prompt' },
  { name: 'skill:zeta', description: 'Zeta skill', source: 'skill' },
  { name: 'skill:alpha', description: 'Alpha skill', source: 'skill' },
];

test('filterSkills with empty query returns all skills sorted, excluding non-skills', () => {
  const result = filterSkills(COMMANDS, '');
  assert.deepEqual(result.map((c) => c.name), ['skill:alpha', 'skill:zeta']);
});

test('filterSkills matches on the bare skill name', () => {
  const result = filterSkills(COMMANDS, 'alpha');
  assert.deepEqual(result.map((c) => c.name), ['skill:alpha']);
});

test('filterSkills matches on the full skill:name form', () => {
  const result = filterSkills(COMMANDS, 'skill:ze');
  assert.deepEqual(result.map((c) => c.name), ['skill:zeta']);
});

test('filterSkills is case-insensitive', () => {
  const result = filterSkills(COMMANDS, 'ALPHA');
  assert.deepEqual(result.map((c) => c.name), ['skill:alpha']);
});

test('filterSkills returns no skills for a non-skill query', () => {
  assert.deepEqual(filterSkills(COMMANDS, 'taustop'), []);
});

test('filterSkills tolerates null input', () => {
  assert.deepEqual(filterSkills(null, 'x'), []);
});

test('skillChipLabel returns the SKILL: name label', () => {
  assert.equal(skillChipLabel('code-review'), 'SKILL: code-review');
  assert.equal(skillChipLabel('ask-matt'), 'SKILL: ask-matt');
});
