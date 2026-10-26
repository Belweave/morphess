import { defineExtension, hook, section, ToolTask, type Extension } from '@earendil-works/pi-durable';

/**
 * Host capability declaration for commands without an answer channel. Blocking at
 * beforeTool affects only fresh calls before their execution intent is committed.
 * Pi resumes an existing replay-safe ask_user directly in its execute phase, so
 * this extension never cancels, answers, or replaces an already-persisted question.
 */
export function createNonInteractiveQuestionsExtension(options: { enabled?: boolean } = {}): Extension {
  if (options.enabled === false) return defineExtension({ name: 'morphess-noninteractive-questions' });
  return defineExtension({
    name: 'morphess-noninteractive-questions',
    sections: [section('human_input_channel', () =>
      'This host has no interactive answer channel. Do not call ask_user. If required information is missing, explain the question in your final response so the user can provide it in a later request. Existing durable questions remain pending for an interactive host; this does not grant permissions.')],
    hooks: [hook(ToolTask, {
      beforeTool: call => call.name === 'ask_user'
        ? { block: 'This host has no interactive answer channel. Return the question in your final response instead of calling ask_user.' }
        : undefined,
    })],
  });
}
