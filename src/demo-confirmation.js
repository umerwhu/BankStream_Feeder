async function confirmAction({ expected, action, ask, interactive = true }) {
  if (!interactive) throw new Error(`Interactive confirmation is required to ${action}`);
  const answer = await ask(`This will ${action}. Type "${expected}" to continue: `);
  if (String(answer).trim() !== expected) throw new Error('Confirmation did not match; no database changes were made');
}

module.exports = { confirmAction };
