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

/** The bridge's own tool-call block. */
export const TOOL_CALL_OPEN = "<<<catpaw_tool_call>>>";
export const TOOL_CALL_CLOSE = "<<<end_catpaw_tool_call>>>";

/**
 * LongCat answers with its own tool-call XML when it has no native tools to
 * call — observed verbatim as:
 *
 *   <longcat_tool_call>bash
 *   <longcat_arg_key>command</longcat_arg_key>
 *   <longcat_arg_value>ls -la</longcat_arg_value>
 *   </longcat_tool_call>
 *
 * It reaches us as ordinary text, so it is treated as a second marker: parsed
 * into real calls instead of being shown to the user as markup.
 */
export const LONGCAT_OPEN = "<longcat_tool_call>";
export const LONGCAT_CLOSE = "</longcat_tool_call>";

/** DeepSeek ships its own markup, again as plain text when it has no tools. */
export const DSML_OPEN = "<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>";
export const DSML_CLOSE = "</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>";

/**
 * The form this bridge used to render history tool calls in. Models read that
 * transcript and imitate it verbatim, so a real session produced
 * `[tool call: dsh_read {...}]` as plain prose and nothing executed. It is a
 * marker now: parsed into a call instead of shown, and no longer emitted.
 */
export const BRACKET_OPEN = "[tool call: ";

/** Default marker set: our block plus the two native formats seen in the wild. */
export const DEFAULT_MARKERS = [
  { open: TOOL_CALL_OPEN, close: TOOL_CALL_CLOSE },
  { open: LONGCAT_OPEN, close: LONGCAT_CLOSE },
  { open: DSML_OPEN, close: DSML_CLOSE },
  // no closing sequence exists: a NUL can never appear in the text, which
  // keeps the gate from inventing an empty body at offset zero
  { open: BRACKET_OPEN, close: "\u0000" },
];

/** Longest hold-back needed to stop a marker from splitting across frames. */
const holdFor = (markers) => Math.max(...markers.map((marker) => marker.open.length)) - 1;

export const MARKER_HOLD = holdFor(DEFAULT_MARKERS);

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
}

/**
 * Splits a channel into ordinary text and a tool-call payload.
 *
 * Text is emitted as it arrives except for a short tail, so a marker split
 * across frames is never half-printed. Once a marker is seen, the rest of the
 * channel becomes payload and nothing more is emitted as text.
 */
export class MarkerGate {
  constructor(channel, markers = DEFAULT_MARKERS) {
    this.channel = channel;
    this.markers = markers;
    this.emitted = 0;
    this.mode = "text"; // "text" | "tool"
    this.marker = null;
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
    let index = -1;
    let found = null;
    for (const marker of this.markers) {
      const at = text.indexOf(marker.open, this.emitted);
      if (at >= 0 && (index < 0 || at < index)) {
        index = at;
        found = marker;
      }
    }
    if (found) {
      const head = index > this.emitted ? text.slice(this.emitted, index) : "";
      this.emitted = Math.max(this.emitted, index);
      this.mode = "tool";
      this.marker = found;
      this.markerIndex = index;
      return head;
    }
    const safe = text.length - this.#pendingMarker(text);
    if (safe <= this.emitted) return "";
    const piece = text.slice(this.emitted, safe);
    this.emitted = safe;
    return piece;
  }

  /**
   * How many trailing characters have to wait because they may be the start of
   * a marker.
   *
   * Holding back the longest marker unconditionally made the first words of
   * every answer wait for ~20 more characters — about half a second of dead air
   * at the speed these models stream. Only a tail that actually matches the
   * beginning of one of the markers needs to wait; everything else can be shown
   * as it arrives.
   */
  #pendingMarker(text) {
    let waiting = 0;
    for (const marker of this.markers) {
      const open = marker.open;
      const longest = Math.min(open.length - 1, text.length);
      for (let length = longest; length > waiting; length -= 1) {
        if (text.endsWith(open.slice(0, length))) {
          waiting = length;
          break;
        }
      }
    }
    return waiting;
  }

  /** Everything still unpublished, once the stream has ended. */
  flush() {
    if (this.mode !== "text") return "";
    const rest = this.channel.text.slice(this.emitted);
    this.emitted = this.channel.text.length;
    return rest;
  }

  /** Everything after the opening marker, before any close-tag handling. */
  remainder() {
    if (this.mode !== "tool" || this.markerIndex < 0 || !this.marker) return "";
    return this.channel.text.slice(this.markerIndex + this.marker.open.length);
  }

  /** The characters after the opening marker, split at the closing marker. */
  payload() {
    if (this.mode !== "tool" || this.markerIndex < 0 || !this.marker) {
      return { body: "", trailing: "", open: null, close: null };
    }
    const { open, close } = this.marker;
    const rest = this.channel.text.slice(this.markerIndex + open.length);
    const end = rest.indexOf(close);
    if (end < 0) return { body: rest, trailing: "", open, close };
    return {
      body: rest.slice(0, end),
      trailing: rest.slice(end + close.length).trim(),
      open,
      close,
    };
  }
}
