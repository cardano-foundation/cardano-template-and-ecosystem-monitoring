State only exists at UTxOs. Rules only exist at scripts.

Split design idea
NFT is just identity + ownership. Normal CIP-25 NFT, can be sent wallet to wallet, no restriction.
State is separate. Stored at script. - holds things like:
- owner
- data
- sealed flag

Script knows how to link state ↔ NFT. Link via NFT assetclass. For a given NFT, there is exactly one valid state.

Validator logic:
- checks the state
- owner check
- edits allowed only if not sealed
- sealing is one-way, no undo

All authority comes from the state + script.

NFT = identity / tradable asset
State = rules / mutability / guarantees

A valid Cardano pattern.
