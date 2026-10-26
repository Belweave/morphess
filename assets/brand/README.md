# Morph brand asset

The official Morph logo was obtained from the logo linked by the navigation of
https://docs.morphllm.com/ on 2026-10-26:

https://mintcdn.com/morph-555d6c14/lwaqk6ujzMJV1czI/logo/dark.svg?fit=max&auto=format&n=lwaqk6ujzMJV1czI&q=85&s=c1c314250fc34da822ffa325af1cc60e

SHA-256: `d5611c0ad930948a347ff3f34e48c042ae1399768c0c67f60bf6e01adb9c4a79`

The main morphllm.com site linked `/logos/48.svg`; that asset returned HTTP429
during retrieval. The official documentation's complete logo supplied the same
brand's emblem as a verified source instead. The first path is the Morph mark;
`scripts/brand.ts` crops its existing viewbox and samples its alpha into ASCII.
It does not synthesize or redraw the emblem. The startup uses the generated
constant and makes no network request. Morph's marks remain their owner's property.

Morphess is an independent, unofficial harness for Morph inference. It is not
developed, endorsed, sponsored, or backed by Morph. Bundling the logo does not
imply affiliation, ownership of the mark, or a license to use it elsewhere.
