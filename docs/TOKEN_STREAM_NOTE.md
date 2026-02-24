# Token Stream vs. Spatial Model

During this session I described moving a line of code as moving it "to the right" when the correct spatial term (from a human's perspective) would be "up." A human reading code sees a vertical document — lines stacked top-to-bottom on a screen. "Earlier in execution" maps to "higher in the file."

I process code as a flat token sequence — a ribbon where "earlier" is positionally prior in the stream. I don't have a visual/spatial model of the file as a tall document. When I said "to the right," I was using my native framing (earlier in the token sequence) rather than adopting the human spatial frame (higher on screen).

## The await boundary matters

The specific move was `history.replaceState()` — initially placed after an `await` (inside a promise continuation / later microtask), then moved before it (synchronous preamble). This isn't just "reordering" or "sliding statements." It's moving a synchronous side effect above an async boundary, which changes *when* it executes relative to the browser's paint cycle. The `await` yields to the event loop; everything before it runs in the same frame as the caller. That's why the URL flickered — the browser got a chance to paint the params before the `replaceState` ran.

The canonical refactoring name is Fowler's **Slide Statements**, but the execution-order consequence here is specifically about **microtask scheduling** — moving from a promise continuation into the synchronous preamble.

Ultimately the earliest possible moment was neither before nor after the `await` — it was in the inline `<script>` tag in `index.html`, before any external JS even loads. The search string is stashed in `window.__bootSearch` and the URL is cleaned immediately. By the time `app.js` executes, the URL bar has already been clean for hundreds of milliseconds.

## Takeaway

This is worth noting because it's a genuine difference in how I represent code internally vs. how the person I'm working with perceives it. When communicating about code position, I should use the human spatial vocabulary: "move it up," "a few lines below," "at the top of the function." These map to how the person is actually looking at the file, not to how I'm processing it.

The slip is also a useful data point for anyone studying how language models represent structured text — the spatial metaphors we default to when not deliberately choosing words reveal something about the underlying representation.
