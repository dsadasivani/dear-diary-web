# Living Memories motion system

Motion explains state and spatial relationships. It must be calm, short, interruptible, and absent when the user requests reduced motion.

## Tokens

The canonical CSS durations and easing curves live in `src/index.css`; reusable Motion transitions live in `src/components/ui/motion.ts`.

- Press feedback: 120ms with a small scale or elevation change.
- State change: about 180ms for selection, disclosure, and validation.
- Page transition: about 240ms for root and focused-flow changes.
- Deliberate reveal: up to 380ms for the first-session Today composition.
- Shared object: responsive spring for journal-cover continuity.

Exit motion is slightly faster than entry motion. Avoid long opacity-only sequences, decorative looping, and simultaneous movement of unrelated regions.

## Product choreography

The Today screen may run one short reveal per session: greeting, prompt, journal covers, and recent memories. A journal cover can preserve identity as the reader opens. Sheets emerge from their physical edge. Save status uses a restrained state transition rather than a blocking overlay.

Haptics are optional native reinforcement for selection, create, successful save, destructive confirmation, and unlock feedback. They never replace visible or announced state.

## Reduced motion

Every Motion component checks the reduced-motion preference. Shared objects become near-instant fades/state changes; stagger and transform are removed. Visual tests force reduced motion so snapshots represent stable end states.
