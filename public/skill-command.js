/**
 * Skill Command — pure helpers for slash-command skill support (issue 183).
 *
 * No DOM access: these run in the browser and in Node tests alike.
 *
 * pi expands `/skill:<name> [args]` into a user message that starts with a
 * `<skill name="..." location="...">` block (pi's _expandSkillCommand).
 * parseSkillInvocation reverses that expansion for chip rendering;
 * filterSkills backs the `/` skill menu.
 */

// Head of a pi skill expansion: <skill name="<name>" ...>
const SKILL_PREFIX = /^<skill name="([^"]+)"/;

/**
 * Parse a user message that pi expanded from a /skill:<name> invocation.
 *
 * @param {string} text full user message text
 * @returns {{name: string, args: string} | null} the skill name and the
 *   trailing args (text after the closing </skill> tag), or null when the
 *   text is not a skill expansion.
 */
export function parseSkillInvocation(text) {
  if (typeof text !== 'string') return null;
  const match = SKILL_PREFIX.exec(text);
  if (!match) return null;
  const close = text.indexOf('</skill>');
  const after = close === -1 ? '' : text.slice(close + '</skill>'.length);
  return { name: match[1], args: after.trim() };
}

/**
 * Filter pi's command list (from the get_commands RPC) to the skills that
 * match the query typed after the leading "/".
 *
 * Skills are named "skill:<name>". The query may include the "skill:"
 * prefix or not; both match. An empty query returns all skills.
 *
 * @param {Array<{name: string, description: string, source: string}>} commands
 * @param {string} query text after the leading "/"
 * @returns {Array} the matching skill commands, sorted by name
 */
export function filterSkills(commands, query) {
  const q = (query || '').toLowerCase();
  return (commands || [])
    .filter((c) => c.source === 'skill')
    .filter((c) => {
      if (!q) return true;
      const bare = c.name.startsWith('skill:') ? c.name.slice('skill:'.length) : c.name;
      return c.name.toLowerCase().includes(q) || bare.toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
