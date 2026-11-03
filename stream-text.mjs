/**
 * Streaming text normalisation for the CatPaw bridge.
 *
 * `catpaw-cli` streams `model_chunk` frames whose `content` is a *delta*
 * (measured: 1-4 characters per frame, and the concatenation of every frame in
 * a turn is byte-identical to the `model_end` text). Older notes in this
 * repository claimed the field was a cumulative snapshot; treating deltas as
 * snapshots discarded every piece shorter than the marker hold-back window,
 * which is what truncated and duplicated answers.
 *
 * Because the two shapes are indistinguishable from a single frame, both are
 * accepted: a frame that extends the text we already hold is a snapshot, and
 * anything else is appended as a delta. A repeated identical frame is ignored,
 * which is the one retransmit shape that cannot be confused with real content
 * (`的` arriving twice is legitimate; a whole-frame repeat is not).
 */

export const TOOL_CALL_OPEN = "<<<catpaw_tool_call>>>";
export const TOOL_CALL_CLOSE = "<<<end_catpaw_tool_call>>>";

/** Strategies for holding back a marker that can split across frames. */
export const MARKER_HOLD = TOOL_CALL_OPEN.length - 1;

/** One streamed channel (text or reasoning), delta- or snapshot-shaped. */
export class TextChannel {
  constructor() {
    this.text = "";
  }

  /**
   * Feed one frame's payload.
   * @returns {string} the characters appended by this frame ("" for empty and
   *   repeated frames).
   */
  push(part) {
    if (typeof part !== "string" || part.length === 0) return "";
    const previous = this.text;
    if (part === previous) return "";
    // A snapshot that extends what we hold: take only the extension.
    if (part.length > previous.length && part.startsWith(previous)) {
      this.text = part;
      return part.slice(previous.length);
    }
    // Same-length or shorter snapshots cannot be told apart from a reset; the
    // stream never rewinds in practice, and dropping bytes already shown to the
    // user would be worse than keeping them.
    this.text = previous + part;
    return part;
  }

  /** Replace the buffer wholesale (used for the authoritative `model_end` text). */
  reset(text) {
    if (typeof text !== "string") return;
    this.text = text;
  }
}

/**
 * Splits a channel into ordinary text and the tool-call payload.
 *
 * Text is emitted as it arrives except for a short tail, so a marker split
 * across frames is never half-printed. Once the marker is seen, the rest of the
 * channel becomes payload and nothing more is emitted as text.
 */
export class MarkerGate {
  constructor(channel) {
    this.channel = channel;
    this.emitted = 0;
    this.mode = "text"; // "text" | "tool"
    this.markerIndex = -1;
  }

  /** Feed a frame; returns the text that became safe to publish. */
  push(part) {
    const added = this.channel.push(part);
    if (added.length === 0) return "";
    return this.#drain();
  }

  #drain() {
    if (this.mode === "tool") return "";
    const text = this.channel.text;
    // Scan only what has not been published yet: everything before `emitted`
    // is already on screen, and the hold-back window guarantees a marker that
    // is still arriving starts after it. Scanning from `emitted` (rather than
    // from a fixed tail window) matters on the first frame, where a whole
    // marker block can arrive at offset 0 before anything was published.
    const index = text.indexOf(TOOL_CALL_OPEN, this.emitted);
    if (index >= 0) {
      const head = index > this.emitted ? text.slice(this.emitted, index) : "";
      this.emitted = Math.max(this.emitted, index);
      this.mode = "tool";
      this.markerIndex = index;
      return head;
    }
    const safe = text.length - MARKER_HOLD;
    if (safe <= this.emitted) return "";
    const piece = text.slice(this.emitted, safe);
    this.emitted = safe;
    return piece;
  }

  /** Everything still unpublished, once the stream has ended. */
  flush() {
    if (this.mode !== "text") return "";
    const rest = this.channel.text.slice(this.emitted);
    this.emitted = this.channel.text.length;
    return rest;
  }

  /** The characters after the opening marker, split at the closing marker. */
  payload() {
    if (this.mode !== "tool" || this.markerIndex < 0) return { body: "", trailing: "" };
    const rest = this.channel.text.slice(this.markerIndex + TOOL_CALL_OPEN.length);
    const close = rest.indexOf(TOOL_CALL_CLOSE);
    if (close < 0) return { body: rest, trailing: "" };
    return {
      body: rest.slice(0, close),
      trailing: rest.slice(close + TOOL_CALL_CLOSE.length).trim(),
    };
  }
}
