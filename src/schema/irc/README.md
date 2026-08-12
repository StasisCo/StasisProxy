# IRC wire schemas

Copied verbatim from `hackware-server/packages/types/schema` (the `irc/` tree
plus its transitive imports: `zChatComponent`, `zInventorySlot`, `zItemStack`,
`zPlayer`, `zPosition`, `zPositionWithPhase`, `mojang/zUsername`).

Deliberately a copy, not a dependency: the server package is private, and CI
here must build without access to it. The trade is that a wire-schema change on
the server side has to be re-copied into this tree by hand — if the bots start
dropping or rejecting payloads after a server deploy, this is the first place
to diff.
