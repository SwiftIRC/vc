# Polls in a call

## Problem

There is no way to put a question to the room and get an answer from everyone. Today
that happens in chat ("+1 / -1"), which nobody can tally reliably, which scrolls away,
and which a late joiner never sees.

## Decisions

- **One active poll per room**, like the countdown. A new poll replaces the previous
  one; there is no list to manage, no stacking in the UI, and no ambiguity about which
  poll a vote belongs to.
- **Ops create and close polls.** Reuses the moderation gating (`kick`/`ban`/`set-lock`/
  `set-quality`) unchanged, matching the SwiftIRC channel-op model. No rate limiting is
  needed because the surface is already trusted.
- **Anonymous tallies.** The server records who voted only to prevent double-voting and
  to allow changing a vote. Per-voter detail is never broadcast, and no client — op or
  not — is shown it.
- **Votes are keyed by session ref**, not participant ID. A reconnect mints a fresh
  participant ID, so an ID-keyed vote would be lost (or double-counted) on every
  reconnect. `opRefs` already solves exactly this for op status; polls copy it.
- **No persistence.** A poll lives in the room's in-memory state and dies with the room,
  like chat history and the countdown. The app has no storage layer, and adding one for
  polls would be a new subsystem rather than a feature.
- **Any op can close a poll, not only its creator.** The countdown restricts `stop` to
  its starter because a stale countdown is noise; a poll outliving its creator's
  reconnect is the point of the feature, not a leak.

## Wire protocol — `internal/signal/messages.go`

Client → server (registered in `Decode`):

```go
// CreatePoll opens a poll, replacing any existing one. Op-gated.
type CreatePoll struct {
    Question string   `json:"question"`
    Options  []string `json:"options"`
}

// Vote casts or changes this participant's vote. PollID guards against a client
// whose card is out of date voting on a poll that has since been replaced.
type Vote struct {
    PollID string `json:"pollId"`
    Choice int    `json:"choice"` // index into the poll's Options
}

// ClosePoll freezes the tallies. Op-gated.
type ClosePoll struct {
    PollID string `json:"pollId"`
}
```

Wire type names: `create-poll`, `vote`, `close-poll` (kebab-case, matching `set-lock`,
`mute-peer`, `media-state`).

Server → client (registered in `serverTypeName` as `poll`):

```go
// PollEvent is the whole poll, broadcast on open, on every vote, and on close.
// It carries NO per-recipient data, so it fans out through Broadcast unchanged.
type PollEvent struct {
    Action   string   `json:"action"`   // "open" | "update" | "close"
    ID       string   `json:"id"`
    Question string   `json:"question"`
    Options  []string `json:"options"`
    Tallies  []int    `json:"tallies"`  // parallel to Options
    By       string   `json:"by"`       // creator's display name
    Open     bool     `json:"open"`
}
```

A client knows its own vote because it cast it, so `yourVote` is deliberately absent
from the broadcast. Putting it there would force a per-recipient send loop in place of
the existing `Broadcast`. After a reconnect the vote is restored from the personalized
join snapshot instead:

```go
// Joined gains:
    Poll *PollSnapshot `json:"poll,omitempty"` // the active poll, or nil

// PollSnapshot is PollEvent plus THIS joiner's own vote.
type PollSnapshot struct {
    ID       string   `json:"id"`
    Question string   `json:"question"`
    Options  []string `json:"options"`
    Tallies  []int    `json:"tallies"`
    By       string   `json:"by"`
    Open     bool     `json:"open"`
    YourVote *int     `json:"yourVote,omitempty"` // nil = this joiner has not voted
}
```

## Room state — `internal/room/poll.go` (new file)

`room.go` is 587 lines already; `poll.go` keeps the feature together the way
`countdown_test.go`, `rename_test.go` and `moderation_test.go` already separate theirs.

```go
type Poll struct {
    ID       string
    Question string
    Options  []string
    Open     bool
    ByName   string
    votes    map[string]int // voter key -> option index
}
```

