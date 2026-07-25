# Map Editor

The central domain of the RICH2 map editor, managing state, encoding/decoding, and rendering for map files.

## Language

**DOMController**:
The UI adapter that binds HTML elements to domain actions. Translates DOM events (clicks, inputs) into high-level interactions with the Workspace and Renderer.
_Avoid_: Main, EventListeners

**Renderer**:
The component that translates Workspace state into visual output on the Canvas. It orchestrates its own draw cycles.
_Avoid_: ViewManager, DrawFunctions

**Workspace**:
The stateful editing session that encapsulates raw file buffers, decompressed map arrays, and decoding orchestration. It provides a UI-agnostic query interface.
_Avoid_: Global state, MapData, MainContext

**History**:
The undo/redo stack. Stores whole-editor snapshots (grid, layout, loc, price, segment names) rather than individual commands, because mutation sites are scattered across many handlers and a snapshot is only ~17KB. `push()` is called *before* a mutation and is labelled with the action about to happen.
_Avoid_: UndoManager, CommandStack

**Routing**:
The UNKA/UNKB tables that steer the police car (to jail) and ambulance (to hospital). Their invariant is *convergence* — following the directions must reach the entry cell — not shortest path. Repairing them means rewriting only the cells that fail to converge.
_Avoid_: Pathfinding, Navigation

**Land**:
A buyable cell. Always numbered 51 or above, always carries a segment, always drawn with tiles 9–14, and always paired 1:1 with a Marker.
_Avoid_: Property, Plot

**Marker**:
The purchase-flag cell sitting next to a Land, numbered `land + 950` and drawn with tile 1. It also encodes which side of the walkway the building sits on (UNK3).
_Avoid_: OwnershipTile, Flag
