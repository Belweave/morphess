# Morphess interaction contract

Morphess submits coding work to a configured OpenAI-compatible model through Pi Durable. The terminal, CLI, and HTTP API operate on the same native conversations and tasks.

- Input admission returns a durable submission ID. Retry keys prevent duplicate admission within a conversation.
- Closing a client preserves accepted work. Explicit abort cancels the selected ownership subtree.
- File, shell, nested, and delegated tools retain their execution policy. Answering a question or switching UI mode does not grant host authority.
- Pending human questions expose the exact owning tool task ID and remain answerable after restart.
- The terminal prioritizes the conversation and composer. Context, plan, and tool details are available through an optional inspector and searchable menus.
- Session drafts, history, and preferences persist privately with bounded storage. Full task history remains in Pi.
- Model results, tool outcomes, usage, and errors must reflect native state. Fixture results do not establish production inference quality or capacity.

Morphess is independent, unofficial, and not developed, endorsed, sponsored, or backed by Morph.