`Room` gains one field, `poll *Poll` (nil = no poll has been created).

Voter key, in a helper shared with the tests:

```go
// voterKey identifies a voter across reconnects. A reconnect mints a fresh
// participant ID but keeps the session ref, so ref is preferred. Participants
// with no ref (a client that sent no session nonce) fall back to their ID, which
// is unique per connection — they must never share one bucket.
func voterKey(p *Participant) string {
    if p.Ref != "" {
        return "ref:" + p.Ref
    }
    return "id:" + p.ID
}
```

The `ref:` / `id:` prefixes keep the two namespaces from ever colliding.

Methods, all following the room lock discipline used by `Countdown` — mutate under the
mutex, release, then `Broadcast`:

- `CreatePoll(actorID, question string, options []string) error` — requires
  `RoleOp`; validates; replaces `r.poll` with a fresh `Poll` (new ID, empty votes,
  `Open: true`); broadcasts `PollEvent{Action: "open"}`.
- `Vote(actorID, pollID string, choice int) error` — no role requirement; refuses when
  there is no poll, the poll is closed, `pollID` does not match, or `choice` is out of
  range; otherwise writes `votes[voterKey] = choice` and broadcasts
  `PollEvent{Action: "update"}`.
- `ClosePoll(actorID, pollID string) error` — requires `RoleOp`; refuses on ID
  mismatch or an already-closed poll; sets `Open = false` and broadcasts
  `PollEvent{Action: "close"}`.
- `pollSnapshot(p *Participant) *PollSnapshot` — called from `Join` under the lock,
  returning nil when `r.poll` is nil and otherwise filling `YourVote` from
  `votes[voterKey(p)]`.

Errors follow the existing naming in `room.go`: `ErrNoPoll`, `ErrPollClosed`,
`ErrStalePoll`, `ErrBadPollChoice`, `ErrBadPoll` (validation), reusing `ErrNotOp` for
the role gate.

Poll IDs come from a per-room monotonic counter (`pollSeq int` on `Room`, formatted with
`strconv.Itoa`), NOT from randomness. `newID()` lives in `internal/server` and is
unreachable from `internal/room` (server imports room, not the reverse), and a random id
would make the room tests non-deterministic for no gain: the ID's only job is to
invalidate votes cast against a superseded poll, it is never a secret, and it only has
to be unique within one room's lifetime.

### Validation

Mirrors `maxChatRunes = 2000` in `internal/server/server.go`:

- question: non-empty after `strings.TrimSpace`, ≤ 200 runes
- options: 2–6 entries, each non-empty after trimming and ≤ 80 runes
- options are trimmed before storage; a poll with duplicate option text is allowed
  (harmless, and rejecting it is a surprise)

Violations return `ErrBadPoll` and are logged at Debug, not sent to the client — the
client applies the same limits in its compose form, so a violation means a hand-rolled
frame.

### Lifecycle

- The poll survives its creator leaving, unlike the countdown, which `Leave` clears.
  No change to `Leave` is needed.
- The poll dies with the room, like chat history.
- A reconnecting voter's vote is preserved because the ref is stable; their own
  selection is restored from `PollSnapshot.YourVote`.

## Server dispatch — `internal/server/server.go`

Three cases added to `dispatch`. `CreatePoll` and `ClosePoll` join the moderation group
(assign to `err` so the actor gets a private error frame). `Vote` returns early like
`Chat`/`Countdown`: a refused vote is a lost race or a stale card, the authoritative
state arrives in the next broadcast, and an `error` frame would be read by the in-call
client as a terminal join error.

All three are added to the post-join allowed-type list at `server.go:278`.

## Client

- **`assets/lib/poll.js`** (new, pure, unit-tested) — `tallyPercents(tallies)` returning
  integer percentages that sum to exactly 100 when any vote exists (largest-remainder
  rounding), and `[0, 0, …]` when there are none; `totalVotes(tallies)`.
