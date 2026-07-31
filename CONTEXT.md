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

**SeaRoad**:
A single-cell route across the water, numbered in the contiguous run immediately after the last Special and capped at 50. Not the same thing as a road on land: its number is positional, so adding a Special pushes the whole run up by one. Direction pointers follow automatically because renaming a location rewrites every pointer aimed at it — the head and tail, which point at a Land and a Special, are left alone.
_Avoid_: OceanRoad, WaterTile, Path

**Special**:
A non-buyable functional cell — bank, card shop, park, and so on. Numbered 1 up to the engine's `[0x1098]`, and identified by its **tiles**, not by its SPECIAL field: a Special is a 2×2 block whose four tiles run consecutively from `40 + kind*4`. That block is what proves the four cells belong to one locId; the field only says what the engine does when you land there. A plain road, by contrast, is one cell of tile 84.
_Avoid_: Facility, Building, SpecialTile
