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