- **`assets/ui/poll.js`** (new) — renders one poll card: question, an option row per
  choice with a live bar and count, the viewer's own selection marked, a vote count
  total, and a Close button for ops. Voting sends `vote`; the card re-renders from the
  next broadcast rather than optimistically, so what is shown is always what the server
  counted. A closed poll renders the same card, frozen, marked "Closed", with the
  winning option emphasized. All participant-controlled text (question, options, `by`)
  is written with `textContent`, the same contract `chat.js` documents.
- **`assets/ui/chat.js`** — the poll card is appended into the chat log through the
  existing `_append`, so it inherits the scroll-pinning and the `MAX_ENTRIES` cap. An
  `update`/`close` for the poll already on screen re-renders that card in place instead
  of appending a new one.
- **`assets/ui/controls.js`** — a "New poll" row in the ☰ settings menu, op-only,
  built in `_ensureOpSettingsRows` alongside Lock and Quality. It opens a small compose
  form (question + two option fields, an "Add option" button up to six, Create/Cancel)
  reusing the menu's existing popover styling. Creating sends `create-poll` and closes
  the menu.
- **`assets/app.js`** — `signaling.on("poll", (m) => { chat.onPoll(m); controls.notifyChatActivity(); })`,
  and `onJoined` applies `msg.poll` when present. The unread-badge bump matters: a poll
  opened while the chat panel is closed would otherwise go unnoticed.
- **`style.css`** — `.poll-card`, `.poll-option`, `.poll-bar`, `.poll-mine`,
  `.poll-closed`, following the existing chat/controls custom properties.

Create and close also emit a moderation-feed line via the existing `Moderation` message
(`Actor` = the op, `Action` = `poll-open` / `poll-close`), so the log narrates them the
way it narrates lock/kick/quality. `moderationText` in `chat.js` gains the two matching
cases — "alice started a poll", "alice closed a poll". Without them the function's
default branch would render the raw action ("alice poll-open").

## Testing

**`internal/room/poll_test.go`** (new), at the density of `countdown_test.go`:

- a non-op cannot create or close a poll
- creating replaces the previous poll and resets its tallies
- a vote is counted; changing a vote moves the tally without changing the total
- a vote for a stale poll ID is refused
- a vote with an out-of-range choice is refused
- a vote on a closed poll is refused
- **a vote survives a reconnect**: same ref, fresh participant ID, tally unchanged and
  `YourVote` restored
- **two participants with an empty ref never share a vote bucket** (the analogue of
  `TestEmptyRefNeverInheritsOp`)
- the join snapshot carries the active poll, and `YourVote` is nil for a non-voter
- validation: question too long, 1 option, 7 options, blank option
- a second poll's ID differs from the first's, so a vote held against the old ID is
  refused after a replacement

**`internal/signal/messages_test.go`** — round-trip the three new client types and
`PollEvent`, matching the existing table.

**`internal/server/dispatch_test.go`** — op gating for `create-poll`/`close-poll`, and
that a refused vote produces no `error` frame.

**`internal/web/test/poll.test.js`** (new) — `tallyPercents`: no votes, a single vote,
an exact three-way tie (33/33/34, summing to 100), rounding that would otherwise sum to
99 or 101, and a tally array of all zeros.

Everything runs under `go test -race ./...` and `node --test internal/web/test/*.test.js`.

**Manual** (the part tests cannot cover): two browsers, one op — open a poll, vote from
both, watch both bars update live; change a vote; close it and confirm both freeze;
join a third browser mid-poll and confirm the card and tallies appear; reload a voter
and confirm their selection comes back.

## Out of scope

- Multiple concurrent polls.
- Attributed votes (showing who voted for what).
- Poll history or results surviving the room — needs a storage layer the app does not
  have.
- Auto-closing timers, quorum rules, ranked choice, or multi-select answers.
- Polls over the IRC side (`m_webrtc_chat`); this is entirely a call-surface feature.
